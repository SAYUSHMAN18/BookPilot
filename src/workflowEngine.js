const { log } = require("./logger");
const { sendWhatsAppText, sendWhatsAppButtons, sendWhatsAppList } = require("./whatsapp");
const { classifyBusiness } = require("./classify");
const { loadSessions, saveSessions } = require("./sessionStore");
const bookings = require("./bookingStore"); // SQLite-backed — see src/db.js
const { SlotTakenError } = bookings;
const { dateOptions, timeSlotsFor, parseFlexibleDate, isoDate, parseIsoDate, formatLongDate } = require("./dateSlots");
const { extractContext } = require("./extractContext");
const { isRateLimited } = require("./rateLimit");
const { isDayBlocked, blockedTimesForDay } = require("./availabilityStore");
const { tryAnswerFactually } = require("./factualQA");
const { planNextAction, ACTIONS } = require("./orchestrator");
const { detectGeneralIntent, INTENTS } = require("./intentDetector");

// One state machine per WhatsApp sender. This is intentionally generic —
// it has no idea what "medical" or "hotel" mean. It only knows how to walk
// a workflow's `steps` array, which is why adding a new business is a
// config change, not a code change. Sessions are persisted to disk after
// every message so a server restart doesn't drop in-progress bookings.
// Bookings (the data that needs real double-booking protection) live in
// SQLite instead — see src/bookingStore.js.
const sessions = loadSessions();

function persist() {
  saveSessions(sessions);
}

function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, {
      stage: "DETECTING", // DETECTING -> RUNNING -> (reset)
      workflowId: null,
      stepIndex: 0,
      selectedProvider: null,
      selectedHotel: null,
      data: {},
      awaitingBusinessPick: false,
      subStage: null,
      supportAttempts: 0,
    });
  }
  return sessions.get(waId);
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
function bookingsForProvider(workflowId, providerId) {
  return [...bookings.values()].filter((b) => b.workflowId === workflowId && b.providerId === providerId && b.status !== "cancelled");
}

function takenSlotsFor(workflowId, providerId, dateIso) {
  const taken = new Set();
  for (const b of bookingsForProvider(workflowId, providerId)) {
    if (b.visitDate === dateIso && b.visitTime) taken.add(b.visitTime);
  }
  return taken;
}

function hasDateRangeConflict(workflowId, providerId, checkIn, nights) {
  const checkOut = new Date(checkIn.getTime() + nights * 24 * 60 * 60 * 1000);
  for (const b of bookingsForProvider(workflowId, providerId)) {
    if (!b.checkInIso || !b.nights) continue;
    const existingIn = parseIsoDate(b.checkInIso);
    const existingOut = new Date(existingIn.getTime() + b.nights * 24 * 60 * 60 * 1000);
    if (checkIn < existingOut && existingIn < checkOut) return true;
  }
  return false;
}

// Shown when we genuinely can't tell what the customer wants (a greeting,
// small talk, or anything that doesn't match a business) — a clickable menu
// beats silently guessing a workflow.
async function sendBusinessMenu(waId, workflows) {
  const sections = [
    {
      title: "Services",
      rows: Object.values(workflows).map((w) => ({
        id: w.id,
        title: w.label,
        description: w.description,
      })),
    },
  ];
  await sendWhatsAppList(waId, "What would you like to book today?", "Choose", sections);
}

function matchWorkflowByIdOrIndex(text, workflows) {
  const ids = Object.keys(workflows);
  const byId = workflows[text];
  const byIndex = workflows[ids[parseInt(text, 10) - 1]];
  return byId || byIndex || null;
}

async function sendConfirmProviderCard(waId, workflow, step, session) {
  const body = fillTemplate(step.confirmTemplate, session, workflow);
  await sendWhatsAppButtons(waId, body, [
    { id: "continue", title: "✅ Continue" },
    { id: "choose_another", title: "🔁 Choose Another" },
  ]);
}

// Sends the prompt for a step as a tappable WhatsApp UI element where
// possible, falling back to plain text for free-text fields.
async function sendStepPrompt(waId, workflow, step, session) {
  const prompt = fillTemplate(step.prompt, session, workflow);

  if (step.type === "select_provider") {
    const sections = [
      {
        title: "Options",
        rows: workflow.providers.map((p) => ({
          id: p.id,
          title: p.name,
          description: workflow.providerRowDescription || workflow.providerListItem
            ? fillTemplate(workflow.providerRowDescription || workflow.providerListItem, { data: {}, selectedProvider: p })
            : describeEntity(p),
        })),
      },
    ];
    await sendWhatsAppList(waId, `${prompt} (Reply "restart" anytime to start over.)`, "Choose", sections);
    return;
  }

  if (step.type === "select_hotel") {
    const sections = [
      {
        title: "Hotels",
        rows: workflow.hotels.map((h) => ({
          id: h.id,
          title: h.name,
          description: [h.location, h.rating].filter(Boolean).join(" · "),
        })),
      },
    ];
    await sendWhatsAppList(waId, `${prompt} (Reply "restart" anytime to start over.)`, "Choose", sections);
    return;
  }

  if (step.type === "select_room") {
    const rooms = session.selectedHotel?.rooms || [];
    const sections = [
      {
        title: "Rooms",
        rows: rooms.map((r) => ({
          id: r.id,
          title: r.name,
          description: workflow.providerRowDescription || workflow.providerListItem
            ? fillTemplate(workflow.providerRowDescription || workflow.providerListItem, { data: {}, selectedProvider: r })
            : describeEntity(r),
        })),
      },
    ];
    await sendWhatsAppList(waId, prompt, "Choose", sections);
    return;
  }

  if (step.type === "select_option") {
    if (step.options.length <= 3) {
      await sendWhatsAppButtons(
        waId,
        prompt,
        step.options.map((o) => ({ id: o, title: o }))
      );
    } else {
      const sections = [{ title: "Options", rows: step.options.map((o) => ({ id: o, title: o })) }];
      await sendWhatsAppList(waId, prompt, "Choose", sections);
    }
    return;
  }

  if (step.type === "select_date") {
    const options = dateOptions(step.days).filter((o) => !isDayBlocked(workflow.id, session.selectedProvider?.id, o.iso));
    const sections = [{ title: "Dates", rows: options.map((o) => ({ id: o.id, title: o.title })) }];
    await sendWhatsAppList(waId, prompt, "Choose", sections);
    return;
  }

  if (step.type === "select_time_slot") {
    const dateIso = session.data[`${step.dateField}Iso`];
    const excludeSlots = takenSlotsFor(workflow.id, session.selectedProvider?.id, dateIso);
    const blocked = blockedTimesForDay(workflow.id, session.selectedProvider?.id, dateIso);
    for (const t of blocked) excludeSlots.add(t);
    const slots = timeSlotsFor(workflow, session.data[step.dateField], excludeSlots);
    if (slots.length === 0) {
      await sendWhatsAppText(waId, "No more slots available for that day. Reply \"restart\" to try a different date.");
      return;
    }
    const sections = [{ title: "Available Slots", rows: slots.map((s) => ({ id: s, title: s })) }];
    await sendWhatsAppList(waId, prompt, "Choose", sections);
    return;
  }

  if (step.type === "review_confirm") {
    const body = `${prompt}\n\n${fillTemplate(step.template, session, workflow)}`;
    await sendWhatsAppButtons(waId, body, [
      { id: "confirm", title: "✅ Confirm" },
      { id: "edit", title: "✏️ Edit Details" },
      { id: "cancel", title: "❌ Cancel" },
    ]);
    return;
  }

  // text_input
  await sendWhatsAppText(waId, prompt);
}

// Processes the user's reply to the *current* step. Accepts either a tapped
// button/list id (real WhatsApp) or plain text/number (curl testing via
// /api/simulate-whatsapp). Returns an error string to re-prompt on, or null
// if the input was accepted and the session should advance.
function applyStepInput(workflow, step, session, text) {
  if (step.type === "select_provider") {
    const byId = workflow.providers.find((p) => p.id === text);
    const byIndex = workflow.providers[parseInt(text, 10) - 1];
    const provider = byId || byIndex;
    if (!provider) return "Sorry, I didn't get that.";
    session.selectedProvider = provider;
    return null;
  }

  if (step.type === "select_hotel") {
    const byId = workflow.hotels.find((h) => h.id === text);
    const byIndex = workflow.hotels[parseInt(text, 10) - 1];
    const hotel = byId || byIndex;
    if (!hotel) return "Sorry, I didn't get that.";
    session.selectedHotel = hotel;
    return null;
  }

  if (step.type === "select_room") {
    const rooms = session.selectedHotel?.rooms || [];
    const byId = rooms.find((r) => r.id === text);
    const byIndex = rooms[parseInt(text, 10) - 1];
    const room = byId || byIndex;
    if (!room) return "Sorry, I didn't get that.";
    session.selectedProvider = room; // rooms reuse the same "provider" concept for templates/records
    return null;
  }

  if (step.type === "select_option") {
    if (step.skippable && /^(skip|none|na|n\/a|prefer not to say)$/i.test(text.trim())) {
      session.data[step.field] = "Not specified";
      return null;
    }
    const match = step.options.find((o) => o === text || o.toLowerCase() === text.toLowerCase());
    if (!match) return "Sorry, I didn't get that.";
    session.data[step.field] = match;
    return null;
  }

  if (step.type === "select_date") {
    // Must filter blocked days identically to sendStepPrompt — otherwise a
    // numeric reply ("3") indexes into a different, unfiltered list than
    // what was actually shown, silently picking the wrong day.
    const options = dateOptions(step.days).filter((o) => !isDayBlocked(workflow.id, session.selectedProvider?.id, o.iso));
    const byIdOrTitle = options.find((o) => o.id === text.toLowerCase() || o.title.toLowerCase() === text.toLowerCase());
    const byIndex = options[parseInt(text, 10) - 1];
    const match = byIdOrTitle || byIndex;
    if (!match) return "Sorry, I didn't get that.";
    session.data[step.field] = match.id;
    session.data[`${step.field}Label`] = match.label;
    session.data[`${step.field}Iso`] = match.iso;
    return null;
  }

  if (step.type === "select_time_slot") {
    const dateIso = session.data[`${step.dateField}Iso`];
    const excludeSlots = takenSlotsFor(workflow.id, session.selectedProvider?.id, dateIso);
    const blocked = blockedTimesForDay(workflow.id, session.selectedProvider?.id, dateIso);
    for (const t of blocked) excludeSlots.add(t);
    const slots = timeSlotsFor(workflow, session.data[step.dateField], excludeSlots);
    const byText = slots.find((s) => s.toLowerCase() === text.toLowerCase());
    const byIndex = slots[parseInt(text, 10) - 1];
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
function nameIsGroundedInText(originalText, name) {
  const lowerText = originalText.toLowerCase();
  const words = name
    .toLowerCase()
    .split(/[\s.&]+/)
    .filter((w) => w.length >= 3 && !["the", "and"].includes(w));
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
    if (match && nameIsGroundedInText(originalText, match.name)) {
      session.selectedProvider = match;
      return match.name;
    }
  }

  if (step.type === "select_hotel" && extracted.providerName) {
    const hint = String(extracted.providerName).toLowerCase();
    const match = workflow.hotels.find((h) => h.name.toLowerCase() === hint || hint.includes(h.name.toLowerCase()));
    if (match && nameIsGroundedInText(originalText, match.name)) {
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

async function beginWorkflow(waId, session, workflowId, workflows, originalText) {
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

  await sendWhatsAppText(waId, `Got it! Based on your message, it looks like you need ${workflow.matchLabel}.`);

  const extracted = await extractContext(originalText, workflow);
  const filled = autoFillFromContext(session, workflow, extracted, originalText || "");
  if (filled.length > 0) {
    await sendWhatsAppText(waId, `And I've already noted: ${filled.join(", ")} — no need to repeat that.`);
  }

  const step = currentStep(workflow, session);
  if (session.subStage === "CONFIRM_PROVIDER") {
    await sendConfirmProviderCard(waId, workflow, step, session);
  } else {
    await sendStepPrompt(waId, workflow, step, session);
  }
}

function generateBookingId(workflow, session) {
  if (workflow.bookingIdPrefix) {
    const dateIso = session.data.visitDateIso || session.data.checkInDateIso || new Date().toISOString().slice(0, 10);
    const datePart = dateIso.replace(/-/g, "");
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${workflow.bookingIdPrefix}-${datePart}-${rand}`;
  }
  return `BK-${Date.now()}`;
}

function recordBooking(waId, workflow, session) {
  // .create() always inserts a new row — a customer's Nth booking never
  // overwrites their (N-1)th (real gap, previously an upsert-by-wa_id).
  bookings.create(waId, {
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
    status: "booked", // booked | arrived | cancelled
    createdAt: Date.now(),
  });
}

// Re-verifies availability right before finalizing — the offered slot/room
// could have been taken by someone else in the time since it was shown
// (two customers mid-flow at once). Returns true if it rejected the booking
// and re-prompted; the caller should stop in that case.
async function rejectIfSlotUnavailable(waId, session, workflow) {
  const slotStep = workflow.steps.find((s) => s.type === "select_time_slot");
  if (!slotStep) return false;

  const dateIso = session.data[`${slotStep.dateField}Iso`];
  const taken = takenSlotsFor(workflow.id, session.selectedProvider?.id, dateIso);
  const blocked = blockedTimesForDay(workflow.id, session.selectedProvider?.id, dateIso);
  const chosenSlot = session.data[slotStep.field];
  if (taken.has(chosenSlot) || blocked.has(chosenSlot)) {
    session.stepIndex = workflow.steps.indexOf(slotStep);
    await sendWhatsAppText(waId, "Sorry, that slot was just taken by someone else. Please pick another time.");
    await sendStepPrompt(waId, workflow, slotStep, session);
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
async function rejectIfDateRangeInvalid(waId, session, workflow) {
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
    await sendWhatsAppText(waId, 'Sorry, I couldn\'t understand that check-in date. Please try again.');
    await sendStepPrompt(waId, workflow, currentStep(workflow, session), session);
    return true;
  }

  const nights = parseInt(session.data[nightsField], 10);
  if (!nights || nights < 1) {
    const nightsStepIdx = workflow.steps.findIndex((s) => s.field === nightsField);
    session.stepIndex = nightsStepIdx >= 0 ? nightsStepIdx : session.stepIndex;
    await sendWhatsAppText(waId, "Please enter a valid number of nights.");
    await sendStepPrompt(waId, workflow, currentStep(workflow, session), session);
    return true;
  }

  session.data[`${startField}Iso`] = isoDate(parsedStart);
  session.data[`${startField}Label`] = formatLongDate(parsedStart);

  if (hasDateRangeConflict(workflow.id, session.selectedProvider?.id, parsedStart, nights)) {
    session.stepIndex = startStepIdx >= 0 ? startStepIdx : session.stepIndex;
    await sendWhatsAppText(
      waId,
      `Sorry, ${session.selectedProvider?.name || "that room"} is already booked for part of that period. Please choose a different date.`
    );
    await sendStepPrompt(waId, workflow, currentStep(workflow, session), session);
    return true;
  }

  return false;
}

async function advanceOrFinish(waId, session, workflow) {
  const justAnsweredStep = currentStep(workflow, session);
  session.stepIndex += 1;
  session.subStage = null;

  if (workflow.dateRangeAvailability && justAnsweredStep.field === workflow.dateRangeAvailability.nightsField) {
    if (await rejectIfDateRangeInvalid(waId, session, workflow)) return;
  }

  if (session.stepIndex < workflow.steps.length) {
    await sendStepPrompt(waId, workflow, currentStep(workflow, session), session);
    return;
  }

  if (await rejectIfSlotUnavailable(waId, session, workflow)) return;

  session.bookingId = generateBookingId(workflow, session);
  session.bookingCode = Math.random().toString(36).slice(2, 6).toUpperCase();

  try {
    recordBooking(waId, workflow, session);
  } catch (err) {
    // The DB's own UNIQUE index is the authoritative check for time-slot
    // bookings — it can catch a genuine race the JS pre-check in
    // rejectIfSlotUnavailable missed (two requests landing back-to-back with
    // no await between them). Hotel date-range conflicts aren't covered by
    // this index, so this only ever fires for select_time_slot workflows.
    if (err instanceof SlotTakenError) {
      const slotStep = workflow.steps.find((s) => s.type === "select_time_slot");
      session.stepIndex = slotStep ? workflow.steps.indexOf(slotStep) : session.stepIndex;
      await sendWhatsAppText(waId, "Sorry, that slot was just taken by someone else. Please pick another time.");
      if (slotStep) await sendStepPrompt(waId, workflow, slotStep, session);
      return;
    }
    throw err;
  }

  log(
    "INFO",
    `Booking confirmed: ${session.bookingId} [${workflow.id}] provider=${session.selectedProvider?.name} data=${JSON.stringify(session.data)}`
  );
  await sendWhatsAppText(waId, fillTemplate(workflow.confirmationTemplate, session, workflow));
  sessions.delete(waId); // ready for a fresh requirement next time
}

// cancelActiveBooking — shared helper used by every cancel code path so
// the DB row is always marked cancelled, not just the in-memory session.
// Safe to call even when there is no active booking (no-op in that case).
function cancelActiveBooking(waId) {
  const booking = bookings.activeForCustomer(waId);
  if (booking) bookings.updateStatus(booking.id, "cancelled");
}

async function handleDetecting(waId, session, trimmed, workflows) {
  // Short-circuit: if we already showed the business menu and the customer
  // is directly tapping/typing a workflow id from it, skip the full intent
  // classification loop — they've already answered the question.
  if (session.awaitingBusinessPick) {
    const picked = matchWorkflowByIdOrIndex(trimmed, workflows);
    if (picked) {
      await beginWorkflow(waId, session, picked.id, workflows, trimmed);
      return;
    }
  }

  // Universal intent layer — understand what the customer MEANS regardless
  // of exact phrasing. This replaces the old SUPPORT_REQUEST_RE /
  // ALREADY_BOOKED_RE regex block which silently failed for anything
  // slightly off (e.g. "CANCEL THAT" was misrouted to a hair booking).
  const hasActive = bookings.hasActive(waId);
  const intent = await detectGeneralIntent(trimmed, hasActive);

  if (intent === INTENTS.CANCEL_BOOKING) {
    if (hasActive) {
      cancelActiveBooking(waId);
      sessions.delete(waId);
      await sendWhatsAppText(
        waId,
        "❌ Done — your booking has been cancelled. Message me anytime if you'd like to make a new one."
      );
    } else {
      await sendWhatsAppText(
        waId,
        "You don't have any active booking to cancel. Would you like to make a new booking? Here's what we offer:"
      );
      session.awaitingBusinessPick = true;
      await sendBusinessMenu(waId, workflows);
    }
    return;
  }

  if (intent === INTENTS.CHECK_STATUS) {
    await handleStatusCommand(waId);
    return;
  }

  if (intent === INTENTS.RESTART) {
    sessions.delete(waId);
    await sendWhatsAppText(waId, "🔄 Starting fresh. What would you like to book?");
    // Refresh session so subsequent logic has a clean state
    const fresh = getSession(waId);
    fresh.awaitingBusinessPick = true;
    await sendBusinessMenu(waId, workflows);
    return;
  }

  if (intent === INTENTS.QUESTION) {
    // Try to answer factually first; if we can't, show the menu anyway.
    const factualAnswer = await tryAnswerFactually(trimmed, workflows);
    if (factualAnswer) {
      await sendWhatsAppText(waId, factualAnswer);
    } else {
      session.awaitingBusinessPick = true;
      if (hasActive) {
        await sendWhatsAppText(waId, "I don't have an answer for that — but I can help you book something. Here's what we offer:");
      }
      await sendBusinessMenu(waId, workflows);
    }
    return;
  }

  if (intent === INTENTS.COMPLAINT) {
    session.supportAttempts = (session.supportAttempts || 0) + 1;
    if (session.supportAttempts < 2) {
      await sendWhatsAppText(
        waId,
        "I'm sorry to hear that — I want to make this right. I'm an automated booking assistant, so let me know what you'd like to book and I'll sort it out quickly. Or reply STATUS to check an existing booking."
      );
    } else {
      await sendWhatsAppText(
        waId,
        "I apologise for the trouble. I'm an automated assistant and can't escalate to a human here, but I can help you book, check your booking status (reply STATUS), or cancel a booking. What would you like to do?"
      );
    }
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
    const factualAnswer = await tryAnswerFactually(trimmed, workflows);
    if (factualAnswer) {
      await sendWhatsAppText(waId, factualAnswer);
      return;
    }

    session.awaitingBusinessPick = true;
    if (hasActive) {
      await sendWhatsAppText(waId, "Looks like you already have a booking with us — reply STATUS anytime to check it. If you'd like to book something else too, here's what we offer:");
    }
    await sendBusinessMenu(waId, workflows);
    return;
  }

  await beginWorkflow(waId, session, workflowId, workflows, trimmed);
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

async function handleRunning(waId, session, trimmed, workflows) {
  const workflow = workflows[session.workflowId];
  const step = currentStep(workflow, session);

  if (session.subStage === "CONFIRM_PROVIDER") {
    const choice = normalizeConfirmProviderChoice(trimmed);
    if (choice === "continue") {
      session.subStage = null;
      await advanceOrFinish(waId, session, workflow);
      return;
    }
    if (choice === "choose_another") {
      session.subStage = null;
      session.selectedProvider = null;
      await sendStepPrompt(waId, workflow, step, session);
      return;
    }
    await sendWhatsAppText(waId, "Please tap Continue or Choose Another.");
    await sendConfirmProviderCard(waId, workflow, step, session);
    return;
  }

  if (step.type === "review_confirm") {
    const choice = normalizeReviewChoice(trimmed);
    if (choice === "confirm") {
      await advanceOrFinish(waId, session, workflow);
      return;
    }
    if (choice === "edit") {
      // Jumps back to whichever step is marked editTarget: true in the
      // workflow config — the first of the customer-detail steps, so
      // editing re-walks all of them (name/age/gender/reason) cleanly.
      const editIdx = workflow.steps.findIndex((s) => s.editTarget);
      session.stepIndex = editIdx >= 0 ? editIdx : session.stepIndex;
      await sendStepPrompt(waId, workflow, currentStep(workflow, session), session);
      return;
    }
    if (choice === "cancel") {
      cancelActiveBooking(waId); // persist the cancellation to the DB
      sessions.delete(waId);
      await sendWhatsAppText(waId, "❌ Booking cancelled. Send a message anytime to start a new one.");
      return;
    }
    await sendWhatsAppText(waId, "Please tap Confirm, Edit Details, or Cancel.");
    await sendStepPrompt(waId, workflow, step, session);
    return;
  }

  const error = applyStepInput(workflow, step, session, trimmed);

  if (!error) {
    if (step.type === "select_provider" && step.confirmCard) {
      session.subStage = "CONFIRM_PROVIDER";
      await sendConfirmProviderCard(waId, workflow, step, session);
      return;
    }
    await advanceOrFinish(waId, session, workflow);
    return;
  }

  // Free text didn't match the current step. Before just re-showing the
  // same prompt, check if it actually reads like a request for a different
  // business (e.g. typing "doctor" while stuck picking a hair stylist) —
  // if so, switch them over instead of trapping them in a loop.
  if (RECLASSIFIABLE_STEP_TYPES.includes(step.type)) {
    const { workflowId: reclassified } = await classifyBusiness(trimmed, workflows);
    if (reclassified && reclassified !== session.workflowId) {
      log("INFO", `Mid-flow switch: "${trimmed}" looked like a request for "${reclassified}" instead.`);
      await sendWhatsAppText(waId, `Looks like you're after ${workflows[reclassified].matchLabel} instead — switching you over.`);
      await beginWorkflow(waId, session, reclassified, workflows, trimmed);
      return;
    }
  }

  // Still unmatched — let the orchestrator decide what the customer
  // actually wanted (change an earlier answer, ask a question, bail out)
  // rather than repeating "invalid input" at them indefinitely. It only
  // ever picks a navigation intent; the engine below still performs the
  // action, so validation and slot locking are unaffected.
  if (await runOrchestratedRecovery(waId, session, workflow, trimmed, workflows)) return;

  await sendWhatsAppText(waId, error);
  await sendStepPrompt(waId, workflow, step, session);
}

// Executes whatever the orchestrator planned. Returns true if it handled
// the message, false to fall through to the normal "invalid input" reply.
async function runOrchestratedRecovery(waId, session, workflow, trimmed, workflows) {
  const plan = await planNextAction(trimmed, workflow, session);
  if (!plan || plan.action === ACTIONS.RETRY_STEP) return false;

  log("INFO", `Orchestrator planned "${plan.action}"${plan.stepIndex !== undefined ? ` -> step ${plan.stepIndex}` : ""} for "${trimmed}"`);

  if (plan.action === ACTIONS.CANCEL) {
    cancelActiveBooking(waId); // persist the cancellation to the DB before clearing the session
    sessions.delete(waId);
    await sendWhatsAppText(waId, "❌ No problem — I've cancelled that booking. Message me anytime to start a new one.");
    return true;
  }

  if (plan.action === ACTIONS.RESTART) {
    sessions.delete(waId);
    await sendWhatsAppText(waId, "🔄 Starting fresh. What would you like to book?");
    return true;
  }

  if (plan.action === ACTIONS.HUMAN) {
    await sendWhatsAppText(
      waId,
      "I'm an automated booking assistant, so I can't transfer you to a person — but I can finish this booking for you. " +
        'If you\'d rather not continue, reply "cancel".'
    );
    await sendStepPrompt(waId, workflow, currentStep(workflow, session), session);
    return true;
  }

  if (plan.action === ACTIONS.ANSWER_QUESTION) {
    const answer = await tryAnswerFactually(trimmed, workflows);
    if (!answer) return false; // nothing grounded to say — don't invent one
    await sendWhatsAppText(waId, answer);
    await sendStepPrompt(waId, workflow, currentStep(workflow, session), session);
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
    await sendWhatsAppText(waId, "Sure — let's change that.");
    await sendStepPrompt(waId, workflow, target, session);
    return true;
  }

  return false;
}

async function handleStatusCommand(waId) {
  const booking = bookings.activeForCustomer(waId);
  if (!booking) {
    await sendWhatsAppText(waId, "No active booking found. Send a message anytime describing what you'd like to book.");
    return;
  }

  // Hotel-style booking (a date range, not a single time slot).
  if (booking.checkInIso) {
    const checkOut = new Date(parseIsoDate(booking.checkInIso).getTime() + (booking.nights || 1) * 24 * 60 * 60 * 1000);
    await sendWhatsAppText(
      waId,
      `🏨 ${booking.hotelName || ""} — ${booking.providerName}\nCheck-in: ${booking.checkInIso}\nCheck-out: ${isoDate(checkOut)}\n🧾 Booking ID: ${booking.bookingId}`
    );
    return;
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  if (booking.visitDate && booking.visitDate !== todayIso) {
    await sendWhatsAppText(
      waId,
      `Your next appointment is on ${booking.visitDateLabel || booking.visitDate} at ${booking.visitTime} with ${booking.providerName}. Reply HERE when you arrive on the day.`
    );
    return;
  }

  if (booking.status === "arrived") {
    await sendWhatsAppText(waId, `You're checked in for your ${booking.visitTime} appointment with ${booking.providerName}. Please wait to be called.`);
    return;
  }

  // A real (not fabricated) count: other bookings for the same provider and
  // day, made earlier, that haven't been cancelled. It's an approximation —
  // it doesn't know about walk-ins, no-shows, or actual consult duration.
  const ahead = bookingsForProvider(booking.workflowId, booking.providerId).filter(
    (b) => b.visitDate === booking.visitDate && b.createdAt < booking.createdAt
  ).length;

  await sendWhatsAppText(
    waId,
    `📍 Appointment: ${booking.visitTime} with ${booking.providerName}\n🧾 Booking ID: ${booking.bookingId}\n\nYou're approximately #${ahead + 1} in line today. Reply HERE when you arrive at the clinic.`
  );
}

async function handleHereCommand(waId) {
  const booking = bookings.activeForCustomer(waId);
  if (!booking) {
    await sendWhatsAppText(waId, "No active booking found to check in.");
    return;
  }
  bookings.updateStatus(booking.id, "arrived");
  await sendWhatsAppText(waId, `✅ Marked you as arrived${booking.visitTime ? ` for your ${booking.visitTime} appointment` : ""}. Please wait to be called.`);
}

async function handleIncomingMessage(waId, text, workflows) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;

  if (isRateLimited(waId)) {
    log("WARN", `Rate limit hit for ${waId} — dropping message without replying.`);
    return;
  }

  try {
    if (/^restart$/i.test(trimmed) || /^menu$/i.test(trimmed)) {
      sessions.delete(waId);
      await sendWhatsAppText(waId, "🔄 Okay, starting over. What do you need?");
      return;
    }

    if (/^status$/i.test(trimmed)) {
      await handleStatusCommand(waId);
      return;
    }

    if (/^here$/i.test(trimmed)) {
      await handleHereCommand(waId);
      return;
    }

    const session = getSession(waId);
    log("INFO", `Message from ${waId} [stage=${session.stage}]: "${trimmed}"`);

    if (session.stage === "DETECTING") {
      await handleDetecting(waId, session, trimmed, workflows);
      return;
    }

    if (session.stage === "RUNNING") {
      await handleRunning(waId, session, trimmed, workflows);
    }
  } finally {
    persist();
  }
}

module.exports = { handleIncomingMessage };
