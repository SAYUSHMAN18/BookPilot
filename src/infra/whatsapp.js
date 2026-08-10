const { log } = require("./logger");
const outboundQueueStore = require("../store/outboundQueueStore");
const tenantStore = require("../store/tenantStore");

// Section 8 — every tenant gets their own WhatsApp Business number/token
// (src/store/tenantStore.js, encrypted at rest). Falls back to the global
// WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID env vars when a tenant hasn't
// configured their own yet — in practice this is always true for the
// default tenant (id 1) on any install that existed before Section 8,
// preserving its exact previous behavior with zero reconfiguration
// required. A brand-new tenant with no WhatsApp connected yet also lands
// here, which is exactly backwards for them (it would silently borrow the
// platform operator's own number) — Section 8.6/13.4's onboarding flow is
// what's expected to set real per-tenant credentials before a tenant goes
// active; this fallback exists for upgrade continuity, not as the
// intended steady state for a second tenant.
function credentials(tenantId) {
  const tenant = tenantId ? tenantStore.getById(tenantId) : null;
  if (tenant?.whatsappAccessToken && tenant?.whatsappPhoneNumberId) {
    return { token: tenant.whatsappAccessToken, phoneNumberId: tenant.whatsappPhoneNumberId };
  }
  return { token: process.env.WHATSAPP_TOKEN, phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID };
}

// Reply capture. Two independent features read from the exact same
// stream of outbound sends: voice (speak the reply back) and Section
// 1.5's conversation history (remember what was just said so a follow-up
// like "is it for today or another day" can be resolved). Rather than
// thread a "capture this" flag through a dozen send call sites twice,
// both features share one mechanism — made idempotent/ownership-aware so
// nesting works: beginReplyCapture() is a no-op if a capture is already
// running (e.g. workflowEngine.js's own capture inside a voice message's
// outer capture), and only whichever caller actually STARTED the capture
// should end/consume it — an inner caller that didn't start it should
// peek, not delete, or it would clear the bucket out from under the
// outer caller still waiting to read it. Keyed by waId so two concurrent
// conversations can't collect each other's replies. Deliberately NOT also
// keyed by tenantId — this is purely an in-process, single-message-cycle
// buffer (not a stored table), and two different tenants' bots both
// happening to process the exact same phone number's message in the same
// synchronous tick is not a real scenario this needs to guard against.
const replyCaptures = new Map(); // waId -> string[]

function isReplyCaptureActive(waId) {
  return replyCaptures.has(waId);
}

function beginReplyCapture(waId) {
  if (!replyCaptures.has(waId)) replyCaptures.set(waId, []);
}

// Non-destructive — for a caller that did NOT start the capture and must
// leave it intact for whoever did.
function peekReplyCapture(waId) {
  return (replyCaptures.get(waId) || []).join("\n\n");
}

// Destructive — only call this if you're the one who called
// beginReplyCapture() and started it (checked via isReplyCaptureActive()
// beforehand), or you'll clear a capture an outer caller still needs.
function endReplyCapture(waId) {
  const captured = replyCaptures.get(waId) || [];
  replyCaptures.delete(waId);
  return captured.join("\n\n");
}

function captureReply(to, body) {
  const bucket = replyCaptures.get(to);
  if (bucket) bucket.push(body);
}

// Returns true/false rather than throwing — every existing call site
// treats a WhatsApp send as fire-and-forget by design (a booking
// confirmation failing to send shouldn't crash the booking flow itself),
// so changing this to throw would mean auditing and wrapping every one of
// those in try/catch. A boolean return is backward compatible (existing
// callers already ignore the return value) and is what
// sendWithRetry() below actually needs to know whether to retry.
async function postToGraphApi(phoneNumberId, token, payload, to, describeSuccess) {
  const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    log("ERROR", `Failed to send WhatsApp message to ${to}: ${resp.status} ${errText}`);
    return false;
  }
  log("INFO", describeSuccess());
  return true;
}

// Plain text message — used for intros, free-text prompts, errors and the
// final confirmation. Falls back to logging when no WhatsApp creds are
// configured yet, so the bot can be exercised locally without a live number.
async function sendWhatsAppText(tenantId, to, body) {
  const { token, phoneNumberId } = credentials(tenantId);
  captureReply(to, body);

  if (!token || !phoneNumberId) {
    log("INFO", `[SIMULATED REPLY -> ${to}]\n${body}`);
    return true;
  }

  return postToGraphApi(
    phoneNumberId,
    token,
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    to,
    () => `[SENT -> ${to}]\n${body}`
  );
}

// A provider/room photo alongside a booking confirmation — real gap found
// live (a customer transcript review): confirmations were text-only, no
// visual of the place/person they're booking, despite `photo` already
// existing on hotel rooms in workflows/hotel.json and being shown in the
// dashboard's own provider list. `link` (a hosted URL), not uploaded
// media — every photo this project uses is already a plain image URL, so
// there's no need for the separate WhatsApp media-upload flow. Caption is
// optional and capped the same way any WhatsApp text is (4096 chars is
// the platform limit; a caption is never remotely that long in practice).
async function sendWhatsAppImage(tenantId, to, imageUrl, caption) {
  const { token, phoneNumberId } = credentials(tenantId);
  if (caption) captureReply(to, caption);

  if (!token || !phoneNumberId) {
    log("INFO", `[SIMULATED IMAGE -> ${to}] ${imageUrl}${caption ? `\n${caption}` : ""}`);
    return true;
  }

  return postToGraphApi(
    phoneNumberId,
    token,
    { messaging_product: "whatsapp", to, type: "image", image: { link: imageUrl, ...(caption ? { caption } : {}) } },
    to,
    () => `[SENT IMAGE -> ${to}] ${imageUrl}`
  );
}

// Up to 3 tappable reply buttons. `buttons` is [{ id, title }] — id is what
// comes back in the webhook payload when the customer taps it.
async function sendWhatsAppButtons(tenantId, to, bodyText, buttons) {
  const { token, phoneNumberId } = credentials(tenantId);
  const rendered = buttons.map((b, i) => `${i + 1}. ${b.title} [reply with: ${b.id}]`).join("\n");
  // Speak the prompt and the option titles, but not the machine-readable
  // reply ids — those are for tapping, not for listening to.
  captureReply(to, `${bodyText}\n${buttons.map((b) => b.title).join(", ")}`);

  if (!token || !phoneNumberId) {
    log("INFO", `[SIMULATED BUTTONS -> ${to}]\n${bodyText}\n${rendered}`);
    return true;
  }

  return postToGraphApi(
    phoneNumberId,
    token,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    },
    to,
    () => `[SENT BUTTONS -> ${to}] ${buttons.length} option(s)`
  );
}

// A tappable list (up to 10 rows). `sections` is
// [{ title, rows: [{ id, title, description }] }] — id is what comes back
// in the webhook payload when the customer taps that row.
async function sendWhatsAppList(tenantId, to, bodyText, buttonLabel, sections) {
  const { token, phoneNumberId } = credentials(tenantId);
  const rendered = sections
    .flatMap((s) => s.rows)
    .map((r, i) => `${i + 1}. ${r.title}${r.description ? " — " + r.description : ""} [reply with: ${r.id}]`)
    .join("\n");
  captureReply(to, `${bodyText}\n${sections.flatMap((s) => s.rows).map((r) => r.title).join(", ")}`);

  if (!token || !phoneNumberId) {
    log("INFO", `[SIMULATED LIST -> ${to}]\n${bodyText}\n${rendered}`);
    return true;
  }

  return postToGraphApi(
    phoneNumberId,
    token,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: sections.map((s) => ({
            title: s.title?.slice(0, 24),
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              description: r.description?.slice(0, 72),
            })),
          })),
        },
      },
    },
    to,
    () => `[SENT LIST -> ${to}] ${sections.flatMap((s) => s.rows).length} option(s)`
  );
}

// Sends a spoken reply. WhatsApp needs the audio uploaded to its own
// media endpoint first (two hops), then referenced by the returned id.
// Best-effort by design: every caller ALSO sends the text version, so a
// failure here degrades to text rather than losing the reply entirely.
async function sendWhatsAppAudio(tenantId, to, audioBuffer, mimeType = "audio/ogg") {
  const { token, phoneNumberId } = credentials(tenantId);

  if (!token || !phoneNumberId) {
    log("INFO", `[SIMULATED AUDIO -> ${to}] ${audioBuffer.length} bytes of ${mimeType}`);
    return;
  }

  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    const extension = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("opus") ? "opus" : "ogg";
    form.append("file", new Blob([audioBuffer], { type: mimeType }), `reply.${extension}`);

    const uploadResp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!uploadResp.ok) {
      log("ERROR", `Audio upload failed for ${to}: ${uploadResp.status} ${(await uploadResp.text()).slice(0, 200)}`);
      return;
    }
    const { id } = await uploadResp.json();

    await postToGraphApi(
      phoneNumberId,
      token,
      { messaging_product: "whatsapp", to, type: "audio", audio: { id } },
      to,
      () => `[SENT AUDIO -> ${to}] ${audioBuffer.length} bytes`
    );
  } catch (err) {
    log("ERROR", `Failed to send audio to ${to}: ${err.message}`);
  }
}

// Marks the incoming message read and shows the typing indicator, in one
// call — sent immediately on webhook receipt, before any AI call starts,
// so the customer gets instant feedback during the 1-2s processing
// window instead of silence. Best-effort: a failure here is never worth
// blocking or delaying the actual reply over.
async function sendTypingIndicator(tenantId, messageId) {
  const { token, phoneNumberId } = credentials(tenantId);
  if (!token || !phoneNumberId) return; // nothing to show in simulated/dev mode

  try {
    const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    });
    if (!resp.ok) log("WARN", `Typing indicator failed: ${resp.status} ${(await resp.text()).slice(0, 150)}`);
  } catch (err) {
    log("WARN", `Typing indicator request failed: ${err.message}`);
  }
}

// Fast-path immediate retry (a couple of attempts, seconds apart) for a
// proactive text send, falling back to the durable queue (Section 5.3,
// src/store/outboundQueueStore.js) on final failure — that queue survives a
// restart, where this function's own retry loop does not: it's a local
// variable in one call, gone the moment the process exits. Text-only by
// design (arrival alerts, cancellation/reschedule/completion notices are
// the only proactive business-initiated sends this project makes) —
// there's no equivalent durable path for buttons/lists, which only ever
// get sent in direct response to a customer's own message anyway.
async function sendWithRetry(tenantId, waId, body, { retries = 1, delayMs = 2000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let ok;
    let thrown;
    try {
      // sendWhatsAppText returns false on a failed API call rather than
      // throwing (see postToGraphApi above) — check both a falsy return
      // AND a genuine thrown error (e.g. fetch() itself rejecting on a
      // network-level failure, not just a non-OK response).
      ok = await sendWhatsAppText(tenantId, waId, body);
    } catch (err) {
      thrown = err;
      ok = false;
    }
    if (ok) return true;
    if (attempt === retries) {
      log("WARN", `Send failed after ${retries + 1} immediate attempt(s), queuing for durable retry.${thrown ? ` (${thrown.message})` : ""}`);
      outboundQueueStore.enqueue(tenantId, waId, body);
      return false;
    }
    log("WARN", `Send failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delayMs}ms.${thrown ? ` (${thrown.message})` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

// Drains everything currently due in the durable queue — a message
// sendWithRetry() gave up on after its own immediate attempts. Each item
// gets exactly one attempt per pass; a failure here reschedules it via
// markFailedAttempt()'s backoff rather than looping/retrying inline, so
// one stuck recipient can't delay the other 19 due items behind it.
// Deliberately drains ACROSS every tenant in one pass (outboundQueueStore
// .dueItems() is intentionally unfiltered — see its own comment) rather
// than one worker loop per tenant: each item already carries its own
// tenantId, so sendWhatsAppText picks the right credentials per item
// without needing N separate timers for N tenants.
async function processOutboundQueue() {
  const items = outboundQueueStore.dueItems();
  for (const item of items) {
    let ok;
    let thrown;
    try {
      ok = await sendWhatsAppText(item.tenantId, item.waId, item.body);
    } catch (err) {
      thrown = err;
      ok = false;
    }
    if (ok) {
      outboundQueueStore.markSent(item.id);
      log("INFO", `Durable retry delivered queued message ${item.id} to ${item.waId} (tenant ${item.tenantId}).`);
    } else {
      const message = thrown ? thrown.message : "send returned false";
      outboundQueueStore.markFailedAttempt(item, message);
      log("WARN", `Durable retry attempt ${item.attempts + 1}/${item.maxAttempts} failed for queued message ${item.id} to ${item.waId} (tenant ${item.tenantId}): ${message}`);
    }
  }
  return items.length;
}

// Polls the durable queue on an interval — mirrors backupStore.js's
// scheduleBackups() pattern. .unref()'d so a pending timer never keeps
// the process alive on its own (tests and graceful shutdown both rely
// on this).
function startOutboundQueueWorker(intervalMs = 60_000) {
  const timer = setInterval(() => {
    processOutboundQueue().catch((err) => log("ERROR", `Outbound queue worker pass threw: ${err.message}`));
  }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  sendWhatsAppText,
  sendWhatsAppImage,
  sendWhatsAppButtons,
  sendWhatsAppList,
  sendWhatsAppAudio,
  sendTypingIndicator,
  sendWithRetry,
  isReplyCaptureActive,
  beginReplyCapture,
  peekReplyCapture,
  endReplyCapture,
  processOutboundQueue,
  startOutboundQueueWorker,
};
