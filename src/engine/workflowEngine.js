const { log } = require("../infra/logger");
const {
  sendWhatsAppText,
  sendWhatsAppButtons,
  sendWhatsAppList,
  sendFeedbackRatingList,
  sendWhatsAppImage,
  isReplyCaptureActive,
  beginReplyCapture,
  peekReplyCapture,
  endReplyCapture,
} = require("../infra/whatsapp");
const { classifyBusiness, couldBeADifferentBusiness } = require("../ai/classify");
const { loadSessions, saveSession, deleteSession, mapKey } = require("../store/sessionStore");
const bookings = require("../store/bookingStore"); // SQLite-backed — see src/db.js
const { SlotTakenError, DateRangeConflictError } = bookings;
const { dateOptions, timeSlotsFor, parseFlexibleDate, isoDate, parseIsoDate, formatLongDate, labelToMinutes } = require("./dateSlots");
const { extractContext } = require("../ai/extractContext");
const { isRateLimited, shouldNotifyRateLimit } = require("../infra/rateLimit");
const { recordResponseTime } = require("../infra/perf");
const { isDayBlocked, blockedRangesForDay } = require("../store/availabilityStore");
const { tryAnswerFactually, tryAnswerAboutBooking, buildKnowledgeBase } = require("../ai/factualQA");
const { planNextAction, ACTIONS } = require("../ai/orchestrator");
const { detectGeneralIntent, INTENTS, isExplicitComplaint, isBotIdentityQuestion, isPriceObjection, isPlainAcknowledgment, GREETING_RE, keywordIntent } = require("../ai/intentDetector");
const { groqChatCompletion, GROQ_MODEL } = require("../ai/groqClient");
const { translateText, LANG_CODE_MAP } = require("../ai/translate");
const supportRequests = require("../store/supportRequestStore");
const billing = require("./billing");
const { computeQueuePosition, isOptedOutOfAlerts, setAlertsOptedOut } = require("../store/queueStore");
const feedbackStore = require("../store/feedbackStore");
const paymentStore = require("../store/paymentStore");
const razorpay = require("../infra/paymentProviders/razorpayProvider");
const { refundIfPaid } = require("./paymentRefunds");
const { syncBookingCreated, syncBookingCancelled } = require("./calendarSync");
const dashboardEvents = require("../infra/dashboardEvents");
const { isTerminal } = require("./bookingStateMachine");

// One state machine per WhatsApp sender. This is intentionally generic —
// it has no idea what "medical" or "hotel" mean. It only knows how to walk
// a workflow's `steps` array, which is why adding a new business is a
// config change, not a code change. Sessions are persisted to disk after
// every message so a server restart doesn't drop in-progress bookings.
// Bookings (the data that needs real double-booking protection) live in
// SQLite instead — see src/bookingStore.js.
// Populated by initSessions() (below), awaited once at process startup —
// server.js/marketingServer.js's own bootstrap() calls it before mounting
// any route, since Postgres (unlike node:sqlite) makes the initial load
// itself async. Starts as an empty Map rather than undefined so any code
// that happens to run before initSessions() resolves fails loudly (an
// empty session set, not a crash on `undefined.has`) rather than in a way
// that's confusing to trace back to a missing await somewhere in startup.
let sessions = new Map();
async function initSessions() {
  sessions = await loadSessions();
}

// Persists exactly one customer's session (Section 5.2) — the in-memory
// `sessions` Map is still the source of truth during a single process's
// lifetime (unchanged), but what hits disk after each message is now one
// row, not the whole Map. Checking sessions.has(key) here (rather than
// at every individual sessions.delete() call site scattered through this
// file — restart, cancel, booking completion, orchestrator cancel...) is
// what makes a deletion anywhere in the handler correctly propagate to
// storage without having to remember to call deleteSession() at each one.
//
// Section 8 — keyed by (tenantId, waId), not waId alone: the same real
// phone number can have an independent in-progress conversation with two
// different tenants (each with their own WhatsApp number), and those must
// never share or clobber one session.
async function persist(tenantId, waId) {
  const key = mapKey(tenantId, waId);
  if (sessions.has(key)) {
    await saveSession(tenantId, waId, sessions.get(key));
  } else {
    await deleteSession(tenantId, waId);
  }
}

function getSession(tenantId, waId) {
  const key = mapKey(tenantId, waId);
  if (!sessions.has(key)) {
    sessions.set(key, {
      stage: "DETECTING", // DETECTING -> RUNNING -> (reset)
      workflowId: null,
      stepIndex: 0,
      selectedProvider: null,
      selectedHotel: null,
      data: {},
      awaitingBusinessPick: false,
      subStage: null,
      supportAttempts: 0,
      history: [], // recent {text, reply} turns — Section 1.5, capped in recordHistoryTurn()
    });
  }
  const session = sessions.get(key);
  if (!session.history) session.history = []; // sessions persisted before this field existed
  return session;
}

const MAX_HISTORY_TURNS = 5;

// Appends one {customer said, bot replied} turn and caps the list —
// unbounded history would both bloat every persisted session.json entry
// forever and, more importantly, keep growing the prompt every downstream
// AI call includes it in.
function recordHistoryTurn(session, text, reply) {
  if (!reply) return; // nothing worth remembering (e.g. rate-limited, no-op turns)
  session.history.push({ text, reply });
  if (session.history.length > MAX_HISTORY_TURNS) session.history.shift();
}

// Resolves "{field}", "{provider.field}", "{hotel.field}", "{bookingId}",
// "{bookingCode}" and "{businessName}" placeholders. Guards against a
// missing template rather than crashing the whole message handler —
// found live: a workflow without an (optional) providerRowDescription/
// providerListItem string passed `undefined` straight through to here.
function fillTemplate(template, session, workflow) {
  if (!template) return "";
  return template.replace(/\{([\w.]+)\}/g, (match, key) => {
    if (key.startsWith("provider.")) {
      return session.selectedProvider?.[key.slice("provider.".length)] ?? match;
    }
    if (key.startsWith("hotel.")) {
      return session.selectedHotel?.[key.slice("hotel.".length)] ?? match;
    }
    if (key === "bookingId") return session.bookingId ?? match;
    if (key === "bookingCode") return session.bookingCode ?? match;
    if (key === "businessName") return workflow?.businessName ?? match;
    return session.data[key] ?? match;
  });
}

// Found live: a business created with the current admin UI's default
// template has no confirmationTemplate at all (it's only reachable through
// the raw JSON editor, not a structured field) — fillTemplate(undefined,...)
// returns "", and sendWhatsAppText with an empty body gets flatly rejected
// by the Graph API ("text.body is required"), so the booking is created
// but the customer gets no confirmation at all and just sees silence. The
// "Add Business" default template (frontend/src/components/
// WorkflowEditorModal.jsx's BLANK_TEMPLATE) now always includes a real
// confirmationTemplate, but a hand-edited raw-JSON workflow can still omit
// one — this generates a reasonable confirmation from whatever the session
// actually collected, so a booking NEVER finishes in total silence.
function defaultConfirmationMessage(session, workflow) {
  const lines = ["✅ Booking confirmed!", "", `ID: ${session.bookingId}`];
  if (session.selectedProvider) lines.push(`With: ${session.selectedProvider.name}`);
  else if (session.selectedHotel) lines.push(`Hotel: ${session.selectedHotel.name}`);
  if (session.data.visitDateLabel || session.data.checkInDateLabel) {
    lines.push(`Date: ${session.data.visitDateLabel || session.data.checkInDateLabel}`);
  }
  if (session.data.visitTime) lines.push(`Time: ${session.data.visitTime}`);
  if (session.data.customerName) lines.push(`For: ${session.data.customerName}`);
  if (session.selectedProvider?.fee != null) lines.push(`Fee: ₹${session.selectedProvider.fee}`);
  if (session.bookingCode) lines.push(`Booking Code: ${session.bookingCode}`);
  lines.push("", "Reply STATUS anytime to check your booking.");
  return lines.join("\n");
}

function confirmationMessageFor(session, workflow) {
  const base = workflow.confirmationTemplate
    ? fillTemplate(workflow.confirmationTemplate, session, workflow)
    : defaultConfirmationMessage(session, workflow);
  return base + extraFieldsSummary(session);
}

// Renders the selected provider's own extra questions (label: answer)
// as a plain block appended after the business's own template — the
// business's confirmationTemplate/review_confirm template is static text
// written once at business-setup time, so it has no way to reference a
// field a specific provider defined dynamically. Appending, rather than
// requiring every business to hand-write a matching placeholder, is what
// makes a provider's own extra question actually show up without the
// business owner needing to know it exists.
function extraFieldsSummary(session) {
  const extraFields = session.selectedProvider?.extraFields || [];
  const lines = extraFields
    .map((f) => [f.label || f.field, session.data[f.field]])
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => `${label}: ${value}`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

// A confirmation is more useful with a face/place attached — hotels carry
// their photo on `selectedHotel` (the room itself has no separate photo),
// every other workflow carries it directly on `selectedProvider`. Sent as
// a best-effort extra ahead of the text confirmation; a missing photo (most
// providers still don't have one configured) is not an error.
async function sendConfirmationPhoto(tenantId, waId, session, workflow) {
  const photoUrl = session.selectedHotel?.photo || session.selectedProvider?.photo;
  if (!photoUrl) return;
  await sendWhatsAppImage(tenantId, waId, photoUrl);
}

function currentStep(workflow, session) {
  return workflow.steps[session.stepIndex];
}

// Fallback for a provider/room's WhatsApp list row description when the
// workflow doesn't define its own providerRowDescription/providerListItem
// template — built from whatever fields the entity actually has, rather
// than a template string that would show "₹{provider.fee}" literally if a
// field is missing.
function describeEntity(entity) {
  const parts = [];
  if (entity.attribute) parts.push(entity.attribute);
  if (typeof entity.fee === "number") parts.push(`₹${entity.fee}`);
  return parts.join(" · ");
}

// Every other booking made for the same provider/room that's still active —
// this is what prevents two customers double-booking the same doctor's slot
// or the same hotel room.
//
// Scoped by (workflowId, providerId) together, never providerId alone —
// provider ids like "p1" are only unique WITHIN one workflow's JSON file.
// Verified live that matching on providerId alone let booking one doctor
// ("p1" in medical.json) block an unrelated hair stylist's identical time
// slot ("p1" in hair.json, a completely different business) — same bug as
// the DB index below, just on the JS-side matching functions.
async function bookingsForProvider(tenantId, workflowId, providerId) {
  const all = await bookings.values(tenantId);
  return all.filter((b) => b.workflowId === workflowId && b.providerId === providerId && b.status !== "cancelled");
}

async function takenSlotsFor(tenantId, workflowId, providerId, dateIso) {
  const taken = new Set();
  for (const b of await bookingsForProvider(tenantId, workflowId, providerId)) {
    if (b.visitDate === dateIso && b.visitTime) taken.add(b.visitTime);
  }
  return taken;
}

// Item 9 — business-hours awareness. "Today" used to always appear as a
// tappable date option regardless of whether any time slots were actually
// left in it — a customer messaging after closing time (or between the
// last slot and closing) could tap "Today" only to be told "No more slots
// available for that day" one step later, in select_time_slot's own empty
// check. This filters it out up front instead, the same way isDayBlocked
// already does for a fully-blocked day. Deliberately only for a select_date
// step that actually leads into a select_time_slot step (matched by
// dateField, the same link select_time_slot itself uses) — a hotel's
// check-in date has no time-of-day component at all, so applying a
// time-slot emptiness check to it would be checking something that isn't
// what that date field even means.
function dateStepUsesTimeSlots(workflow, dateField) {
  return workflow.steps.some((s) => s.type === "select_time_slot" && s.dateField === dateField);
}

async function filteredDateOptions(tenantId, workflow, session, step) {
  const providerId = session.selectedProvider?.id;
  const usesTimeSlots = dateStepUsesTimeSlots(workflow, step.field);
  const today = isoDate(new Date());
  const options = [];
  for (const o of dateOptions(step.days)) {
    if (await isDayBlocked(tenantId, workflow.id, providerId, o.iso)) continue;
    if (usesTimeSlots && o.iso === today) {
      const excludeSlots = await takenSlotsFor(tenantId, workflow.id, providerId, o.iso);
      const blockedRanges = await blockedRangesForDay(tenantId, workflow.id, providerId, o.iso);
      if (timeSlotsFor(workflow, o.iso, excludeSlots, blockedRanges).length === 0) continue;
    }
    options.push(o);
  }
  return options;
}

// Section 14 — the exact same open-slot computation the conversational
// select_time_slot step uses (see sendStepPrompt/applyStepInput above),
// pulled out so the Public API's GET /api/v1/availability can reuse it
// instead of a second, easily-drifting copy of the same logic.
async function getAvailableSlots(tenantId, workflow, providerId, dateIso) {
  if (await isDayBlocked(tenantId, workflow.id, providerId, dateIso)) return [];
  const excludeSlots = await takenSlotsFor(tenantId, workflow.id, providerId, dateIso);
  const blockedRanges = await blockedRangesForDay(tenantId, workflow.id, providerId, dateIso);
  return timeSlotsFor(workflow, dateIso, excludeSlots, blockedRanges);
}

async function hasDateRangeConflict(tenantId, workflowId, providerId, checkIn, nights) {
  const checkOut = new Date(checkIn.getTime() + nights * 24 * 60 * 60 * 1000);
  for (const b of await bookingsForProvider(tenantId, workflowId, providerId)) {
    if (!b.checkInIso || !b.nights) continue;
    const existingIn = parseIsoDate(b.checkInIso);
    const existingOut = new Date(existingIn.getTime() + b.nights * 24 * 60 * 60 * 1000);
    if (checkIn < existingOut && existingIn < checkOut) return true;
  }
  return false;
}

// WhatsApp interactive lists hard-cap at 10 rows — dateOptions()/
// timeSlotsFor() (dateSlots.js) already enforce this for dates/slots, but
// nothing capped providers/hotels/rooms/options/businesses, all of which
// come straight from a tenant's own (unbounded) dashboard config. Found
// live as a real production risk, not yet a real incident: with 11+ rows
// the Graph API rejects the whole list message outright, postToGraphApi
// just logs an ERROR and returns false with no retry and no fallback text
// (unlike sendWithRetry's proactive sends) — the customer sees the step
// prompt simply never arrive, with no way to proceed at all.
//
// Truncating alone would silently make items 11+ unreachable, which is a
// quieter version of the same problem — so this pairs with matching
// name-lookup added to applyStepInput's select_provider/select_hotel/
// select_room below: a customer whose choice got cut can still reach it
// by typing its name, and the truncation note here tells them that's an
// option rather than leaving them to guess.
const MAX_LIST_ROWS = 10;
// `ownerLabel` is whatever identifies WHOSE list this is for the log line
// — a real tenantId for the business menu, a workflow id for everything
// else (providers/hotels/rooms/options all belong to one business, not
// the tenant as a whole) — not always literally a tenant id, just enough
// context to find the right dashboard/catalog to trim.
function capRows(rows, ownerLabel, context) {
  if (rows.length <= MAX_LIST_ROWS) return { rows, truncated: false };
  log("WARN", `${ownerLabel}: ${context} has ${rows.length} rows — WhatsApp's list limit is ${MAX_LIST_ROWS}, showing the first ${MAX_LIST_ROWS}. Consider trimming the catalog or asking for pagination support.`);
  return { rows: rows.slice(0, MAX_LIST_ROWS), truncated: true };
}
const TRUNCATION_HINT = "\n\n(Showing the first 10 — if you don't see the one you want, just type its name.)";

// Special menu option ids — not real workflow ids, intercepted before the
// normal matchWorkflowByIdOrIndex call in handleDetecting.
const SPECIAL_OPT_AI_CHAT = "__ai_chat";
const SPECIAL_OPT_CALLBACK = "__callback";
const SPECIAL_OPT_VIEW_BOOKING = "__view_booking";
const SPECIAL_OPT_LOCATION = "__location";
const SPECIAL_OPT_LANGUAGE = "__language";
const SPECIAL_OPT_WAITLIST = "__waitlist";
const SPECIAL_OPT_SEND_PHOTO = "__send_photo";

const LOCATION_QUERY_PHRASES = new Set([
  "nearest", "location", "find branch", "nearest branch", "near me", "address", "branch",
  "kahan hai", "kahan h", "pass wale", "aas paas", "aaspas",
]);

// New plan — the same "AI usefulness, not a rigid button menu" pass that
// dropped the Quick Actions section from sendBusinessMenu(). Every one of
// these used to be reachable ONLY by tapping that section's exact button
// (whose id, e.g. "__callback", is still checked below for backward
// compatibility with any in-flight session). Now a customer gets the same
// result just by typing naturally — same whole-message-only discipline
// LOCATION_QUERY_PHRASES/LANGUAGE_QUERY_PHRASES already established above
// (see detectAndSetLanguage's own comment on why substring-anywhere
// matching was a real, already-fixed bug: a customer's genuine text_input
// answer containing one of these words as part of something else must
// never get hijacked into a global action).
// A flat exact-phrase Set (like the others below) missed real variants a
// customer actually typed in testing — "call me back please" isn't
// literally any of "call back"/"call me back"/etc. Upgraded to a bounded
// regex, same shape as intentDetector.js's own CANCEL_RE/STATUS_RE: key
// words allowed a small gap between them (".{0,15}"), not unbounded
// substring-anywhere matching (that's the exact bug class the location/
// language triggers above were already fixed for once — see
// detectAndSetLanguage's comment). Safe to be this generous specifically
// because handleGlobalSpecialActions only ever runs from handleDetecting
// (before/between booking flows), never from handleRunning's mid-step
// answers — see that function's own comment on why.
const CALLBACK_RE = /\b(call\s*back|callback)\b|\b(call|phone)\s*me\b(\s*back)?|\brequest\b.{0,10}\bcallback\b|\bmujhe\b.{0,15}\bcall\b|\bcall\s*(kar\s*do|karo|kardo)\b|\bwapas\s*call\b/i;
const VIEW_BOOKING_QUERY_PHRASES = new Set([
  "my booking", "view my booking", "view booking", "booking details", "check my booking",
  "meri booking", "meri booking dikhao",
]);
const WAITLIST_QUERY_PHRASES = new Set([
  "waitlist", "join waitlist", "wait list", "priority waitlist", "notify me", "notify me when free",
  "waitlist mein daalo", "waitlist join karo",
]);
const AI_CHAT_QUERY_PHRASES = new Set([
  "chat", "chat with ai", "ai chat", "talk to ai", "ai assistant", "ask ai",
  "ai se baat karo", "ai se poochna hai",
]);
const SEND_PHOTO_QUERY_PHRASES = new Set([
  "send photo", "photo", "upload photo", "share photo", "send a photo",
  "photo bhejni hai", "photo bhejta hoon",
]);

// Found live: every quick-action/menu string that needed a non-English
// version was hand-written as a `session.lang === "hi" ? "...hindi..." :
// "...english..."` ternary, scattered across a dozen call sites — and the
// language PICKER lists 9 languages, but the actual reply text only ever
// branched for Hindi specifically. A customer picking Tamil/Urdu/Bengali/
// etc. got exactly one translated confirmation message, then the rest of
// the conversation in English regardless — the feature looked far more
// complete than it was. translate.js's translateText()/LANG_CODE_MAP were
// already fully built for exactly this (same 2-letter codes session.lang
// already uses) but never called from anywhere. This thin wrapper is what
// every one of those call sites now uses instead of a hand-written
// ternary — one real implementation covering all 9 listed languages,
// not a hardcoded special case for one of them. Fails open (returns the
// English text unchanged) if session.lang is unset/"en", GROQ_API_KEY is
// missing, or the Groq call itself fails — same "never blocks the reply"
// guarantee translateText() already documents.
function t(session, text) {
  return translateText(text, session?.lang);
}

// Shown when we genuinely can't tell what the customer wants (a greeting,
// small talk, or anything that doesn't match a business) — the tappable
// list of real services only. The old second section (a fixed "Quick
// Actions" button list — AI chat, callback, view booking, find branch,
// switch language, waitlist) was removed: every one of those is already
// reachable by just typing naturally (handleGlobalSpecialActions below,
// widened to match natural phrasing, not just the old button ids) — a
// customer types "callback" or "waitlist" and gets the same result a tap
// would have. Showing six extra rows next to the real business list read
// as a rigid IVR menu, which undercuts the "AI assistant" positioning the
// bot is actually going for; the prompt text below now says so directly.
// `greet` is true only when this menu is a direct reply to an actual
// greeting ("hi", "hello", ...) — see handleDetecting's isGreeting branch.
// Every other call site (RESTART, the "I don't have an answer for that"
// fallback, etc.) leaves it false: the menu itself is still the right
// thing to show there, but prefacing it with "Hi there! 👋" every time
// would read as the bot re-introducing itself mid-conversation. Found
// live (testing pass): before this, even a literal "Hi" got no
// acknowledgment at all — the customer's first message was answered with
// pure business logic ("What would you like to book today?"), never
// actually greeted back.
async function sendBusinessMenu(tenantId, waId, workflows, session, greet = false) {
  const isHindi = session?.lang === "hi";

  const greeting = greet ? (isHindi ? "नमस्ते! 👋 " : "Hi there! 👋 ") : "";
  const promptText = greeting + (isHindi
    ? "आज आप क्या बुक करना चाहेंगे? नीचे से चुनें, या मुझे बस बताएं — जैसे 'मेरी बुकिंग', 'कॉल बैक चाहिए', या कोई सवाल।"
    : "What would you like to book today? Choose below, or just tell me what you need — e.g. \"my booking\", \"call me back\", or ask me anything.");
  const chooseTitle = isHindi ? "चुनें" : "Choose";
  const servicesTitle = isHindi ? "🏥 सेवाएं (Services)" : "🏥 Booking Services";

  const serviceRows = Object.values(workflows).map((w) => ({
    id: w.id,
    title: w.label,
    description: w.description,
  }));
  const cappedServiceRows = serviceRows.slice(0, MAX_LIST_ROWS);

  const sections = [{ title: servicesTitle, rows: cappedServiceRows }];

  await sendWhatsAppList(tenantId, waId, promptText, chooseTitle, sections);
}


// ---------------------------------------------------------------------------
// AI Chat handler — responds conversationally using Groq. Falls back to a
// friendly apology when no GROQ_API_KEY is configured.
// ---------------------------------------------------------------------------
async function handleAiChat(tenantId, waId, trimmed, session, workflows) {
  if (!process.env.GROQ_API_KEY) {
    await sendWhatsAppText(
      tenantId, waId,
      "That's not available right now. " +
      "Please choose a service from the menu, or reply RESTART to start over."
    );
    return;
  }

  // Build a knowledge base so the AI can answer business-specific questions.
  let knowledgeBase = "";
  try {
    knowledgeBase = await buildKnowledgeBase(tenantId, workflows);
  } catch (_) { /* best-effort */ }

  const historyBlock = (session.history || []).length
    ? `\n\nRECENT CONVERSATION (most recent last):\n${session.history.map((h) => `Customer: ${h.text}\nBot: ${h.reply}`).join("\n")
    }`
    : "";

  try {
    const { data, elapsedMs } = await groqChatCompletion({
      model: GROQ_MODEL,
      temperature: 0.7,
      max_tokens: 250,
      messages: [
        {
          role: "system",
          content:
            "You are a friendly AI assistant for a booking platform. " +
            "Answer the customer's question helpfully and concisely (2-3 sentences max). " +
            "If they want to BOOK something, tell them to reply RESTART and choose a service. " +
            (knowledgeBase
              ? `Here is information about the available services:\n\n${knowledgeBase}`
              : "No specific business data is available; answer generally.") +
            historyBlock,
        },
        { role: "user", content: trimmed },
      ],
    });
    log("INFO", `AI Chat Groq call took ${elapsedMs}ms`);
    const reply = (data.choices?.[0]?.message?.content || "").trim();
    await sendWhatsAppText(tenantId, waId, reply || "I'm not sure about that — try asking in a different way, or reply RESTART to go back to the menu.");
  } catch (err) {
    log("ERROR", `AI Chat Groq call failed for tenant=${tenantId} waId=${waId}: ${err.message}\n${err.stack || ""}`);
    await sendWhatsAppText(
      tenantId, waId,
      "Sorry, we couldn't process that just now. Please try again in a moment, or reply RESTART to choose a service."
    );
  }
  // Keep session in AI-chat sub-mode so follow-up messages stay here.
  session.subStage = "AI_CHAT";
}

// ---------------------------------------------------------------------------
// 1. AI View My Booking — Intelligent personalized booking summary & tips
// ---------------------------------------------------------------------------
async function handleAiViewBooking(tenantId, waId, session, workflows) {
  const activeBooking = await bookings.activeForCustomer(tenantId, waId);

  if (!activeBooking) {
    const msg = await t(session, "📅 You don't have any active booking right now. Reply RESTART to choose a service and make a new booking!");
    await sendWhatsAppText(tenantId, waId, msg);
    return;
  }

  const queueAhead = await computeQueuePosition(activeBooking);
  const queueInfo = queueAhead !== null ? `Queue position: ${queueAhead} people ahead` : "Scheduled appointment";
  const details = [
    `Booking ID: ${activeBooking.bookingId}`,
    `Status: ${activeBooking.status}`,
    activeBooking.providerName ? `Provider/Doctor: ${activeBooking.providerName}` : null,
    activeBooking.visitDateLabel ? `Date: ${activeBooking.visitDateLabel}` : null,
    activeBooking.visitTime ? `Time: ${activeBooking.visitTime}` : null,
    queueInfo,
  ].filter(Boolean).join("\n");

  if (!process.env.GROQ_API_KEY) {
    await sendWhatsAppText(tenantId, waId, `📅 *Your Booking Details*\n\n${details}`);
    return;
  }

  try {
    // Found live: this only ever checked for "hi" specifically, defaulting
    // EVERY other selected language (Tamil, Urdu, Bengali, Telugu,
    // Marathi, Punjabi...) straight to English — same gap as the
    // hardcoded ternaries, just here it's picking the GENERATION language
    // for a live Groq call rather than a fixed string. LANG_CODE_MAP
    // (translate.js) already has the full name for all 9 languages the
    // picker actually lists.
    const targetLang = LANG_CODE_MAP[session.lang] || "English";
    const { data } = await groqChatCompletion({
      model: GROQ_MODEL,
      temperature: 0.3,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: `Summarize the booking details concisely in ${targetLang} with a warm, helpful tone and 1 short preparation tip for the visit.`,
        },
        { role: "user", content: details },
      ],
    });
    const summary = (data.choices?.[0]?.message?.content || "").trim();
    await sendWhatsAppText(tenantId, waId, summary || `📅 *Your Booking Details*\n\n${details}`);
  } catch (err) {
    await sendWhatsAppText(tenantId, waId, `📅 *Your Booking Details*\n\n${details}`);
  }
}

// ---------------------------------------------------------------------------
// 2. AI Find Nearest Branch — AI location matcher
// ---------------------------------------------------------------------------
async function handleAiLocationLookup(tenantId, waId, trimmed, session, workflows) {
  const branchList = [];
  for (const w of Object.values(workflows)) {
    if (w.providers) {
      for (const p of w.providers) {
        if (p.address || p.name) branchList.push(`${p.name} (${w.label}): ${p.address || "Main Branch"}`);
      }
    }
    if (w.hotels) {
      for (const h of w.hotels) {
        if (h.location || h.name) branchList.push(`${h.name}: ${h.location}`);
      }
    }
  }

  if (branchList.length === 0) {
    await sendWhatsAppText(tenantId, waId, "📍 Our main branch is available online. Reply RESTART to view available services.");
    return;
  }

  if (!process.env.GROQ_API_KEY) {
    await sendWhatsAppText(tenantId, waId, `📍 *Available Locations & Branches*\n\n${branchList.join("\n")}`);
    return;
  }

  try {
    const targetLang = LANG_CODE_MAP[session.lang] || "English"; // same all-9-languages fix as handleAiViewBooking above
    const { data } = await groqChatCompletion({
      model: GROQ_MODEL,
      temperature: 0.2,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: `You are a helpful location assistant. Based on customer input "${trimmed}", recommend the best matching branch from the list in ${targetLang}. List hours and address if known.\n\nBranches:\n${branchList.join("\n")}`,
        },
        { role: "user", content: trimmed },
      ],
    });
    const reply = (data.choices?.[0]?.message?.content || "").trim();
    await sendWhatsAppText(tenantId, waId, reply || `📍 *Available Locations*\n\n${branchList.join("\n")}`);
  } catch {
    await sendWhatsAppText(tenantId, waId, `📍 *Available Locations*\n\n${branchList.join("\n")}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Language Selection — two-step interactive flow
// ---------------------------------------------------------------------------

// Step 1: Show the language picker (WhatsApp list with options).
async function sendLanguagePicker(tenantId, waId, session) {
  const currentLang = session.lang || "en";
  const promptText = currentLang === "hi"
    ? "🌐 कृपया अपनी पसंदीदा भाषा चुनें:"
    : "🌐 Please choose your preferred language:";

  const rows = [
    { id: "__lang_en", title: "🇬🇧 English", description: "Communicate in English" },
    { id: "__lang_hi", title: "🇮🇳 हिंदी (Hindi)", description: "हिंदी में संवाद करें" },
    { id: "__lang_hinglish", title: "🇮🇳 Hinglish", description: "Mix of Hindi + English" },
    { id: "__lang_ur", title: "🇵🇰 اردو (Urdu)", description: "اردو میں بات کریں" },
    { id: "__lang_bn", title: "🇮🇳 বাংলা (Bengali)", description: "বাংলায় কথা বলুন" },
    { id: "__lang_ta", title: "🇮🇳 தமிழ் (Tamil)", description: "தமிழில் பேசுங்கள்" },
    { id: "__lang_te", title: "🇮🇳 తెలుగు (Telugu)", description: "తెలుగులో మాట్లాడండి" },
    { id: "__lang_mr", title: "🇮🇳 मराठी (Marathi)", description: "मराठीत बोला" },
    { id: "__lang_pa", title: "🇮🇳 ਪੰਜਾਬੀ (Punjabi)", description: "ਪੰਜਾਬੀ ਵਿੱਚ ਗੱਲ ਕਰੋ" },
  ];

  const sections = [{ title: "Available Languages", rows }];
  await sendWhatsAppList(tenantId, waId, promptText, "Select", sections);
  session.subStage = "AWAITING_LANGUAGE_PICK";
}

// Step 2: Detect explicit language name or __lang_xx button id.
const LANGUAGE_QUERY_PHRASES = new Set([
  "language", "lang", "change language", "switch language", "bhasha", "bhasha badlo",
  "dusri bhasha", "another language", "kisi aur bhasha",
]);

function detectAndSetLanguage(trimmed, session) {
  const lc = trimmed.toLowerCase();

  const langButtonMatch = lc.match(/^__lang_(\w+)$/);
  if (langButtonMatch) {
    const code = langButtonMatch[1] === "hinglish" ? "hi" : langButtonMatch[1];
    session.lang = code;
    return code;
  }

  if (/\b(hindi|hindi\s*me|hindi\s*mein)\b/i.test(lc)) { session.lang = "hi"; return "hi"; }
  if (/\b(hinglish)\b/i.test(lc)) { session.lang = "hi"; return "hi"; }
  if (/\b(urdu|urdu\s*me|urdu\s*mein)\b/i.test(lc)) { session.lang = "ur"; return "ur"; }
  if (/\b(english|english\s*me|english\s*mein|angrezi)\b/i.test(lc)) { session.lang = "en"; return "en"; }
  if (/\b(bengali|bangla)\b/i.test(lc)) { session.lang = "bn"; return "bn"; }
  if (/\b(tamil)\b/i.test(lc)) { session.lang = "ta"; return "ta"; }
  if (/\b(telugu)\b/i.test(lc)) { session.lang = "te"; return "te"; }
  if (/\b(marathi)\b/i.test(lc)) { session.lang = "mr"; return "mr"; }
  if (/\b(punjabi|panjabi)\b/i.test(lc)) { session.lang = "pa"; return "pa"; }

  // Found live: this used to be a substring-anywhere regex including bare
  // generic words like "lang" and phrases like "kisi aur" ("someone
  // else") — both common enough to show up inside a completely unrelated
  // message ("book kisi aur din" = "book on some other day") and wrongly
  // hijack it into showing the language picker instead of whatever the
  // customer actually meant. Whole-message match only — these are meant
  // to catch a customer's OWN request to change language, not any message
  // that happens to contain one of these words.
  if (LANGUAGE_QUERY_PHRASES.has(lc) || lc === SPECIAL_OPT_LANGUAGE) {
    return "SHOW_PICKER";
  }

  return null;
}

async function sendLanguageSwitchConfirmation(tenantId, waId, session) {
  const lang = session.lang || "en";
  const messages = {
    hi: "🌐 *भाषा बदल दी गई है: हिंदी*\n\nनमस्ते! अब मैं आपसे हिंदी में संवाद करूँगा। मुख्य मेनू पर जाने के लिए RESTART लिखें।",
    ur: "🌐 *زبان تبدیل کر دی گئی ہے: اردو*\n\nہیلو! اب میں آپ سے اردو میں بات کروں گا۔ مین مینو کے لیے RESTART لکھیں۔",
    bn: "🌐 *ভাষা পরিবর্তন করা হয়েছে: বাংলা*\n\nহ্যালো! আমি এখন আপনার সাথে বাংলায় কথা বলব। মূল মেনুর জন্য RESTART লিখুন।",
    ta: "🌐 *மொழி மாற்றப்பட்டது: தமிழ்*\n\nவணக்கம்! முதன்மை மெனுவிற்கு RESTART என தட்டச்சு செய்யவும்.",
    te: "🌐 *భాష మార్చబడింది: తెలుగు*\n\nనమస్కారం! ప్రధాన మెనూ కోసం RESTART అని టైప్ చేయండి.",
    mr: "🌐 *भाषा बदलली आहे: मराठी*\n\nनमस्कार! मुख्य मेनूसाठी RESTART टाइप करा.",
    pa: "🌐 *ਭਾਸ਼ਾ ਬਦਲੀ ਗਈ: ਪੰਜਾਬੀ*\n\nਸਤਿ ਸ਼੍ਰੀ ਅਕਾਲ! ਮੁੱਖ ਮੇਨੂ ਲਈ RESTART ਲਿਖੋ।",
    en: "🌐 *Language Switched to English*\n\nHello! I will now communicate in English. Reply RESTART anytime for the main menu.",
  };
  const msg = messages[lang] || messages.en;
  await sendWhatsAppText(tenantId, waId, msg);
}

async function handleLanguageToggle(tenantId, waId, session) {
  await sendLanguagePicker(tenantId, waId, session);
}

// ---------------------------------------------------------------------------
// 4. AI Join Waitlist & Smart Time Recommender
// ---------------------------------------------------------------------------
async function handleAiWaitlist(tenantId, waId, trimmed, session, workflows) {
  const activeBooking = await bookings.activeForCustomer(tenantId, waId);
  const workflowId = activeBooking?.workflowId || session.workflowId || Object.keys(workflows)[0] || null;

  await supportRequests.create(tenantId, waId, workflowId, `Waitlist Request: ${trimmed}`);
  dashboardEvents.publish(tenantId, "support_request.created", { workflowId, waId, message: "Waitlist entry added" });

  // Found live: this promised "we will notify you immediately if a slot
  // opens up" — nothing in this codebase actually watches for a slot
  // freeing up and notifies a waitlisted customer; this just files a
  // support_requests row the same way a callback request does, for a
  // human to act on. That's a real, working escalation path, but the old
  // copy claimed an automatic capability that doesn't exist — a customer
  // who takes "immediately" literally and never hears back has no way to
  // know the bot overpromised. Worded to match what actually happens.
  const msg = await t(session, "⏳ *Added to the waitlist!*\n\nWe've noted your interest — our team will follow up if a slot becomes available.");
  await sendWhatsAppText(tenantId, waId, msg);
}

// ---------------------------------------------------------------------------
// 5. AI Send Photo — Image media reference handler
// ---------------------------------------------------------------------------
// Found live: webhook.js's text extraction never reads message.image, so
// a real WhatsApp photo attachment never reaches handleIncomingMessage at
// all (text ends up "", nothing is called) — this can only ever work for
// a pasted image URL, never a native camera/gallery upload, despite the
// menu calling it "Send Photo." Worse, the old version treated ANY reply
// while awaiting a photo — including "never mind" or an actual (silently
// dropped) photo attachment — as a successfully received photo. Properly
// wiring up real attachment capture would mean downloading the media via
// the same Graph API flow voice notes already use and threading a new
// parameter through handleIncomingMessage's whole call chain (webhook.js,
// /api/simulate-whatsapp, /api/demo/chat) — real, separate scope, not a
// quiet addition here. Until then, this is honest about what it actually
// does: accepts a pasted image URL, and tells the customer plainly when
// what they sent isn't one, rather than pretending to have captured it.
const IMAGE_URL_RE = /https?:\/\/\S*\.(?:png|jpe?g|webp)(?:\?\S*)?$/i;

async function handleAiPhotoUpload(tenantId, waId, trimmed, session, workflows) {
  if (session.subStage === "AWAITING_PHOTO") {
    if (IMAGE_URL_RE.test(trimmed.trim())) {
      session.photoUrl = trimmed.trim();
      session.subStage = null;
      const msg = await t(session, "📸 *Photo link received!*\n\nYour reference photo has been linked to your session. Our provider will review it during your appointment!");
      await sendWhatsAppText(tenantId, waId, msg);
      return;
    }
    // Not a link — including a real photo attachment, which this bot
    // can't read yet. Don't claim to have received anything; say so and
    // give them a way out.
    const retry = await t(session, "I can only accept a photo as a link right now (not a direct upload) — paste an image URL, or reply SKIP to continue without one.");
    if (/^skip$/i.test(trimmed.trim())) {
      session.subStage = null;
      const skipMsg = await t(session, "No problem — continuing without a reference photo.");
      await sendWhatsAppText(tenantId, waId, skipMsg);
      return;
    }
    await sendWhatsAppText(tenantId, waId, retry);
    return;
  }

  session.subStage = "AWAITING_PHOTO";
  const promptMsg = await t(session, "📸 Please share a photo link for reference (e.g. hairstyle preference, skin concern, or vehicle issue) — or reply SKIP to continue without one:");
  await sendWhatsAppText(tenantId, waId, promptMsg);
}

// Found live: `parseInt(text, 10)` on a free-text reply silently succeeds
// on any leading digit, not just a clean menu number — a customer typing
// "3:00 pm" (meaning the TIME, not "pick item 3") parsed as index 3, which
// silently resolved to whatever the 3rd row happened to be ("10:00 am") —
// no error, no rejection, just a booking for the wrong time with nothing
// to signal it. `parseInt("13th", 10)` on a typed date, or a provider name
// that happens to start with a digit, are the same class of misfire.
// Every "reply with a number to pick from the list" fallback in this file
// needs the reply to be PURELY a number (optionally surrounded by
// whitespace) before treating it as an index at all — anything else falls
// through to name/id matching or a genuine "didn't understand" instead of
// silently guessing.
function parseListIndex(text) {
  const trimmed = (text || "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return n > 0 ? n : null;
}

function matchWorkflowByIdOrIndex(text, workflows) {
  const ids = Object.keys(workflows);
  const byId = workflows[text];
  const index = parseListIndex(text);
  const byIndex = index ? workflows[ids[index - 1]] : undefined;
  return byId || byIndex || null;
}

// `preamble` (optional) is folded into the message body rather than sent
// as its own separate message beforehand — see beginWorkflow()'s comment
// for why.
async function sendConfirmProviderCard(tenantId, waId, workflow, step, session, preamble = "") {
  const body = (preamble ? `${preamble}\n\n` : "") + fillTemplate(step.confirmTemplate, session, workflow);
  await sendWhatsAppButtons(tenantId, waId, body, [
    { id: "continue", title: "✅ Continue" },
    { id: "choose_another", title: "🔁 Choose Another" },
  ]);
}

// Sends the prompt for a step as a tappable WhatsApp UI element where
// possible, falling back to plain text for free-text fields. `preamble`
// (optional) is prepended to the body instead of being sent as a separate
// message — see beginWorkflow()'s comment for why.
async function sendStepPrompt(tenantId, waId, workflow, step, session, preamble = "") {
  const prompt = (preamble ? `${preamble}\n\n` : "") + fillTemplate(step.prompt, session, workflow);

  if (step.type === "select_provider") {
    const { rows, truncated } = capRows(
      workflow.providers.map((p) => ({
        id: p.id,
        title: p.name,
        description: workflow.providerRowDescription || workflow.providerListItem
          ? fillTemplate(workflow.providerRowDescription || workflow.providerListItem, { data: {}, selectedProvider: p })
          : describeEntity(p),
      })),
      `business "${workflow.id}"`,
      "select_provider"
    );
    const sections = [{ title: "Options", rows }];
    await sendWhatsAppList(tenantId, waId, await t(session, `${prompt} (Reply "restart" anytime to start over.)${truncated ? TRUNCATION_HINT : ""}`), "Choose", sections);
    return;
  }

  if (step.type === "select_hotel") {
    const { rows, truncated } = capRows(
      workflow.hotels.map((h) => ({
        id: h.id,
        title: h.name,
        description: [h.location, h.rating].filter(Boolean).join(" · "),
      })),
      `business "${workflow.id}"`,
      "select_hotel"
    );
    const sections = [{ title: "Hotels", rows }];
    await sendWhatsAppList(tenantId, waId, await t(session, `${prompt} (Reply "restart" anytime to start over.)${truncated ? TRUNCATION_HINT : ""}`), "Choose", sections);
    return;
  }

  if (step.type === "select_room") {
    const rooms = session.selectedHotel?.rooms || [];
    const { rows, truncated } = capRows(
      rooms.map((r) => ({
        id: r.id,
        title: r.name,
        description: workflow.providerRowDescription || workflow.providerListItem
          ? fillTemplate(workflow.providerRowDescription || workflow.providerListItem, { data: {}, selectedProvider: r })
          : describeEntity(r),
      })),
      `business "${workflow.id}"`,
      "select_room"
    );
    const sections = [{ title: "Rooms", rows }];
    await sendWhatsAppList(tenantId, waId, await t(session, `${prompt}${truncated ? TRUNCATION_HINT : ""}`), "Choose", sections);
    return;
  }

  if (step.type === "select_option") {
    if (step.options.length <= 3) {
      await sendWhatsAppButtons(tenantId, waId,
        await t(session, prompt),
        step.options.map((o) => ({ id: o, title: o }))
      );
    } else {
      const { rows, truncated } = capRows(step.options.map((o) => ({ id: o, title: o })), `business "${workflow.id}"`, "select_option");
      const sections = [{ title: "Options", rows }];
      await sendWhatsAppList(tenantId, waId, await t(session, `${prompt}${truncated ? TRUNCATION_HINT : ""}`), "Choose", sections);
    }
    return;
  }

  if (step.type === "select_date") {
    const options = await filteredDateOptions(tenantId, workflow, session, step);
    const sections = [{ title: "Dates", rows: options.map((o) => ({ id: o.id, title: o.title })) }];
    await sendWhatsAppList(tenantId, waId, await t(session, prompt), "Choose", sections);
    return;
  }

  if (step.type === "select_time_slot") {
    const dateIso = session.data[`${step.dateField}Iso`];
    const excludeSlots = await takenSlotsFor(tenantId, workflow.id, session.selectedProvider?.id, dateIso);
    const blockedRanges = await blockedRangesForDay(tenantId, workflow.id, session.selectedProvider?.id, dateIso);
    const slots = timeSlotsFor(workflow, session.data[step.dateField], excludeSlots, blockedRanges);
    if (slots.length === 0) {
      await sendWhatsAppText(tenantId, waId, await t(session, "No more slots available for that day. Reply \"restart\" to try a different date."));
      return;
    }
    const sections = [{ title: "Available Slots", rows: slots.map((s) => ({ id: s, title: s })) }];
    await sendWhatsAppList(tenantId, waId, await t(session, prompt), "Choose", sections);
    return;
  }

  if (step.type === "review_confirm") {
    const body = `${prompt}\n\n${fillTemplate(step.template, session, workflow)}${extraFieldsSummary(session)}`;
    await sendWhatsAppButtons(tenantId, waId, await t(session, body), [
      { id: "confirm", title: "✅ Confirm" },
      { id: "edit", title: "✏️ Edit Details" },
      { id: "cancel", title: "❌ Cancel" },
    ]);
    return;
  }

  // text_input
  await sendWhatsAppText(tenantId, waId, await t(session, prompt));
}

// Processes the user's reply to the *current* step. Accepts either a tapped
// button/list id (real WhatsApp) or plain text/number (curl testing via
// /api/simulate-whatsapp). Returns an error string to re-prompt on, or null
// if the input was accepted and the session should advance.
// A row past MAX_LIST_ROWS in a truncated list can't be tapped — matching
// by id/index alone would make it permanently unreachable. Tries an exact
// case-insensitive name match first; if that misses, a substring match is
// only trusted when it's unambiguous (matches exactly one entry) — same
// "don't guess when it's genuinely unclear" discipline nameIsGroundedInText
// already applies elsewhere, rather than silently picking the first
// partial match and risking the wrong provider/hotel/room.
function findByName(entries, text, nameOf) {
  const q = text.trim().toLowerCase();
  if (!q) return null;
  const exact = entries.find((e) => nameOf(e).toLowerCase() === q);
  if (exact) return exact;
  const partial = entries.filter((e) => nameOf(e).toLowerCase().includes(q));
  return partial.length === 1 ? partial[0] : null;
}

async function applyStepInput(tenantId, workflow, step, session, text) {
  if (step.type === "select_provider") {
    const byId = workflow.providers.find((p) => p.id === text);
    const index = parseListIndex(text);
    const byIndex = index ? workflow.providers[index - 1] : undefined;
    const byName = findByName(workflow.providers, text, (p) => p.name);
    const provider = byId || byIndex || byName;
    if (!provider) return "Sorry, I didn't recognize that provider — please tap one from the list, or type their name.";
    session.selectedProvider = provider;
    session.extraFieldIndex = 0; // this provider's own extra questions (if any) start over — see maybeAskNextExtraField
    return null;
  }

  if (step.type === "select_hotel") {
    const byId = workflow.hotels.find((h) => h.id === text);
    const index = parseListIndex(text);
    const byIndex = index ? workflow.hotels[index - 1] : undefined;
    const byName = findByName(workflow.hotels, text, (h) => h.name);
    const hotel = byId || byIndex || byName;
    if (!hotel) return "Sorry, I didn't recognize that hotel — please tap one from the list, or type its name.";
    session.selectedHotel = hotel;
    return null;
  }

  if (step.type === "select_room") {
    const rooms = session.selectedHotel?.rooms || [];
    const byId = rooms.find((r) => r.id === text);
    const index = parseListIndex(text);
    const byIndex = index ? rooms[index - 1] : undefined;
    const byName = findByName(rooms, text, (r) => r.name);
    const room = byId || byIndex || byName;
    if (!room) return "Sorry, I didn't recognize that room — please tap one from the list, or type its name.";
    session.selectedProvider = room; // rooms reuse the same "provider" concept for templates/records
    session.extraFieldIndex = 0;
    return null;
  }

  if (step.type === "select_option") {
    if (step.skippable && /^(skip|none|na|n\/a|prefer not to say)$/i.test(text.trim())) {
      session.data[step.field] = "Not specified";
      return null;
    }
    const match = step.options.find((o) => o === text || o.toLowerCase() === text.toLowerCase());
    if (!match) return "Sorry, that's not one of the options — please tap one from the list.";
    session.data[step.field] = match;
    return null;
  }

  if (step.type === "select_date") {
    // Must filter identically to sendStepPrompt (filteredDateOptions is the
    // shared source of truth for both) — otherwise a numeric reply ("3")
    // indexes into a different, unfiltered list than what was actually
    // shown, silently picking the wrong day.
    const options = await filteredDateOptions(tenantId, workflow, session, step);
    const byIdOrTitle = options.find((o) => o.id === text.toLowerCase() || o.title.toLowerCase() === text.toLowerCase());
    const dateIndex = parseListIndex(text);
    const byIndex = dateIndex ? options[dateIndex - 1] : undefined;
    const match = byIdOrTitle || byIndex;
    if (!match) return "Sorry, I didn't recognize that date — please tap one from the list.";
    session.data[step.field] = match.id;
    session.data[`${step.field}Label`] = match.label;
    session.data[`${step.field}Iso`] = match.iso;
    return null;
  }

  if (step.type === "select_time_slot") {
    const dateIso = session.data[`${step.dateField}Iso`];
    const excludeSlots = await takenSlotsFor(tenantId, workflow.id, session.selectedProvider?.id, dateIso);
    const blockedRanges = await blockedRangesForDay(tenantId, workflow.id, session.selectedProvider?.id, dateIso);
    const slots = timeSlotsFor(workflow, session.data[step.dateField], excludeSlots, blockedRanges);
    const byText = slots.find((s) => s.toLowerCase() === text.toLowerCase());
    const slotIndex = parseListIndex(text);
    const byIndex = slotIndex ? slots[slotIndex - 1] : undefined;
    const match = byText || byIndex;
    if (!match) return "Sorry, that slot isn't available — someone may have just taken it.";
    session.data[step.field] = match;
    return null;
  }

  // text_input — validated individually per field, asked one at a time,
  // rather than parsed out of one combined free-text message.
  const value = text.trim();
  if (step.validate === "number") {
    // step.min/step.max let a workflow tighten the range (e.g. nights: 1-30);
    // 1-120 is the sane default (verified live: "0" was silently accepted
    // as an age before this range check existed).
    const min = step.min ?? 1;
    const max = step.max ?? 120;
    const num = Number(value);
    if (!/^\d{1,3}$/.test(value) || num < min || num > max) {
      return step.validationError || `Please enter a valid number between ${min} and ${max}.`;
    }
    session.data[step.field] = value;
    return null;
  }
  if (step.validate === "required" && !value) {
    return step.validationError || "This can't be empty — please provide a value.";
  }
  // Capped, not just trimmed — this value is stored verbatim in the
  // bookings table and later rendered in the dashboard. WhatsApp already
  // limits a single message to ~4096 chars; nothing legitimate (a name, a
  // reason for visit) needs more than this, and capping keeps one giant
  // paste from bloating a DB row indefinitely.
  const MAX_FIELD_LENGTH = 200;
  session.data[step.field] = (value || step.default || "Guest").slice(0, MAX_FIELD_LENGTH);
  return null;
}

// A second, non-AI check on top of the AI's extraction: does the customer's
// ACTUAL message contain something recognizable as this name? Catches model
// hallucination (verified live: a 5000-char garbage string got "TONI & GUY"
// extracted as the provider despite that text appearing nowhere in it) —
// the AI's claim alone is never trusted, only accepted if grounded in what
// was actually typed.
//
// Found live: this used to accept ANY significant word from the name, which
// meant a generic category word baked into a business's own name (e.g.
// "Grand Palace HOTEL") trivially matched a customer who'd typed nothing
// more than the category itself ("hotel") to pick the workflow — "I've
// already noted: Grand Palace Hotel" fired for a customer who never named
// any specific hotel. `genericWords` excludes the workflow's own category
// label, and `sharedWords` excludes any word common to more than one
// candidate in this workflow — neither kind actually distinguishes ONE
// provider from the others, so matching one alone must not count as
// grounding.
function nameIsGroundedInText(originalText, name, { allNames = [], categoryLabel = "" } = {}) {
  const lowerText = originalText.toLowerCase();
  const splitWords = (s) => s.toLowerCase().split(/[\s.&]+/).filter((w) => w.length >= 3);

  const genericWords = new Set(splitWords(categoryLabel));
  const sharedWords = new Set();
  const seenOnce = new Set();
  for (const other of allNames) {
    for (const w of splitWords(other)) {
      if (seenOnce.has(w)) sharedWords.add(w);
      else seenOnce.add(w);
    }
  }

  const words = splitWords(name).filter(
    (w) => !["the", "and"].includes(w) && !genericWords.has(w) && !sharedWords.has(w)
  );
  return words.length > 0 && words.some((w) => lowerText.includes(w));
}

// Tries to satisfy one step directly from what the customer already said in
// their opening message. Returns a short human-readable label for the "got
// it, noted:" recap if it filled the step, or null if it couldn't (the
// caller stops auto-filling at the first step it can't resolve — you can't
// skip ahead to a step that depends on one still unanswered).
function tryAutoFillStep(session, workflow, step, extracted, originalText) {
  if (step.type === "select_provider" && extracted.providerName) {
    const hint = String(extracted.providerName).toLowerCase();
    const match = workflow.providers.find((p) => p.name.toLowerCase() === hint || hint.includes(p.name.toLowerCase()));
    const grounding = { allNames: workflow.providers.map((p) => p.name), categoryLabel: workflow.label };
    if (match && nameIsGroundedInText(originalText, match.name, grounding)) {
      session.selectedProvider = match;
      return match.name;
    }
  }

  if (step.type === "select_hotel" && extracted.providerName) {
    const hint = String(extracted.providerName).toLowerCase();
    const match = workflow.hotels.find((h) => h.name.toLowerCase() === hint || hint.includes(h.name.toLowerCase()));
    const grounding = { allNames: workflow.hotels.map((h) => h.name), categoryLabel: workflow.label };
    if (match && nameIsGroundedInText(originalText, match.name, grounding)) {
      session.selectedHotel = match;
      return match.name;
    }
  }

  if (step.type === "select_date" && extracted.dateHint) {
    const options = dateOptions(step.days);
    const hint = String(extracted.dateHint).toLowerCase();
    let match = options.find((o) => o.title.toLowerCase() === hint || o.id === hint);
    if (!match) {
      const parsed = parseFlexibleDate(extracted.dateHint);
      if (parsed) match = options.find((o) => o.iso === isoDate(parsed));
    }
    if (match) {
      session.data[step.field] = match.id;
      session.data[`${step.field}Label`] = match.label;
      session.data[`${step.field}Iso`] = match.iso;
      return match.label;
    }
  }

  if (step.type === "text_input" && step.field === "checkInDate" && extracted.dateHint) {
    session.data[step.field] = String(extracted.dateHint).trim();
    return `check-in ${extracted.dateHint}`;
  }

  if (step.type === "text_input" && step.field === "customerName" && extracted.customerName) {
    session.data[step.field] = String(extracted.customerName).trim();
    return `name: ${extracted.customerName}`;
  }

  return null;
}

// Walks the workflow's steps from the start, auto-filling whatever the
// opening message already answered. Stops at the first step it can't fill —
// including deliberately stopping AT a select_provider step with
// confirmCard so the confirm card still shows (a quick "did I get this
// right?" beats silently skipping the highest-stakes choice in the flow).
function autoFillFromContext(session, workflow, extracted, originalText) {
  const filled = [];
  while (session.stepIndex < workflow.steps.length) {
    const step = workflow.steps[session.stepIndex];
    if (step.type === "review_confirm") break;

    const label = tryAutoFillStep(session, workflow, step, extracted, originalText);
    if (!label) break;
    filled.push(label);

    if (step.type === "select_provider" && step.confirmCard) {
      session.subStage = "CONFIRM_PROVIDER";
      break;
    }
    session.stepIndex += 1;
  }
  return filled;
}

// Symptom keyword -> specialty substring (matched against provider.attribute,
// case-insensitively). Deliberately NOT the same mechanism as
// autoFillFromContext/tryAutoFillStep — this never selects a provider on
// the customer's behalf, only suggests one alongside the full list, so it
// doesn't need (and shouldn't have) the grounding safety check that
// selection does. A symptom naming no doctor by name literally cannot
// pass that check, by design — that's a feature, not a gap, for a choice
// as consequential as which doctor you see.
const SYMPTOM_TO_SPECIALTY = [
  { re: /\b(fever|bukhar|cough|khansi|cold|jukam|zukam|headache|sar\s*dard|checkup|sick|throat)\b/i, specialty: /general|physician|family/i },
  { re: /\b(skin|rash|acne|itch|khujli)\b/i, specialty: /dermat|skin/i },
  { re: /\b(bone|joint|fracture|back\s*pain|injury|chot|sprain|knee|shoulder)\b/i, specialty: /orthop|bone/i },
  { re: /\b(child|baby|kid|bachcha)\b/i, specialty: /pediatric|child/i },
  { re: /\b(tooth|teeth|dant|dental|gum)\b/i, specialty: /dent/i },
];

// Best-effort, deterministic, no AI call — a keyword miss just means no
// hint gets shown, never a wrong one shown confidently.
function suggestSpecialtyProvider(originalText, workflow) {
  if (!workflow.providers?.length) return null;
  for (const { re, specialty } of SYMPTOM_TO_SPECIALTY) {
    if (!re.test(originalText)) continue;
    const match = workflow.providers.find((p) => p.attribute && specialty.test(p.attribute));
    if (match) return match;
  }
  return null;
}

async function beginWorkflow(tenantId, waId, session, workflowId, workflows, originalText) {
  const workflow = workflows[workflowId];
  session.workflowId = workflowId;
  session.stepIndex = 0;
  session.stage = "RUNNING";
  session.awaitingBusinessPick = false;
  session.subStage = null;
  session.selectedProvider = null;
  session.selectedHotel = null;
  session.data = {};
  session.supportAttempts = 0;
  session.confusionCount = 0; // Item 9 — a successful classification means they're no longer stuck

  // Found live: this used to fire up to 4 separate WhatsApp messages (and
  // push notifications) for what reads, cognitively, as one bot turn —
  // "got it" + "noted" + a specialty suggestion + the actual step prompt.
  // Folded into a single preamble prepended to the step prompt's own body
  // instead (sendStepPrompt/sendConfirmProviderCard both support one) —
  // WhatsApp list/button bodies support multi-line text just fine, so
  // nothing about what's communicated is lost, just how many bubbles it
  // costs the customer to read it.
  const preambleLines = [`Got it! Based on your message, it looks like you need ${workflow.matchLabel}.`];

  const extracted = await extractContext(originalText, workflow);
  const filled = autoFillFromContext(session, workflow, extracted, originalText || "");
  if (filled.length > 0) {
    preambleLines.push(`And I've already noted: ${filled.join(", ")} — no need to repeat that.`);
  }

  const step = currentStep(workflow, session);
  if (session.subStage === "CONFIRM_PROVIDER") {
    await sendConfirmProviderCard(tenantId, waId, workflow, step, session, preambleLines.join("\n\n"));
  } else {
    // Only relevant when the provider is still an open question — if
    // auto-fill (or the confirm-card flow above) already resolved one,
    // showing a competing suggestion here would just be confusing.
    if (step.type === "select_provider" && !session.selectedProvider) {
      const suggestion = suggestSpecialtyProvider(originalText || "", workflow);
      if (suggestion) {
        preambleLines.push(`Based on what you described, ${suggestion.name} (${suggestion.attribute}) might be a good fit — but here are all the options:`);
      }
    }
    await sendStepPrompt(tenantId, waId, workflow, step, session, preambleLines.join("\n\n"));
  }
}

// Section 11 — every booking-state change worth a dashboard tab
// refreshing itself over goes through this one helper, so the payload
// shape (always carrying workflowId/providerId, whatever the event type)
// stays consistent for server.js's SSE route to filter a provider
// session down to just their own events.
function publishBookingEvent(tenantId, type, booking) {
  dashboardEvents.publish(tenantId, type, { workflowId: booking.workflowId, providerId: booking.providerId, booking });
}

function generateBookingId(workflow, session) {
  if (workflow.bookingIdPrefix) {
    const dateIso = session.data.visitDateIso || session.data.checkInDateIso || isoDate(new Date());
    const datePart = dateIso.replace(/-/g, "");
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${workflow.bookingIdPrefix}-${datePart}-${rand}`;
  }
  return `BK-${Date.now()}`;
}

// Section 9.2 — a provider-level requiresPayment/depositAmount/depositType
// overrides the same fields at the workflow level, same precedence
// convention as fee/address (per-provider always wins when set). Returns
// null when payment isn't required, so every call site can just check
// truthiness rather than a separate boolean.
//
// Plan-gated (billing pass, found live): a Starter-plan tenant configuring
// requiresPayment used to work identically to Growth/Enterprise — the
// marketing site's own pricing claims "Payments & deposits" as Growth-only,
// so this makes that real. Degrades the exact same way an unconfigured
// Razorpay key already does (README, Section 9): the booking still
// completes normally, just without collecting a deposit — never blocking
// a real customer over the OPERATOR's plan choice.
async function resolvePaymentRequirement(tenantId, workflow, session) {
  const provider = session.selectedProvider;
  const requiresPayment = provider?.requiresPayment ?? workflow.requiresPayment;
  if (!requiresPayment) return null;
  if (!(await billing.tenantHasFeature(tenantId, "payments"))) return null;

  const depositType = provider?.depositType ?? workflow.depositType ?? "fixed";
  const depositAmountConfig = provider?.depositAmount ?? workflow.depositAmount;
  if (depositAmountConfig === undefined || depositAmountConfig === null) return null; // misconfigured — requiresPayment with no amount means nothing to charge

  const fee = provider?.fee ?? 0;
  const rupees = depositType === "percentage" ? Math.round((fee * depositAmountConfig) / 100) : depositAmountConfig;
  if (!(rupees > 0)) return null;

  return {
    amountPaise: rupees * 100, // Razorpay (and payments.amount) work in paise
    depositType,
    refundPolicy: provider?.refundPolicy ?? workflow.refundPolicy ?? null,
  };
}

// Returns the created booking (needed by the Section 9 payment gate right
// after this call, to attach a payments row to the new booking's real id).
async function recordBooking(tenantId, waId, workflow, session, initialStatus = "booked") {
  // .create() always inserts a new row — a customer's Nth booking never
  // overwrites their (N-1)th (real gap, previously an upsert-by-wa_id).
  return bookings.create(tenantId, waId, {
    bookingId: session.bookingId,
    bookingCode: session.bookingCode,
    workflowId: workflow.id,
    providerId: session.selectedProvider?.id || null,
    providerName: session.selectedProvider?.name || null,
    hotelId: session.selectedHotel?.id || null,
    hotelName: session.selectedHotel?.name || null,
    visitDate: session.data.visitDateIso || null,
    visitDateLabel: session.data.visitDateLabel || null,
    visitTime: session.data.visitTime || null,
    checkInIso: session.data.checkInDateIso || null,
    nights: session.data.nights ? parseInt(session.data.nights, 10) || null : null,
    customerName: session.data.customerName || null,
    age: session.data.age || null,
    gender: session.data.gender || null,
    reason: session.data.reason || null,
    status: initialStatus, // booked | payment_pending | arrived | cancelled
    createdAt: Date.now(),
  });
}

// Re-verifies availability right before finalizing — the offered slot/room
// could have been taken by someone else in the time since it was shown
// (two customers mid-flow at once). Returns true if it rejected the booking
// and re-prompted; the caller should stop in that case.
async function rejectIfSlotUnavailable(tenantId, waId, session, workflow) {
  const slotStep = workflow.steps.find((s) => s.type === "select_time_slot");
  if (!slotStep) return false;

  const dateIso = session.data[`${slotStep.dateField}Iso`];
  const taken = await takenSlotsFor(tenantId, workflow.id, session.selectedProvider?.id, dateIso);
  const blockedRanges = await blockedRangesForDay(tenantId, workflow.id, session.selectedProvider?.id, dateIso);
  const chosenSlot = session.data[slotStep.field];
  const chosenMinutes = labelToMinutes(chosenSlot);
  const isBlocked = chosenMinutes !== null && blockedRanges.some((r) => chosenMinutes >= r.startMin && chosenMinutes < r.endMin);
  if (taken.has(chosenSlot) || isBlocked) {
    session.stepIndex = workflow.steps.indexOf(slotStep);
    await sendWhatsAppText(tenantId, waId, "Sorry, that slot was just taken by someone else. Please pick another time.");
    await sendStepPrompt(tenantId, waId, workflow, slotStep, session);
    return true;
  }
  return false;
}

// Parses/validates the hotel-style check-in date + nights and checks for a
// date-range conflict. Runs as soon as both fields are known (right after
// "nights" is answered), NOT deferred to the final step — a review_confirm
// step downstream needs {checkInDateLabel} already resolved, and bouncing
// the customer back immediately (rather than after they've also typed their
// name) is a better experience anyway. Returns true if it rejected and
// re-prompted; the caller should stop in that case.
async function rejectIfDateRangeInvalid(tenantId, waId, session, workflow) {
  if (!workflow.dateRangeAvailability) return false;

  const { startField, nightsField } = workflow.dateRangeAvailability;
  const startStepIdx = workflow.steps.findIndex((s) => s.field === startField);

  // select_date (a tappable calendar list) already resolves {startField}Iso
  // the moment it's answered — trust that directly rather than re-parsing.
  // Falls back to free-text parsing only for a workflow that still uses a
  // text_input for this field instead.
  const preResolvedIso = session.data[`${startField}Iso`];
  const parsedStart = preResolvedIso ? parseIsoDate(preResolvedIso) : parseFlexibleDate(session.data[startField]);

  if (!parsedStart) {
    session.stepIndex = startStepIdx >= 0 ? startStepIdx : session.stepIndex;
    await sendWhatsAppText(tenantId, waId, 'Sorry, I couldn\'t understand that check-in date. Please try again.');
    await sendStepPrompt(tenantId, waId, workflow, currentStep(workflow, session), session);
    return true;
  }

  const nights = parseInt(session.data[nightsField], 10);
  if (!nights || nights < 1) {
    const nightsStepIdx = workflow.steps.findIndex((s) => s.field === nightsField);
    session.stepIndex = nightsStepIdx >= 0 ? nightsStepIdx : session.stepIndex;
    await sendWhatsAppText(tenantId, waId, "Please enter a valid number of nights.");
    await sendStepPrompt(tenantId, waId, workflow, currentStep(workflow, session), session);
    return true;
  }

  session.data[`${startField}Iso`] = isoDate(parsedStart);
  session.data[`${startField}Label`] = formatLongDate(parsedStart);

  if (await hasDateRangeConflict(tenantId, workflow.id, session.selectedProvider?.id, parsedStart, nights)) {
    session.stepIndex = startStepIdx >= 0 ? startStepIdx : session.stepIndex;
    await sendWhatsAppText(tenantId, waId,
      `Sorry, ${session.selectedProvider?.name || "that room"} is already booked for part of that period. Please choose a different date.`
    );
    await sendStepPrompt(tenantId, waId, workflow, currentStep(workflow, session), session);
    return true;
  }

  return false;
}

// Whether `step` already has a real answer on `session` — true only after
// a GO_TO_STEP rewind re-answers its target and advanceOrFinish walks
// forward again; never true on a normal first pass (see the skipAnsweredSteps
// comment in executeOrchestratedPlan's GO_TO_STEP branch for why that
// distinction matters).
function isStepAlreadyAnswered(step, session) {
  if (step.type === "select_provider" || step.type === "select_room") return !!session.selectedProvider;
  if (step.type === "select_hotel") return !!session.selectedHotel;
  if (step.field) return session.data[step.field] !== undefined;
  return false; // review_confirm (no field) always re-shows
}

async function advanceOrFinish(tenantId, waId, session, workflow) {
  const justAnsweredStep = currentStep(workflow, session);
  session.stepIndex += 1;
  session.subStage = null;

  if (workflow.dateRangeAvailability && justAnsweredStep.field === workflow.dateRangeAvailability.nightsField) {
    if (await rejectIfDateRangeInvalid(tenantId, waId, session, workflow)) return;
  }

  if (session.skipAnsweredSteps) {
    session.skipAnsweredSteps = false; // one-shot — see GO_TO_STEP's own comment
    while (session.stepIndex < workflow.steps.length && isStepAlreadyAnswered(workflow.steps[session.stepIndex], session)) {
      session.stepIndex += 1;
    }
  }

  if (session.stepIndex < workflow.steps.length) {
    const next = currentStep(workflow, session);
    // Provider-level extra questions (see maybeAskNextExtraField's own
    // comment) run right before review_confirm, not after workflow.steps
    // is exhausted — that way the customer sees everything, including
    // their answers to the provider's own questions, on the one review
    // screen, instead of being asked more questions AFTER already
    // reviewing/confirming.
    if (next.type === "review_confirm" && (await maybeAskNextExtraField(tenantId, waId, session, workflow))) return;
    await sendStepPrompt(tenantId, waId, workflow, next, session);
    return;
  }

  await finalizeBooking(tenantId, waId, session, workflow);
}

// A provider can define its own extra questions (session.selectedProvider
// .extraFields) on top of whatever the business's own steps[] already
// ask — e.g. a specific doctor wants "reason for visit" even though the
// clinic's shared template doesn't. Deliberately NOT spliced into
// workflow.steps/session.stepIndex: that array is read by index all over
// this file (GO_TO_STEP, isStepAlreadyAnswered, the SlotTakenError/
// DateRangeConflictError rewinds, the editTarget jump) and every one of
// those would need to agree on a per-session "effective steps" list to
// stay correct — a lot of surface area to get subtly wrong in a flow
// that's already been hardened through real production bugs. Tracking
// progress with its own session.extraFieldIndex, entirely decoupled from
// stepIndex, means none of that existing machinery needs to know these
// exist at all: stepIndex sits pinned at review_confirm's index for the
// whole time extra fields are being asked, so a mid-flow "change the
// doctor"/"actually change the date" GO_TO_STEP jump still lands exactly
// where it always did.
async function maybeAskNextExtraField(tenantId, waId, session, workflow) {
  const extraFields = session.selectedProvider?.extraFields || [];
  const idx = session.extraFieldIndex ?? 0;
  if (idx >= extraFields.length) return false;
  await sendStepPrompt(tenantId, waId, workflow, extraFields[idx], session);
  return true;
}

// Formerly the tail of advanceOrFinish — split out so the extra-fields
// loop above (handleRunning) can reach the exact same booking-creation
// path once a provider's own questions are answered, without duplicating
// slot-conflict handling, payment gating, or confirmation sending.
async function finalizeBooking(tenantId, waId, session, workflow) {
  if (await rejectIfSlotUnavailable(tenantId, waId, session, workflow)) return;

  session.bookingId = generateBookingId(workflow, session);
  session.bookingCode = Math.random().toString(36).slice(2, 6).toUpperCase();

  const paymentRequirement = await resolvePaymentRequirement(tenantId, workflow, session);
  let createdBooking;
  try {
    createdBooking = await recordBooking(tenantId, waId, workflow, session, paymentRequirement ? "payment_pending" : "booked");
  } catch (err) {
    // The DB's own UNIQUE index/trigger is the authoritative check for
    // both booking shapes — it catches a genuine race the JS pre-check
    // (rejectIfSlotUnavailable / rejectIfDateRangeInvalid, both run earlier
    // in the conversation with a real time gap before this point — the
    // customer confirming their name, reviewing the booking, etc.) can miss
    // when two requests land close enough together.
    if (err instanceof SlotTakenError) {
      const slotStep = workflow.steps.find((s) => s.type === "select_time_slot");
      session.stepIndex = slotStep ? workflow.steps.indexOf(slotStep) : session.stepIndex;
      await sendWhatsAppText(tenantId, waId, "Sorry, that slot was just taken by someone else. Please pick another time.");
      if (slotStep) await sendStepPrompt(tenantId, waId, workflow, slotStep, session);
      return;
    }
    if (err instanceof DateRangeConflictError) {
      const startField = workflow.dateRangeAvailability?.startField;
      const startStep = startField ? workflow.steps.find((s) => s.field === startField) : null;
      session.stepIndex = startStep ? workflow.steps.indexOf(startStep) : session.stepIndex;
      await sendWhatsAppText(tenantId, waId,
        `Sorry, ${session.selectedProvider?.name || "that room"} was just booked for part of that period by someone else. Please choose a different date.`
      );
      if (startStep) await sendStepPrompt(tenantId, waId, workflow, startStep, session);
      return;
    }
    throw err;
  }

  log(
    "INFO",
    `Booking confirmed: ${session.bookingId} [${workflow.id}] provider=${session.selectedProvider?.name} data=${JSON.stringify(session.data)}`
  );
  publishBookingEvent(tenantId, "booking.created", createdBooking);

  // Section 9.3 — the actual gate: a booking that requires payment stays
  // `payment_pending` (never `booked`) until a VERIFIED webhook confirms
  // it, not this client-visible send succeeding. The slot itself is
  // already correctly reserved by the DB's UNIQUE index the instant the
  // row above was created (payment_pending isn't 'cancelled', so it still
  // counts as "taken") — exactly what stops a second customer grabbing
  // the same slot while this one's payment is in flight.
  if (paymentRequirement) {
    await sendPaymentRequest(tenantId, waId, workflow, session, createdBooking, paymentRequirement);
  } else {
    await sendConfirmationPhoto(tenantId, waId, session, workflow);
    await sendWhatsAppText(tenantId, waId, confirmationMessageFor(session, workflow));
    // Section 10 — sync happens once the booking is actually `booked`,
    // never at `payment_pending` (a payment that's never completed
    // shouldn't leave a phantom event on the provider's calendar). The
    // payment-gated path syncs from its own two "ends up booked anyway"
    // points below and from the payment webhook (server.js) instead.
    await syncBookingCreated(tenantId, createdBooking, workflow); // internally logs and swallows its own errors — never rejects
  }
  sessions.delete(mapKey(tenantId, waId)); // ready for a fresh requirement next time
}

// Creates the Razorpay payment link and sends it to the customer in place
// of the normal confirmation — the booking already exists (payment_pending)
// so the slot is held, but the customer sees "reserved, pending payment,"
// never "confirmed," until money actually moves.
//
// Fails OPEN on a payment-infrastructure problem (Razorpay not configured,
// or the API call itself failing), not closed: a misconfigured payment
// gateway is an admin's mistake, and making every customer's booking
// attempt fail because of it is a worse outcome than temporarily letting a
// deposit-requiring booking through unpaid. Logged loudly (ERROR) so an
// admin actually sees it, matching this codebase's "no silent failures"
// principle from Section 6 — degraded gracefully, not silently.
async function sendPaymentRequest(tenantId, waId, workflow, session, booking, paymentRequirement) {
  if (!razorpay.isConfigured()) {
    log("ERROR", `Booking ${booking.bookingId} requires payment but Razorpay isn't configured (RAZORPAY_KEY_ID/SECRET unset) — proceeding as a normal confirmed booking instead of blocking the customer.`);
    await bookings.updateStatus(tenantId, booking.id, "booked");
    await sendConfirmationPhoto(tenantId, waId, session, workflow);
    await sendWhatsAppText(tenantId, waId, confirmationMessageFor(session, workflow));
    await syncBookingCreated(tenantId, booking, workflow);
    publishBookingEvent(tenantId, "booking.updated", { ...booking, status: "booked" });
    return;
  }

  try {
    const order = await razorpay.createOrder({
      amount: paymentRequirement.amountPaise,
      currency: "INR",
      receipt: booking.bookingId,
      notes: { bookingId: booking.bookingId, tenantId: String(tenantId) },
      customerPhone: waId,
    });
    await paymentStore.create(tenantId, booking.id, { amount: paymentRequirement.amountPaise, currency: "INR", providerOrderId: order.orderId });
    await bookings.updatePaymentStatus(tenantId, booking.id, "pending");

    const rupees = (paymentRequirement.amountPaise / 100).toFixed(0);
    await sendConfirmationPhoto(tenantId, waId, session, workflow);
    await sendWhatsAppText(
      tenantId,
      waId,
      `${confirmationMessageFor(session, workflow)}\n\n💳 A deposit of ₹${rupees} is required to confirm this booking. Pay here (secure, via Razorpay):\n${order.paymentUrl}\n\nYour slot is held for you — this booking is confirmed automatically the moment payment goes through.`
    );
  } catch (err) {
    log("ERROR", `Failed to create Razorpay payment link for booking ${booking.bookingId}: ${err.message}. Proceeding as a normal confirmed booking instead of blocking the customer.`);
    await bookings.updateStatus(tenantId, booking.id, "booked");
    await sendConfirmationPhoto(tenantId, waId, session, workflow);
    await sendWhatsAppText(tenantId, waId, confirmationMessageFor(session, workflow));
    await syncBookingCreated(tenantId, booking, workflow);
    publishBookingEvent(tenantId, "booking.updated", { ...booking, status: "booked" });
  }
}

// cancelActiveBooking — shared helper used by every cancel code path so
// the DB row is always marked cancelled, not just the in-memory session.
// Safe to call even when there is no active booking (no-op in that case).
// Section 9.7 — customer-initiated cancellation follows the workflow's own
// refundPolicy (full/partial/none based on notice given before the visit),
// computed by src/engine/paymentRefunds.js — the same policy math the
// provider-initiated path in server.js uses, so the refund percentage a
// customer gets never depends on which side of the app cancelled it.
// Shared by every "actually cancel this row" call site (cancelActiveBooking
// below, and beginCancelFlow's confirmed-selection handler further down) —
// one place doing the status update, refund, calendar sync, and event
// publish, so a new caller can never do only some of those steps.
async function cancelBookingRow(tenantId, booking, workflows) {
  await bookings.updateStatus(tenantId, booking.id, "cancelled");
  const refundResult = await refundIfPaid(tenantId, booking, {
    initiatedBy: "customer",
    refundPolicy: workflows?.[booking.workflowId]?.refundPolicy,
  });
  await syncBookingCancelled(tenantId, booking);
  publishBookingEvent(tenantId, "booking.updated", { ...booking, status: "cancelled" });
  return { booking, refundResult };
}

// Still used by call sites where ambiguity genuinely isn't a concern — the
// review_confirm Cancel button and the orchestrator's CANCEL action both
// only ever fire mid-flow, about the one booking that flow itself just
// created, never a cold "cancel my appointment" out of nowhere (that's
// beginCancelFlow below, which can't just grab "the most recent one").
async function cancelActiveBooking(tenantId, waId, workflows) {
  const booking = await bookings.activeForCustomer(tenantId, waId);
  if (!booking) return null;
  return cancelBookingRow(tenantId, booking, workflows);
}

// Section 10 — a cold "cancel my appointment"/"cancel all previous
// bookings" must never just grab whichever booking activeForCustomer()'s
// "most recent" happens to resolve to: a customer can have more than one
// active booking (different businesses), and blindly cancelling the wrong
// one is worse than asking. Always confirms before cancelling anything,
// and lists every active booking by name/date/time when there's more than
// one, rather than guessing. session.pendingCancelIds (checked early in
// processMessage, alongside the feedback-capture check) is what makes the
// customer's next reply resolve back to this specific decision.
function describeBookingForCancelPrompt(b) {
  const when = b.visitDateLabel || b.visitDate || (b.checkInIso ? `check-in ${b.checkInIso}` : "");
  const time = b.visitTime ? ` at ${b.visitTime}` : "";
  return `${b.providerName || "your provider"}${when ? ` on ${when}` : ""}${time} (${b.bookingId})`;
}

async function beginCancelFlow(tenantId, waId, session, workflows) {
  const activeBookings = await bookings.activeListForCustomer(tenantId, waId);

  if (activeBookings.length === 0) {
    session.pendingCancelIds = null;
    await sendWhatsAppText(tenantId, waId,
      "You don't have any active booking to cancel. Would you like to make a new booking? Here's what we offer:"
    );
    session.awaitingBusinessPick = true;
    await sendBusinessMenu(tenantId, waId, workflows);
    return;
  }

  if (activeBookings.length === 1) {
    session.pendingCancelIds = [activeBookings[0].id];
    // Every choice the bot hands the customer should be a tap, not a word
    // they have to type correctly — buttons, not "reply YES/NO".
    await sendWhatsAppButtons(tenantId, waId,
      `You have an appointment with ${describeBookingForCancelPrompt(activeBookings[0])}. Would you like to cancel it?`,
      [
        { id: "cancel_confirm_yes", title: "Yes, cancel it" },
        { id: "cancel_confirm_no", title: "No, keep it" },
      ]
    );
    return;
  }

  session.pendingCancelIds = activeBookings.map((b) => b.id);
  const bookingRows = activeBookings.map((b) => ({
    id: `cancel_pick_${b.id}`,
    title: `${b.providerName || "Booking"}`.slice(0, 24),
    description: `${b.visitDateLabel || b.visitDate || ""}${b.visitTime ? ` at ${b.visitTime}` : ""} · ${b.bookingId}`,
  }));
  await sendWhatsAppList(tenantId, waId,
    `You have ${activeBookings.length} active bookings. Which one would you like to cancel?`,
    "Choose",
    [
      { title: "Active bookings", rows: bookingRows },
      { title: "Other options", rows: [
        { id: "cancel_pick_all", title: "Cancel all", description: `Cancel all ${activeBookings.length} bookings` },
        { id: "cancel_pick_none", title: "Keep them all", description: "Don't cancel anything" },
      ] },
    ]
  );
}

// Resolves session.pendingCancelIds against the customer's reply. Returns
// true if it handled the message (caller should stop), false to fall
// through to normal handling — an unrecognized reply drops the pending
// cancel rather than trapping the customer in a loop; they can just say
// "cancel" again if they still want to.
async function resolvePendingCancel(tenantId, waId, session, trimmed, workflows) {
  const pendingIds = session.pendingCancelIds;
  if (!pendingIds || pendingIds.length === 0) return false;

  const t = trimmed.trim().toLowerCase();
  session.pendingCancelIds = null; // one-shot either way — re-fetched fresh if they ask to cancel again

  // A tapped button/list row always arrives as its machine id (see
  // webhook.js: interactive.button_reply.id / list_reply.id take priority
  // over the tapped title) — matched first. The word-based regexes below
  // stay too, since WhatsApp always still accepts free-typed text even
  // when buttons are shown, and that must keep working identically.
  const isNoTap = t === "cancel_confirm_no" || t === "cancel_pick_none";
  const isYesTap = t === "cancel_confirm_yes";
  const allTap = t === "cancel_pick_all";
  const pickMatch = t.match(/^cancel_pick_(\d+)$/);

  if (isNoTap || /^(no|n|nevermind|never\s*mind|keep it|don'?t cancel)[.!\s]*$/i.test(t)) {
    await sendWhatsAppText(tenantId, waId, pendingIds.length > 1 ? "No problem — your bookings are still active." : "No problem — your booking is still active.");
    return true;
  }

  let targetId = null;
  if (pendingIds.length === 1) {
    if (isYesTap || /^(yes|y|confirm|confirm cancel)[.!\s]*$/i.test(t)) targetId = pendingIds[0];
    else {
      // Restore the pending state — an unrelated reply to a single-booking
      // confirmation is ambiguous enough to be worth one re-ask rather than
      // silently dropping it (unlike the multi-booking case below, there's
      // no list for a stray reply to plausibly be answering instead).
      session.pendingCancelIds = pendingIds;
      return false;
    }
  } else if (allTap || /^all$/i.test(t)) {
    for (const id of pendingIds) {
      const booking = await bookings.getById(tenantId, id);
      if (booking && !isTerminal(booking.status)) await cancelBookingRow(tenantId, booking, workflows);
    }
    await sendWhatsAppText(tenantId, waId, `❌ Done — all ${pendingIds.length} bookings have been cancelled. Message me anytime if you'd like to make a new one.`);
    return true;
  } else if (pickMatch) {
    const pickedId = Number(pickMatch[1]);
    if (pendingIds.includes(pickedId)) targetId = pickedId;
  } else {
    const n = parseInt(t, 10);
    if (Number.isInteger(n) && n >= 1 && n <= pendingIds.length) targetId = pendingIds[n - 1];
  }

  if (!targetId) return false; // dropped — genuinely didn't match, let it fall through

  const booking = await bookings.getById(tenantId, targetId);
  if (!booking || isTerminal(booking.status)) {
    await sendWhatsAppText(tenantId, waId, "That booking's already been handled — nothing to cancel there anymore.");
    return true;
  }

  const cancelResult = await cancelBookingRow(tenantId, booking, workflows);
  const refundNote = refundStatusNote(cancelResult.refundResult);
  await sendWhatsAppText(tenantId, waId, `❌ Done — your booking has been cancelled.${refundNote} Message me anytime if you'd like to make a new one.`);
  return true;
}

// Found live: every cancellation message in this file only ever checked
// `refundResult.refunded` to decide whether to mention money — but
// refundIfPaid() (paymentRefunds.js) returns `refunded: false` for THREE
// different reasons: no payment ever existed, the refund policy computed
// 0%, or the automatic Razorpay call genuinely failed (that last case
// alone sets `.error`). All three produced the identical silent-about-
// money cancellation text. A customer who paid a deposit and had the
// automatic refund fail has no way to know from the bot's own reply that
// they need to follow up — this is the one place the codebase's "no
// silent failures" principle stopped at the log line and never reached
// the customer. Centralized here so every cancellation path (the
// hardcoded CANCEL command, the DETECTING-stage intent handler,
// review_confirm's Cancel button, and the orchestrator's CANCEL action)
// reports refund status identically.
function refundStatusNote(refundResult) {
  if (refundResult?.refunded) return ` A refund of ₹${refundResult.amount / 100} has been issued.`;
  if (refundResult?.error) return " We couldn't process your refund automatically — our team has been notified and will follow up on it.";
  return "";
}

// Item 9 — loop detection. Before this, a customer who sent unmatched or
// off-script replies (typos, noise, a request the classifier genuinely
// couldn't place) got the exact same "I couldn't understand that" +
// re-prompt every single time, with no escalation path — unlike an
// explicit complaint/"talk to a human" ask, which already lands in
// support_requests after a second attempt (see the COMPLAINT branch
// below). A customer who's stuck without ever saying so in those words
// deserves the same real escalation, not an infinite loop of the same
// menu. session.confusionCount increments at the two genuine "I still
// don't understand" fallbacks (handleDetecting's unclassifiable-message
// branch, handleRunning's final invalid-input fallback) and resets to 0
// the moment they actually get somewhere (beginWorkflow, or a step
// applies successfully) — so it's tracking CONSECUTIVE confusion, not a
// lifetime count. Reuses the exact same support_requests mechanism and
// dashboard event the complaint path already does, rather than a second,
// parallel escalation system.
const CONFUSION_ESCALATION_THRESHOLD = 3;

async function maybeEscalateConfusion(tenantId, waId, session, workflows, trimmed) {
  session.confusionCount = (session.confusionCount || 0) + 1;
  if (session.confusionCount < CONFUSION_ESCALATION_THRESHOLD) return false;

  session.confusionCount = 0; // one escalation per streak, not one per message from here on
  const activeBooking = await bookings.activeForCustomer(tenantId, waId);
  const workflowId = activeBooking?.workflowId || session.workflowId || null;
  await supportRequests.create(tenantId, waId, workflowId, trimmed);
  log("INFO", `Support request logged for ${waId} after ${CONFUSION_ESCALATION_THRESHOLD} consecutive unclear replies (workflow=${workflowId || "unknown"}): "${trimmed}"`);
  dashboardEvents.publish(tenantId, "support_request.created", { workflowId, waId, message: trimmed });

  const workflow = workflowId ? workflows[workflowId] : null;
  const contactLine = workflow?.supportContact ? ` You can also reach us directly at ${workflow.supportContact}.` : "";
  await sendWhatsAppText(tenantId, waId,
    `I'm having trouble understanding what you're after, so I've flagged this for the team to follow up.${contactLine} ` +
    "In the meantime I can help you book, check your booking status (reply STATUS), or cancel a booking (reply CANCEL)."
  );
  return true;
}

// This function calls detectGeneralIntent(), then CONDITIONALLY
// classifyBusiness(), then CONDITIONALLY tryAnswerFactually() — up to 3
// sequential Groq calls. Deliberately left sequential, not parallelized:
// each call's INVOCATION depends on the previous one's result (classify
// only runs for booking_intent/unclear; factualQA only runs when classify
// found no business), not just which result takes precedence. Firing all
// three unconditionally for every message would 2-3x Groq usage on the
// majority of messages (a plain "STATUS" or "CANCEL" never needed the
// other two calls at all) just to shave latency on the minority that need
// the full chain — a real quota/cost trade-off, not a free win, so it's
// left as-is. What actually bounds this path's worst-case latency is
// Section 0.1's per-call timeout, not parallelization.
// ---------------------------------------------------------------------------
// Global Special Actions Intercept — handles language, location, AI chat, etc.
// ---------------------------------------------------------------------------
async function handleGlobalSpecialActions(tenantId, waId, session, trimmed, workflows) {
  const lc = trimmed.toLowerCase();

  // 1. Language switch/detection
  const requestedLang = detectAndSetLanguage(trimmed, session);
  if (requestedLang) {
    session.awaitingBusinessPick = false;
    if (requestedLang === "SHOW_PICKER") {
      await sendLanguagePicker(tenantId, waId, session);
    } else {
      await sendLanguageSwitchConfirmation(tenantId, waId, session);
    }
    return true;
  }

  // 2. Location lookup. Found live: the old version matched generic words
  // like "address"/"branch"/"near me" as a substring ANYWHERE in the
  // message — genuinely likely to appear inside a real booking answer
  // ("car AC not cooling, need it fixed near me by evening" as a
  // text_input reason, or a customer's own address as a text_input field)
  // and hijack it into a location-lookup reply instead of accepting the
  // answer. Whole-message match only, same fix as the language trigger
  // above — this is for a customer asking "where are you", not any
  // message that happens to contain a location-adjacent word.
  const isLocationQuery = lc === SPECIAL_OPT_LOCATION || LOCATION_QUERY_PHRASES.has(lc);

  if (isLocationQuery) {
    session.awaitingBusinessPick = false;
    await handleAiLocationLookup(tenantId, waId, trimmed, session, workflows);
    return true;
  }

  // 3. AI Chat
  if (lc === SPECIAL_OPT_AI_CHAT || AI_CHAT_QUERY_PHRASES.has(lc)) {
    session.awaitingBusinessPick = false;
    const greeting = await t(session, "You can ask us anything about our services, pricing, or availability here. Reply RESTART anytime to return to the main menu.");
    await sendWhatsAppText(tenantId, waId, greeting);
    session.subStage = "AI_CHAT";
    return true;
  }

  // 4. Callback
  if (lc === SPECIAL_OPT_CALLBACK || CALLBACK_RE.test(lc)) {
    session.awaitingBusinessPick = false;
    await supportRequests.create(tenantId, waId, null, "Customer requested a callback");
    dashboardEvents.publish(tenantId, "support_request.created", { workflowId: null, waId, message: "Callback requested" });
    log("INFO", `Callback request created for ${waId} (tenant=${tenantId})`);
    const ack = await t(session, "📞 Got it! We've noted your callback request and someone from our team will reach out to you shortly.");
    await sendWhatsAppText(tenantId, waId, ack);
    return true;
  }

  // 5. View Booking
  if (lc === SPECIAL_OPT_VIEW_BOOKING || VIEW_BOOKING_QUERY_PHRASES.has(lc)) {
    session.awaitingBusinessPick = false;
    await handleAiViewBooking(tenantId, waId, session, workflows);
    return true;
  }

  // 6. Waitlist
  if (lc === SPECIAL_OPT_WAITLIST || WAITLIST_QUERY_PHRASES.has(lc)) {
    session.awaitingBusinessPick = false;
    await handleAiWaitlist(tenantId, waId, trimmed, session, workflows);
    return true;
  }

  // 7. Send Photo
  if (lc === SPECIAL_OPT_SEND_PHOTO || SEND_PHOTO_QUERY_PHRASES.has(lc)) {
    session.awaitingBusinessPick = false;
    await handleAiPhotoUpload(tenantId, waId, trimmed, session, workflows);
    return true;
  }

  return false;
}

async function handleDetecting(tenantId, waId, session, trimmed, workflows) {
  // Awaiting language pick from the interactive menu
  if (session.subStage === "AWAITING_LANGUAGE_PICK") {
    const lang = detectAndSetLanguage(trimmed, session);
    session.subStage = null;
    if (lang && lang !== "SHOW_PICKER") {
      await sendLanguageSwitchConfirmation(tenantId, waId, session);
    } else {
      session.lang = "en";
      await sendLanguageSwitchConfirmation(tenantId, waId, session);
    }
    return;
  }

  // Global Special Actions Intercept — works at ANY point
  if (await handleGlobalSpecialActions(tenantId, waId, session, trimmed, workflows)) {
    return;
  }

  // Short-circuit: if we already showed the business menu and the customer
  // is directly tapping/typing a workflow id from it, skip the full intent
  // classification loop — they've already answered the question.
  if (session.awaitingBusinessPick) {
    const picked = matchWorkflowByIdOrIndex(trimmed, workflows);
    if (picked) {
      await beginWorkflow(tenantId, waId, session, picked.id, workflows, trimmed);
      return;
    }
  }


  // Found live (real WhatsApp number, not a test) — a customer stuck in
  // AI_CHAT/AWAITING_PHOTO from an earlier turn had no way back to the
  // actual business menu except typing the exact word RESTART, which
  // nothing in the conversation ever tells them. A fresh greeting is an
  // unambiguous "start over" signal on its own — checked and acted on
  // BEFORE the AI_CHAT/AWAITING_PHOTO dispatch below (which used to run
  // unconditionally first, meaning "hii" while stuck just got fed to the
  // AI chat handler as another chat message instead of ever reaching the
  // greeting handling further down this function). Clearing subStage
  // here is exactly what RESTART already does elsewhere — this is just a
  // second, actually-discoverable way to trigger the identical reset.
  const isGreeting = GREETING_RE.test(trimmed);
  // Found live: once subStage is AI_CHAT, ONLY a fresh greeting broke out
  // of it before dispatching to handleAiChat below — a natural "cancel my
  // appointment"/"cancel today's appointment" typed while stuck in AI_CHAT
  // went straight to Groq instead of the deterministic CANCEL_RE/STATUS_RE/
  // RESTART_RE handling further down this function, and if Groq itself was
  // rate-limited (reproduced live: a 429), the customer got a generic
  // apology with no way to cancel except the bare word "cancel". Widened
  // the same escape hatch to also fire for cancel/status/restart phrasing —
  // reusing keywordIntent() (the same deterministic classifier
  // detectGeneralIntent() falls back to when Groq is unavailable), not a
  // second hardcoded phrase list.
  const escapeIntent = keywordIntent(trimmed);
  const shouldEscapeSubStage =
    isGreeting ||
    escapeIntent === INTENTS.CANCEL_BOOKING ||
    escapeIntent === INTENTS.CHECK_STATUS ||
    escapeIntent === INTENTS.RESTART;
  if (shouldEscapeSubStage && (session.subStage === "AI_CHAT" || session.subStage === "AWAITING_PHOTO")) {
    session.subStage = null;
  }

  // --- Ongoing AI chat / Photo upload sub-modes ---
  if (session.subStage === "AI_CHAT") {
    await handleAiChat(tenantId, waId, trimmed, session, workflows);
    return;
  }

  if (session.subStage === "AWAITING_PHOTO") {
    await handleAiPhotoUpload(tenantId, waId, trimmed, session, workflows);
    return;
  }

  // Hardcoded, checked before any AI call — a direct "are you a bot?"
  // deserves one honest, consistent answer every time, not whatever an
  // LLM happens to guess that turn (and it's free: no Groq call needed).
  if (isBotIdentityQuestion(trimmed)) {
    await sendWhatsAppText(tenantId, waId,
      "I'm an automated booking assistant, not a human — I can help you book, check a booking (reply STATUS), or cancel one (reply CANCEL)."
    );
    return;
  }

  // Universal intent layer — understand what the customer MEANS regardless
  // of exact phrasing. This replaces the old SUPPORT_REQUEST_RE /
  // ALREADY_BOOKED_RE regex block which silently failed for anything
  // slightly off (e.g. "CANCEL THAT" was misrouted to a hair booking).
  const hasActive = await bookings.hasActive(tenantId, waId);

  // Handle simple greetings separately (isGreeting computed above, now
  // also used to escape a stuck AI_CHAT/AWAITING_PHOTO subStage).
  // A greeting is not a booking request and should never fall through to
  // the "you already have a booking" fallback.
  if (isGreeting) {
    if (hasActive) {
      const msg = await t(session, "Hi! 👋 You already have a booking with us. Reply STATUS to check it, or tell me if you'd like to book something else.");
      await sendWhatsAppText(tenantId, waId, msg);
    } else {
      session.awaitingBusinessPick = true;
      await sendBusinessMenu(tenantId, waId, workflows, session, true);
    }

    return;
  }

  // Found live: a bare "ok"/"thanks"/"no thanks" with an active booking was
  // falling all the way through to the same "Looks like you already have a
  // booking..." nudge + full business menu as a genuine unmatched request
  // ("I want relaxation") — repetitive and robotic when the customer was
  // just acknowledging the bot's last message, not asking for anything.
  // Checked before the AI intent call so it also skips two wasted Groq
  // round-trips for what is, unambiguously, not a request.
  if (hasActive && isPlainAcknowledgment(trimmed)) {
    await sendWhatsAppText(tenantId, waId, "👍 Reply STATUS anytime to check your booking, or send a message if you'd like to book something else.");
    return;
  }

  const intent = await detectGeneralIntent(trimmed, hasActive);
  if (intent === INTENTS.GREETING) {
    if (hasActive) {
      const msg = await t(session, "Hi! 👋 You already have a booking with us. Reply STATUS to check it, or tell me if you'd like to book something else.");
      await sendWhatsAppText(tenantId, waId, msg);
    } else {
      session.awaitingBusinessPick = true;
      await sendBusinessMenu(tenantId, waId, workflows, session, true);
    }

    return;
  }

  if (intent === INTENTS.CANCEL_BOOKING) {
    await beginCancelFlow(tenantId, waId, session, workflows);
    return;
  }

  if (intent === INTENTS.CHECK_STATUS) {
    // A bare "STATUS"/"kab hai" gets the standard block. Anything with
    // more content is a follow-up ABOUT that status — found live, this
    // used to just re-send the identical static block regardless of what
    // was actually asked ("is it for today or another day?" got the same
    // reply STATUS itself would). Try to answer the specific question
    // from the booking's own data first; only fall back to the standard
    // block if that can't answer it (or there's no active booking to ask
    // a follow-up about in the first place).
    const isBareStatusRequest = /^(status|kab\s*(hai|h)?|kitne\s*baje)[\s.?!]*$/i.test(trimmed);
    if (!isBareStatusRequest) {
      const booking = await bookings.activeForCustomer(tenantId, waId);
      if (booking) {
        // Found live: "please reschedule my appointment to tomorrow at
        // 3pm" matches STATUS_RE (via "my appointment") and, with no
        // dedicated reschedule flow for customers (rescheduling only
        // exists as a provider/dashboard action — src/routes/dashboard.js),
        // silently fell through to tryAnswerAboutBooking, which just
        // answered with the booking's EXISTING details — no
        // acknowledgment the reschedule request itself went nowhere. An
        // honest "can't self-serve this yet" beats a reply that looks
        // like the request was handled.
        if (/\bresched\w*/i.test(trimmed)) {
          await sendWhatsAppText(tenantId, waId, await t(session, "I can't reschedule a booking automatically yet — reply CANCEL to cancel this one and book a new time, or contact us directly to move it."));
          return;
        }
        const answer = await tryAnswerAboutBooking(trimmed, booking, session.history);
        if (answer) {
          await sendWhatsAppText(tenantId, waId, answer);
          return;
        }
      }
    }
    await handleStatusCommand(tenantId, waId);
    return;
  }

  if (intent === INTENTS.RESTART) {
    sessions.delete(mapKey(tenantId, waId));
    await sendWhatsAppText(tenantId, waId, "🔄 Starting fresh. What would you like to book?");
    // Refresh session so subsequent logic has a clean state
    const fresh = getSession(tenantId, waId);
    fresh.awaitingBusinessPick = true;
    await sendBusinessMenu(tenantId, waId, workflows);
    return;
  }

  if (intent === INTENTS.QUESTION) {
    // Try to answer factually first (grounded in the business's own real
    // data — hours, fees, location, FAQ docs). If that can't answer it
    // either, hand off to the open AI assistant rather than defaulting to
    // the menu — same reasoning and same reused handleAiChat() as the
    // "unclassifiable" fallback further below; a real question deserves a
    // real attempt at an answer, not a business list.
    const factualAnswer = await tryAnswerFactually(tenantId, trimmed, workflows, session.history);
    if (factualAnswer) {
      await sendWhatsAppText(tenantId, waId, factualAnswer);
    } else if (process.env.GROQ_API_KEY) {
      session.subStage = "AI_CHAT";
      await handleAiChat(tenantId, waId, trimmed, session, workflows);
    } else {
      session.awaitingBusinessPick = true;
      if (hasActive) {
        await sendWhatsAppText(tenantId, waId, "I don't have an answer for that — but I can help you book something. Here's what we offer:");
      }
      await sendBusinessMenu(tenantId, waId, workflows);
    }
    return;
  }

  if (intent === INTENTS.COMPLAINT) {
    session.supportAttempts = (session.supportAttempts || 0) + 1;
    // Real frustration ("this is terrible", "not working") reads
    // differently from a neutral "can I speak to support" that the LLM
    // alone called a complaint with no keyword backing it up — the first
    // deserves an apology, the second just sounds presumptuous ("sorry to
    // hear that" when nothing was said to be sorry about).
    const genuinelyUpset = isExplicitComplaint(trimmed);

    if (session.supportAttempts < 2) {
      const opener = genuinelyUpset
        ? "I'm sorry to hear that — I want to make this right."
        : "Sure, happy to help.";
      await sendWhatsAppText(tenantId, waId,
        `${opener} I'm an automated booking assistant, so let me know what you'd like to book and I'll sort it out quickly. Or reply STATUS to check an existing booking.`
      );
      return;
    }

    // Second ask — this used to be a dead end: the same canned refusal
    // every time, nothing anywhere for an actual person to see or act on.
    // Now it lands somewhere real: a support_requests row visible on the
    // dashboard, and a real contact number if the customer's business
    // configured one.
    const activeBooking = await bookings.activeForCustomer(tenantId, waId);
    const workflowId = activeBooking?.workflowId || session.workflowId || null;
    await supportRequests.create(tenantId, waId, workflowId, trimmed);
    log("INFO", `Support request logged for ${waId} (workflow=${workflowId || "unknown"}): "${trimmed}"`);
    dashboardEvents.publish(tenantId, "support_request.created", { workflowId, waId, message: trimmed });

    const workflow = workflowId ? workflows[workflowId] : null;
    const contactLine = workflow?.supportContact
      ? ` You can also reach us directly at ${workflow.supportContact}.`
      : "";
    const apology = genuinelyUpset ? "I apologise for the trouble. " : "";
    await sendWhatsAppText(tenantId, waId,
      `${apology}I'm an automated assistant and can't connect you to a person directly here, but I've flagged this for the team to follow up.${contactLine} ` +
      "In the meantime I can help you book, check your booking status (reply STATUS), or cancel a booking (reply CANCEL)."
    );
    return;
  }

  // booking_intent or unclear — fall through to AI business classification.
  // For "unclear" we still run classifyBusiness because a greeting like
  // "hi doctor needed" contains both noise AND a booking intent the
  // keyword-level intent check might have missed.
  const { workflowId, source } = await classifyBusiness(trimmed, workflows);
  log("INFO", `Classified "${trimmed}" -> ${workflowId ?? "unclear"} (source: ${source})`);

  if (!workflowId) {
    // Not a booking request — before assuming it's just noise, see if it's
    // a real question we can answer from data we actually have (hours,
    // fees, location). Beats showing the same menu for every message that
    // isn't a booking intent.
    const factualAnswer = await tryAnswerFactually(tenantId, trimmed, workflows, session.history);
    if (factualAnswer) {
      session.confusionCount = 0; // a real answer means they weren't actually stuck
      await sendWhatsAppText(tenantId, waId, factualAnswer);
      return;
    }

    // Item 9 — loop detection. Genuinely unclassifiable AND unanswerable:
    // this is the actual "stuck" case, not the workflow-selection menu
    // that legitimately appears the first time or two.
    if (await maybeEscalateConfusion(tenantId, waId, session, workflows, trimmed)) return;

    // New plan — hand this off to the AI assistant rather than defaulting
    // straight back to the same business-list menu every time a message
    // doesn't classify. This is the exact same handleAiChat() a customer
    // reaches by typing "chat" (see handleGlobalSpecialActions above) —
    // reused here, not duplicated, so both paths share one prompt/
    // knowledge-base/history implementation. Sets subStage so the
    // conversation actually CONTINUES in AI mode on their next message
    // too, instead of re-running full intent classification from scratch
    // every single turn — a real back-and-forth, not one-off answers.
    // Only when GROQ_API_KEY is configured: with no key, handleAiChat's
    // own fallback text ("AI assistant isn't available... choose a
    // service") would just precede the SAME menu below, a redundant
    // double message — skip straight to the menu instead in that case.
    if (process.env.GROQ_API_KEY) {
      session.subStage = "AI_CHAT";
      await handleAiChat(tenantId, waId, trimmed, session, workflows);
      return;
    }

    session.awaitingBusinessPick = true;
    if (hasActive) {
      await sendWhatsAppText(tenantId, waId, "I couldn't quite understand that. You already have a booking with us. Reply STATUS to check it, CANCEL to cancel it, or tell me what you'd like to book.");
    }
    await sendBusinessMenu(tenantId, waId, workflows);
    return;
  }

  await beginWorkflow(tenantId, waId, session, workflowId, workflows, trimmed);
}

function normalizeConfirmProviderChoice(text) {
  const t = text.toLowerCase();
  if (t === "continue" || t === "1" || t.includes("continue")) return "continue";
  if (t === "choose_another" || t === "2" || t.includes("choose") || t.includes("another")) return "choose_another";
  return null;
}

function normalizeReviewChoice(text) {
  const t = text.toLowerCase();
  if (t === "confirm" || t === "1" || t.includes("confirm")) return "confirm";
  if (t === "edit" || t === "2" || t.includes("edit")) return "edit";
  if (t === "cancel" || t === "3" || t.includes("cancel")) return "cancel";
  return null;
}

const RECLASSIFIABLE_STEP_TYPES = ["select_provider", "select_option", "select_date", "select_time_slot", "select_hotel", "select_room"];

async function handleRunning(tenantId, waId, session, trimmed, workflows) {
  // Found live: handleGlobalSpecialActions was ALSO wired in here at one
  // point — a real regression risk. Its checks (especially the location
  // query regex) match on substrings anywhere in free text, which is fine
  // in handleDetecting (nothing specific is expected yet) but dangerous
  // here: a customer's actual answer to the CURRENT step ("car AC not
  // cooling, need it fixed near me by evening" as a text_input "reason")
  // would get hijacked into a location-lookup reply instead of being
  // accepted as their answer. Deliberately NOT called here — mid-flow,
  // free text means "answering this step," not "issuing a global
  // command." The few commands that genuinely must work at any point
  // (restart/cancel/status/here) are exact-match only and already
  // checked in handleIncomingMessage before stage dispatch, not through
  // this broader, substring-matching intercept.
  const workflow = workflows[session.workflowId];
  const step = currentStep(workflow, session);

  // Mid provider-extra-question loop — stepIndex is pinned at
  // review_confirm's index the whole time (see maybeAskNextExtraField's
  // comment), so this has to be checked before treating `step` as "the
  // thing currently being answered" the way every branch below does.
  if (step.type === "review_confirm" && (session.extraFieldIndex ?? 0) < (session.selectedProvider?.extraFields?.length || 0)) {
    const extraFields = session.selectedProvider.extraFields;
    const field = extraFields[session.extraFieldIndex];
    const error = await applyStepInput(tenantId, workflow, field, session, trimmed);
    if (error) {
      await sendWhatsAppText(tenantId, waId, error);
      await sendStepPrompt(tenantId, waId, workflow, field, session);
      return;
    }
    session.extraFieldIndex += 1;
    if (await maybeAskNextExtraField(tenantId, waId, session, workflow)) return;
    await sendStepPrompt(tenantId, waId, workflow, step, session); // all answered — now actually show review_confirm
    return;
  }

  if (session.subStage === "CONFIRM_PROVIDER") {
    const choice = normalizeConfirmProviderChoice(trimmed);
    if (choice === "continue") {
      session.subStage = null;
      await advanceOrFinish(tenantId, waId, session, workflow);
      return;
    }
    if (choice === "choose_another") {
      session.subStage = null;
      session.selectedProvider = null;
      await sendStepPrompt(tenantId, waId, workflow, step, session);
      return;
    }
    // Found live: "PAISE JADA HAI YEH" (this fee is too much) here got
    // "Please tap Continue or Choose Another" with zero acknowledgment —
    // tone-deaf to a real objection. Acknowledge it, then still show the
    // same choices; this doesn't change what the customer CAN do, only
    // whether the bot sounds like it heard them.
    if (isPriceObjection(trimmed)) {
      await sendWhatsAppText(tenantId, waId, "Totally understand — the fee shown is what this provider charges. If it doesn't work for you, tap Choose Another to see other options.");
    } else {
      await sendWhatsAppText(tenantId, waId, "Please tap Continue or Choose Another.");
    }
    await sendConfirmProviderCard(tenantId, waId, workflow, step, session);
    return;
  }

  if (step.type === "review_confirm") {
    const choice = normalizeReviewChoice(trimmed);
    if (choice === "confirm") {
      await advanceOrFinish(tenantId, waId, session, workflow);
      return;
    }
    if (choice === "edit") {
      // Jumps back to whichever step is marked editTarget: true in the
      // workflow config — the first of the customer-detail steps, so
      // editing re-walks all of them (name/age/gender/reason) cleanly.
      const editIdx = workflow.steps.findIndex((s) => s.editTarget);
      session.stepIndex = editIdx >= 0 ? editIdx : session.stepIndex;
      await sendStepPrompt(tenantId, waId, workflow, currentStep(workflow, session), session);
      return;
    }
    if (choice === "cancel") {
      const cancelResult = await cancelActiveBooking(tenantId, waId, workflows); // persist the cancellation to the DB
      sessions.delete(mapKey(tenantId, waId));
      const refundNote = refundStatusNote(cancelResult?.refundResult);
      await sendWhatsAppText(tenantId, waId, `❌ Booking cancelled.${refundNote} Send a message anytime to start a new one.`);
      return;
    }
    if (isPriceObjection(trimmed)) {
      await sendWhatsAppText(tenantId, waId, "Totally understand — the fee shown is what this provider charges. Tap Cancel if you'd rather not proceed, or Confirm to go ahead.");
      await sendStepPrompt(tenantId, waId, workflow, step, session);
      return;
    }

    // Found live: "actually make it 3pm instead" at review_confirm fell
    // straight to the flat "Please tap Confirm, Edit Details, or Cancel" —
    // Edit Details only reaches the ONE step marked editTarget (customer
    // details), never provider/date/time, which sit earlier in the step
    // list. The orchestrator already exists specifically to handle "change
    // an earlier answer" (planNextAction -> GO_TO_STEP) and already works
    // correctly here — describeSteps()/STEP_DESCRIPTIONS has a real entry
    // for review_confirm, and GO_TO_STEP's own bounds check already allows
    // jumping back to any step at or before the current one. It was just
    // never CALLED from this branch — handleRunning's generic fallback
    // below calls it for every OTHER step type, but review_confirm returns
    // before ever reaching that code. Same call, same executor, just wired
    // in here too.
    if (await executeOrchestratedPlan(tenantId, waId, session, workflow, await planNextAction(trimmed, workflow, session), trimmed, workflows)) return;

    if (await maybeEscalateConfusion(tenantId, waId, session, workflows, trimmed)) return;

    await sendWhatsAppText(tenantId, waId, "Please tap Confirm, Edit Details, or Cancel.");
    await sendStepPrompt(tenantId, waId, workflow, step, session);
    return;
  }

  const error = await applyStepInput(tenantId, workflow, step, session, trimmed);

  if (!error) {
    session.confusionCount = 0; // a valid step answer means they weren't actually stuck
    if (step.type === "select_provider" && step.confirmCard) {
      session.subStage = "CONFIRM_PROVIDER";
      await sendConfirmProviderCard(tenantId, waId, workflow, step, session);
      return;
    }
    await advanceOrFinish(tenantId, waId, session, workflow);
    return;
  }

  // Free text didn't match the current step. Two independent questions
  // both need answering: "does this actually read like a request for a
  // different business" (reclassify) and "what should the orchestrator do
  // with it" (plan). Neither needs the other's OUTPUT as input — only
  // which result takes precedence is decided once both settle — and both
  // were already going to be called in the worst case before this change,
  // just one after the other. Firing them together with Promise.all cuts
  // this path's Groq latency roughly in half for no extra API calls.
  // (Contrast with handleDetecting below, where the equivalent calls stay
  // sequential on purpose: there, each call's INVOCATION is conditional on
  // the previous one's result, so running them unconditionally in
  // parallel would double/triple Groq usage on every message just to
  // shave latency on the minority that need the full chain — not a
  // trade worth making silently.)
  const reclassifyPromise =
    RECLASSIFIABLE_STEP_TYPES.includes(step.type) && couldBeADifferentBusiness(trimmed, workflows, session.workflowId)
      ? classifyBusiness(trimmed, workflows)
      : null;
  const planPromise = planNextAction(trimmed, workflow, session);

  if (reclassifyPromise) {
    const { workflowId: reclassified } = await reclassifyPromise;
    if (reclassified && reclassified !== session.workflowId) {
      log("INFO", `Mid-flow switch: "${trimmed}" looked like a request for "${reclassified}" instead.`);
      await sendWhatsAppText(tenantId, waId, `Looks like you're after ${workflows[reclassified].matchLabel} instead — switching you over.`);
      await beginWorkflow(tenantId, waId, session, reclassified, workflows, trimmed);
      return;
    }
  }

  // Still unmatched — let the orchestrator decide what the customer
  // actually wanted (change an earlier answer, ask a question, bail out)
  // rather than repeating "invalid input" at them indefinitely. It only
  // ever picks a navigation intent; the engine below still performs the
  // action, so validation and slot locking are unaffected.
  if (await executeOrchestratedPlan(tenantId, waId, session, workflow, await planPromise, trimmed, workflows)) return;

  // Item 9 — loop detection. The orchestrator had its shot at figuring out
  // what they meant and couldn't either; this is the genuine "stuck"
  // fallback for a mid-flow step, the same real gap as handleDetecting's
  // equivalent branch above.
  if (await maybeEscalateConfusion(tenantId, waId, session, workflows, trimmed)) return;

  await sendWhatsAppText(tenantId, waId, error);
  await sendStepPrompt(tenantId, waId, workflow, step, session);
}

// Executes an already-computed orchestrator plan. Returns true if it
// handled the message, false to fall through to the normal "invalid
// input" reply. Split from the planning call itself (planNextAction, in
// orchestrator.js) so the caller can run planning concurrently with other
// independent work rather than always paying for it sequentially.
async function executeOrchestratedPlan(tenantId, waId, session, workflow, plan, trimmed, workflows) {
  if (!plan || plan.action === ACTIONS.RETRY_STEP) return false;

  log("INFO", `Orchestrator planned "${plan.action}"${plan.stepIndex !== undefined ? ` -> step ${plan.stepIndex}` : ""} for "${trimmed}"`);

  if (plan.action === ACTIONS.CANCEL) {
    const cancelResult = await cancelActiveBooking(tenantId, waId, workflows); // persist the cancellation to the DB before clearing the session
    sessions.delete(mapKey(tenantId, waId));
    const refundNote = refundStatusNote(cancelResult?.refundResult);
    await sendWhatsAppText(tenantId, waId, `❌ No problem — I've cancelled that booking.${refundNote} Message me anytime to start a new one.`);
    return true;
  }

  if (plan.action === ACTIONS.RESTART) {
    sessions.delete(mapKey(tenantId, waId));
    await sendWhatsAppText(tenantId, waId, "🔄 Starting fresh. What would you like to book?");
    return true;
  }

  if (plan.action === ACTIONS.HUMAN) {
    // Found live (testing pass): this used to just decline and re-show the
    // current step, every single time, with nothing logged anywhere for a
    // provider to see — a customer clearly and repeatedly asking for a
    // person mid-booking got no better outcome than one who never asked at
    // all. The DETECTING-stage COMPLAINT branch already solved exactly this
    // problem (2-attempt threshold, then a real support_requests row) —
    // reusing the same session.supportAttempts counter and the same
    // supportRequests.create() call here, rather than a second parallel
    // escalation system, so "asked for a human twice" is true regardless of
    // which stage of the conversation they asked from.
    session.supportAttempts = (session.supportAttempts || 0) + 1;
    if (session.supportAttempts < 2) {
      await sendWhatsAppText(tenantId, waId,
        "I'm an automated booking assistant, so I can't transfer you to a person — but I can finish this booking for you. " +
        'If you\'d rather not continue, reply "cancel".'
      );
      await sendStepPrompt(tenantId, waId, workflow, currentStep(workflow, session), session);
      return true;
    }

    await supportRequests.create(tenantId, waId, workflow.id, trimmed);
    log("INFO", `Support request logged for ${waId} (workflow=${workflow.id}): "${trimmed}"`);
    dashboardEvents.publish(tenantId, "support_request.created", { workflowId: workflow.id, waId, message: trimmed });
    const contactLine = workflow.supportContact ? ` You can also reach us directly at ${workflow.supportContact}.` : "";
    await sendWhatsAppText(tenantId, waId,
      `I'm an automated assistant and can't connect you to a person directly here, but I've flagged this for the team to follow up.${contactLine} ` +
      "In the meantime I can still finish this booking for you — or reply \"cancel\" if you'd rather not continue."
    );
    await sendStepPrompt(tenantId, waId, workflow, currentStep(workflow, session), session);
    return true;
  }

  if (plan.action === ACTIONS.ANSWER_QUESTION) {
    const answer = await tryAnswerFactually(tenantId, trimmed, workflows, session.history);
    if (!answer) return false; // nothing grounded to say — don't invent one
    await sendWhatsAppText(tenantId, waId, answer);
    await sendStepPrompt(tenantId, waId, workflow, currentStep(workflow, session), session);
    return true;
  }

  if (plan.action === ACTIONS.GO_TO_STEP) {
    const target = workflow.steps[plan.stepIndex];
    // Clear the target field so the step genuinely re-asks rather than
    // silently keeping the old value, and drop its resolved *Iso twin
    // (set by select_date) which would otherwise go stale.
    if (target.field) {
      delete session.data[target.field];
      delete session.data[`${target.field}Iso`];
    }
    if (target.type === "select_provider") session.selectedProvider = null;
    if (target.type === "select_hotel") session.selectedHotel = null;
    session.stepIndex = plan.stepIndex;
    session.subStage = null;
    // Found live: without this, changing ONE earlier answer (e.g. "actually
    // make it 3pm") made the customer re-walk and re-answer every step
    // BETWEEN the changed one and review_confirm too — re-typing their
    // name, age, reason, all already on file and untouched by the change.
    // advanceOrFinish() checks this flag exactly once, right after the
    // rewound step is re-answered, to fast-forward past any step that
    // already has a value — a one-shot signal, not a standing behavior
    // change: a NORMAL first-time walk through the workflow never sets
    // this, so an auto-filled-from-context field (extractContext, in
    // beginWorkflow) still always gets shown for confirmation exactly as
    // before — this only skips re-confirming what the customer already
    // confirmed once, specifically because they just asked to change one
    // OTHER thing, not this one.
    session.skipAnsweredSteps = true;
    await sendWhatsAppText(tenantId, waId, "Sure — let's change that.");
    await sendStepPrompt(tenantId, waId, workflow, target, session);
    return true;
  }

  return false;
}

async function handleStatusCommand(tenantId, waId) {
  const session = getSession(tenantId, waId);
  const booking = await bookings.activeForCustomer(tenantId, waId);
  if (!booking) {
    // No active/payment-pending booking (activeForCustomer already excludes
    // every terminal status). Before falling back to the generic "no active
    // booking" reply, check for the one other state STATUS should still
    // surface: a just-completed visit still awaiting feedback — the same
    // feedbackRequestedAt signal the feedback-capture handler above uses,
    // so this and that can never disagree about which booking is "pending
    // feedback." Anything else (rated already, cancelled, no-show) is true
    // history and gets the plain fallback, same as before.
    const allForCustomer = (await bookings.values(tenantId))
      .filter((b) => b.waId === waId && b.status === "done" && b.feedbackRequestedAt)
      .sort((a, b) => Number(b.feedbackRequestedAt || 0) - Number(a.feedbackRequestedAt || 0));
    const pendingFeedback = allForCustomer[0];
    if (pendingFeedback) {
      await sendFeedbackRatingList(tenantId, waId, await t(session,
        `Your${pendingFeedback.visitTime ? ` ${pendingFeedback.visitTime}` : ""} appointment with ${pendingFeedback.providerName} is complete. How was your visit?`
      ));
      return;
    }
    await sendWhatsAppText(tenantId, waId, await t(session, "No active booking found. Send a message anytime describing what you'd like to book."));
    return;
  }

  // Hotel-style booking (a date range, not a single time slot).
  if (booking.checkInIso) {
    const checkOut = new Date(parseIsoDate(booking.checkInIso).getTime() + (booking.nights || 1) * 24 * 60 * 60 * 1000);
    await sendWhatsAppText(tenantId, waId, await t(session,
      `🏨 ${booking.hotelName || ""} — ${booking.providerName}\nCheck-in: ${booking.checkInIso}\nCheck-out: ${isoDate(checkOut)}\n🧾 Booking ID: ${booking.bookingId}`
    ));
    return;
  }

  // Local calendar date, not .toISOString() — that converts to UTC first,
  // which is a day off near midnight for any timezone ahead of UTC (IST
  // included). Same bug class dateSlots.js's isoDate() already exists to
  // avoid; this call site had drifted from that convention.
  const todayIso = isoDate(new Date());
  if (booking.visitDate && booking.visitDate !== todayIso) {
    await sendWhatsAppText(tenantId, waId, await t(session,
      `Your next appointment is on ${booking.visitDateLabel || booking.visitDate} at ${booking.visitTime} with ${booking.providerName}. Reply HERE when you arrive on the day.`
    ));
    return;
  }

  // booking.status === "done" is unreachable here — activeForCustomer()
  // now excludes every terminal status (bookingStateMachine.js's
  // TERMINAL_STATUSES), so a completed visit is handled by the
  // pendingFeedback branch above (or the plain "no active booking" reply
  // once feedback's been given), never by falling through to this point.

  if (booking.status === "serving") {
    await sendWhatsAppText(tenantId, waId, await t(session, `You're currently being seen by ${booking.providerName}.`));
    return;
  }

  if (booking.status === "arrived") {
    await sendWhatsAppText(tenantId, waId, await t(session, `You're checked in for your ${booking.visitTime} appointment with ${booking.providerName}. Please wait to be called.`));
    return;
  }

  // Live-recomputed on every check, not a count fixed at booking time —
  // Section 3. The old version counted "other bookings made earlier
  // today" and never changed again for the rest of the conversation, so
  // it silently went stale the moment anyone ahead actually got served,
  // cancelled, or no-showed. This instead counts active (not done, not
  // cancelled) bookings with an earlier TIME slot, recomputed fresh —
  // marking someone done immediately and correctly shifts everyone
  // behind them down by one on their very next check.
  const ahead = (await computeQueuePosition(booking)) ?? 0;
  const positionLine =
    ahead === 0 ? "You're next!" : `You're approximately #${ahead + 1} in line today (${ahead} ahead of you).`;

  // "at the clinic" used to be hardcoded here regardless of business type —
  // read oddly for a salon/automobile-service/etc. booking. Left generic.
  await sendWhatsAppText(tenantId, waId, await t(session,
    `📍 Appointment: ${booking.visitTime} with ${booking.providerName}\n🧾 Booking ID: ${booking.bookingId}\n\n${positionLine} Reply HERE when you arrive.`
  ));
}

async function handleHereCommand(tenantId, waId) {
  const session = getSession(tenantId, waId);
  const booking = await bookings.activeForCustomer(tenantId, waId);
  if (!booking) {
    await sendWhatsAppText(tenantId, waId, await t(session, "No active booking found to check in."));
    return;
  }
  // Item 6 — this used to have NO status guard at all: activeForCustomer()
  // only excludes "cancelled", so a customer replying HERE for a booking
  // already "done"/"no_show" (a finished record) or "serving" (already
  // further along than "arrived") would silently move it BACKWARD —
  // exactly the same terminal/out-of-order-status bug shape server.js's
  // cancel/reschedule/serve/complete/no_show actions each already had to
  // be fixed for. isTerminal() is the shared source of truth those fixes
  // now share too (src/engine/bookingStateMachine.js); "serving" is
  // additionally blocked here since re-arriving can't un-serve someone.
  if (isTerminal(booking.status) || booking.status === "serving") {
    const message =
      booking.status === "serving" ? `You're currently being seen by ${booking.providerName}.` :
        booking.status === "done" ? `Your${booking.visitTime ? ` ${booking.visitTime}` : ""} appointment with ${booking.providerName} is already complete.` :
          `Your booking is already marked ${booking.status.replace("_", "-")}.`;
    await sendWhatsAppText(tenantId, waId, await t(session, message));
    return;
  }
  await bookings.updateStatus(tenantId, booking.id, "arrived");
  publishBookingEvent(tenantId, "booking.updated", { ...booking, status: "arrived" });
  await sendWhatsAppText(tenantId, waId, await t(session, `✅ Marked you as arrived${booking.visitTime ? ` for your ${booking.visitTime} appointment` : ""}. Please wait to be called.`));
}

// Section 8 — tenantId is now required, resolved by the caller BEFORE this
// runs: server.js's webhook handler resolves it from the receiving
// WhatsApp number's phone_number_id (src/store/tenantStore.js
// .getByPhoneNumberId()); /api/simulate-whatsapp and any other caller
// resolves it from whatever context they have (a logged-in session, a
// test's own fixture). This function no longer has any way to guess a
// tenant on its own — every store call inside it needs one explicitly,
// which is exactly the point: there is no code path here that can
// silently operate across tenants.
async function processMessage(tenantId, waId, text, workflows) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;

  if (isRateLimited(waId)) {
    // Found live: total silence here was the one deliberately-silent path
    // left in an otherwise "always reply" codebase — a customer double-
    // tapping out of impatience, or genuinely venting quickly, got nothing
    // back with no way to know why. A one-time-per-window notice closes
    // that without amplifying the flood (shouldNotifyRateLimit caps it to
    // once — every other message in the same burst stays truly silent,
    // same as before).
    if (shouldNotifyRateLimit(waId)) {
      log("WARN", `Rate limit hit for ${waId} — sending a one-time notice, then staying silent for the rest of this window.`);
      try {
        await sendWhatsAppText(tenantId, waId, "You're sending messages a bit fast — give me a second and try again shortly.");
      } catch (err) {
        log("WARN", `Rate-limit notice failed to send to ${waId}: ${err.message}`);
      }
    } else {
      log("WARN", `Rate limit hit for ${waId} — already notified this window, dropping without replying.`);
    }
    return;
  }

  const startedAt = Date.now();
  // Ownership-aware reply capture (see whatsapp.js) — feeds Section 1.5's
  // conversation history below. A voice message's outer capture (server.js)
  // may already be running for this waId; if so, this call is a no-op and
  // we must only peek, never end/consume it — that's still the outer
  // caller's job.
  const ownsCapture = !isReplyCaptureActive(waId);
  beginReplyCapture(waId);
  const session = getSession(tenantId, waId); // always exists so history has somewhere to attach, even for STATUS/HERE

  try {
    if (/^restart$/i.test(trimmed) || /^menu$/i.test(trimmed)) {
      // Full reset: drop the in-memory session (booking flow state, selected
      // service/provider/date/time, subStage, pending confirmation/reschedule/
      // feedback state, support-attempt counter — everything) rather than
      // clearing individual fields, so nothing stale can leak into the next
      // conversation. Then immediately show a real, tappable menu of this
      // tenant's services — not just a bare "what do you need?" prompt — so
      // the customer always has a working next step, even if RESTART was
      // sent to escape a stuck/crashed state.
      //
      // Found live (via this session's own testing): deleting the session
      // and calling sendBusinessMenu directly, without a session to mark
      // awaitingBusinessPick on, meant TAPPING the very menu row this just
      // showed fell through to full AI classification instead of the
      // deterministic id-match short-circuit at the top of handleDetecting
      // — a one-word business id like "hair" got read as a factual
      // question ("what is hair service") instead of "start that
      // booking." getSession() below recreates the fresh object (same
      // shape sessions.delete()'d — nothing carries over except the
      // language pick) so the flag has somewhere to live for the very
      // next message.
      const priorLang = session?.lang;
      sessions.delete(mapKey(tenantId, waId));
      const freshSession = getSession(tenantId, waId);
      if (priorLang) freshSession.lang = priorLang;
      freshSession.awaitingBusinessPick = true;
      await sendBusinessMenu(tenantId, waId, workflows, freshSession);
      return;
    }

    // Found live: with no GROQ_API_KEY (or Groq down), "cancel" mid-booking
    // had no reliable path at all. detectGeneralIntent() — the only thing
    // that recognizes CANCEL_BOOKING as an intent — only ever runs in the
    // DETECTING stage; once a customer is RUNNING through a workflow
    // (selecting a provider/date/time, before reaching review_confirm), an
    // unmatched "cancel" only ever reached ACTIONS.CANCEL through the
    // orchestrator (planNextAction) — also a Groq call. Without one, typing
    // "cancel" mid-booking just got re-prompted as an invalid answer,
    // repeatedly, until 3 failed attempts escalated to human support.
    // restart worked as an unintentional workaround, but nothing told the
    // customer that. Hardcoded here, alongside restart/status/here, so
    // abandoning an in-progress booking never depends on AI availability —
    // same as those three already don't.
    if (/^(cancel|stop|abort)$/i.test(trimmed)) {
      const activeBookings = await bookings.activeListForCustomer(tenantId, waId);
      if (activeBookings.length > 0) {
        // A real, already-confirmed booking exists — Section 10: never
        // cancel it outright on a bare "cancel", confirm first (and
        // disambiguate if there's more than one), same flow as the
        // natural-language "cancel my appointment" path.
        await beginCancelFlow(tenantId, waId, session, workflows);
      } else if (session.stage === "RUNNING") {
        // Nothing confirmed yet — just an in-progress flow to abandon.
        // Nothing to refund or mark cancelled in the database.
        sessions.delete(mapKey(tenantId, waId));
        await sendWhatsAppText(tenantId, waId, await t(session, "❌ No problem — cancelled. Message me anytime to start a new one."));
      } else {
        await sendWhatsAppText(tenantId, waId, await t(session, "You don't have anything in progress to cancel. Message me anytime to start a new booking."));
      }
      return;
    }

    if (/^status$/i.test(trimmed)) {
      await handleStatusCommand(tenantId, waId);
      return;
    }

    if (/^here$/i.test(trimmed)) {
      await handleHereCommand(tenantId, waId);
      return;
    }

    // Section 3.5 — opt out of/back into proactive "you're next" queue
    // alerts specifically. Doesn't touch bookings, sessions, or any other
    // notification (cancellation/reschedule messages still send) — this
    // is scoped to exactly the one proactive, business-initiated ping
    // Section 3.4 introduces. Deliberately NOT tenant-scoped (see
    // queueStore.js) — a customer's alert preference is tied to their real
    // phone number, not to any one business.
    if (/^stop\s*alerts?$/i.test(trimmed)) {
      await setAlertsOptedOut(waId, true);
      await sendWhatsAppText(tenantId, waId, "Got it — you won't get \"you're next\" alerts anymore. Reply START ALERTS anytime to turn them back on.");
      return;
    }
    if (/^start\s*alerts?$/i.test(trimmed)) {
      await setAlertsOptedOut(waId, false);
      await sendWhatsAppText(tenantId, waId, "You'll get \"you're next\" alerts again.");
      return;
    }

    // Section 10 — if beginCancelFlow just asked "which one?" or "are you
    // sure?", THIS message is that answer, not a new request — checked
    // before feedback/intent detection for the same reason those are:
    // a reply that only means something in context must not get
    // misrouted by a classifier with no way to know that context applies.
    if (await resolvePendingCancel(tenantId, waId, session, trimmed, workflows)) {
      return;
    }

    // Section 4.3 — if the provider just completed this customer's most
    // recent booking and asked for feedback, THIS message is that
    // feedback, not a new booking attempt or a question. Checked here,
    // before intent detection/business classification even run, for the
    // same reason Section 1.5's conversation history exists: a reply that
    // means something specific in context must not get misrouted by a
    // classifier that has no way to know that context applies. One-shot
    // by design — clearing feedback_requested_at on capture is what makes
    // this "one nudge, then drop it" rather than treating every future
    // message as feedback forever.
    // Section 4.3 — feedback must be handled BEFORE normal intent detection.
    //
    // Do NOT use mostRecentForCustomer() here. A customer can have another
    // booking created/cancelled after the completed appointment. We specifically
    // look for the completed booking that still has feedbackRequestedAt set.

    const customerBookings = await bookings.values(tenantId);

    const pendingFeedbackBookings = customerBookings
      .filter(
        (booking) =>
          booking.waId === waId &&
          booking.status === "done" &&
          booking.feedbackRequestedAt
      )
      .sort(
        (a, b) =>
          Number(b.feedbackRequestedAt || 0) -
          Number(a.feedbackRequestedAt || 0)
      );

    const feedbackBooking = pendingFeedbackBookings[0];

    // Handle clickable WhatsApp rating selections.
    const ratingMatch = trimmed.match(/^feedback_rating_([1-5])$/i);

    // Found live: this used to capture ANY message as the feedback comment
    // whenever a completed booking had feedbackRequestedAt set — a bare
    // "hi" or "ok"/"thanks" (neither an explicit rating tap nor an exact
    // global command like RESTART/STATUS) got silently swallowed as the
    // feedback text, clearing the one-shot flag and replying "Thank you for
    // the feedback!" instead of the greeting/acknowledgment reply the
    // customer actually needed. A rating tap or real free-text feedback
    // still gets captured normally; a greeting or plain acknowledgment
    // falls through to the rest of the handler instead (GREETING_RE/
    // isPlainAcknowledgment are the same shared checks handleDetecting
    // uses, not a second hardcoded list).
    if (feedbackBooking && !ratingMatch && (GREETING_RE.test(trimmed) || isPlainAcknowledgment(trimmed))) {
      // fall through — not feedback, handle as a normal message below
    } else if (feedbackBooking) {
      let rating = null;
      let feedbackText = trimmed;

      if (ratingMatch) {
        rating = Number(ratingMatch[1]);
        feedbackText = String(rating);
      }

      await feedbackStore.create(
        tenantId,
        feedbackBooking.id,
        feedbackBooking.workflowId,
        waId,
        feedbackText
      );

      // Make the feedback request one-shot.
      await bookings.clearFeedbackRequest(
        tenantId,
        feedbackBooking.id
      );

      log(
        "INFO",
        `Feedback captured for booking ${feedbackBooking.bookingId}: rating=${rating || "none"}, comment="${feedbackText}"`
      );

      dashboardEvents.publish(
        tenantId,
        "feedback.created",
        {
          workflowId: feedbackBooking.workflowId,
          providerId: feedbackBooking.providerId,
          bookingId: feedbackBooking.bookingId,
          rating,
          comment: feedbackText
        }
      );

      if (rating) {
        await sendWhatsAppText(
          tenantId,
          waId,
          `Thank you for your ${rating}/5 rating! 🙏`
        );
      } else {
        await sendWhatsAppText(
          tenantId,
          waId,
          "Thank you for the feedback! 🙏"
        );
      }

      return;
    }

    log("INFO", `Message from ${waId} [tenant=${tenantId}, stage=${session.stage}]: "${trimmed}"`);

    if (session.stage === "DETECTING") {
      await handleDetecting(tenantId, waId, session, trimmed, workflows);
      return;
    }

    if (session.stage === "RUNNING") {
      await handleRunning(tenantId, waId, session, trimmed, workflows);
    }
  } finally {
    const replyText = ownsCapture ? endReplyCapture(waId) : peekReplyCapture(waId);
    // Don't resurrect a session "restart"/cancel/completed-booking just
    // deleted — no history to remember across an intentional reset.
    if (sessions.has(mapKey(tenantId, waId))) recordHistoryTurn(session, trimmed, replyText);

    await persist(tenantId, waId);
    const elapsedMs = Date.now() - startedAt;
    recordResponseTime(elapsedMs);
    log("INFO", `Reply cycle for ${waId} took ${elapsedMs}ms`);
  }
}

// Found live: processMessage() mutates the shared `session` object (e.g.
// `session.stepIndex += 1`) synchronously before its first `await`. Two
// messages arriving close together for the SAME customer — a rapid
// double-tap, or WhatsApp's own at-least-once delivery retrying while the
// first attempt is still mid-flight — read/write that same in-memory
// object with no lock between them, which reproduced as a crash (a second
// concurrent "confirm" reading `session.stepIndex` after the first had
// already advanced it past the end of the workflow) and is a live
// double-booking risk on other interleavings, not just a crash. This
// chains each (tenant, waId)'s calls onto a per-conversation promise so
// they always run one at a time, start to finish — a DIFFERENT customer's
// message is never blocked by this, only same-conversation calls queue.
const processingChains = new Map();
function handleIncomingMessage(tenantId, waId, text, workflows) {
  const key = mapKey(tenantId, waId);
  const prior = processingChains.get(key) || Promise.resolve();
  const next = prior.catch(() => { }).then(() => processMessage(tenantId, waId, text, workflows));
  processingChains.set(key, next.catch(() => { }));
  return next;
}

module.exports = { handleIncomingMessage, suggestSpecialtyProvider, resolvePaymentRequirement, getAvailableSlots, initSessions };
