const { log } = require("./logger");

function credentials() {
  return { token: process.env.WHATSAPP_TOKEN, phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID };
}

// Voice-reply capture. When a customer sends a voice note we want to speak
// the reply back — but the reply text is produced deep inside
// workflowEngine, across a dozen send call sites. Rather than thread a
// "speak this" flag through all of them (and risk touching booking logic
// for a presentation concern), the webhook switches capture on for that
// one waId, lets the engine run completely unchanged, then synthesizes
// whatever text was sent. Keyed by waId so two concurrent conversations
// can't collect each other's replies.
const replyCaptures = new Map(); // waId -> string[]

function beginReplyCapture(waId) {
  replyCaptures.set(waId, []);
}

function endReplyCapture(waId) {
  const captured = replyCaptures.get(waId) || [];
  replyCaptures.delete(waId);
  return captured.join("\n\n");
}

function captureReply(to, body) {
  const bucket = replyCaptures.get(to);
  if (bucket) bucket.push(body);
}

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
  } else {
    log("INFO", describeSuccess());
  }
}

// Plain text message — used for intros, free-text prompts, errors and the
// final confirmation. Falls back to logging when no WhatsApp creds are
// configured yet, so the bot can be exercised locally without a live number.
async function sendWhatsAppText(to, body) {
  const { token, phoneNumberId } = credentials();
  captureReply(to, body);

  if (!token || !phoneNumberId) {
    log("INFO", `[SIMULATED REPLY -> ${to}]\n${body}`);
    return;
  }

  await postToGraphApi(
    phoneNumberId,
    token,
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    to,
    () => `[SENT -> ${to}]\n${body}`
  );
}

// Up to 3 tappable reply buttons. `buttons` is [{ id, title }] — id is what
// comes back in the webhook payload when the customer taps it.
async function sendWhatsAppButtons(to, bodyText, buttons) {
  const { token, phoneNumberId } = credentials();
  const rendered = buttons.map((b, i) => `${i + 1}. ${b.title} [reply with: ${b.id}]`).join("\n");
  // Speak the prompt and the option titles, but not the machine-readable
  // reply ids — those are for tapping, not for listening to.
  captureReply(to, `${bodyText}\n${buttons.map((b) => b.title).join(", ")}`);

  if (!token || !phoneNumberId) {
    log("INFO", `[SIMULATED BUTTONS -> ${to}]\n${bodyText}\n${rendered}`);
    return;
  }

  await postToGraphApi(
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
async function sendWhatsAppList(to, bodyText, buttonLabel, sections) {
  const { token, phoneNumberId } = credentials();
  const rendered = sections
    .flatMap((s) => s.rows)
    .map((r, i) => `${i + 1}. ${r.title}${r.description ? " — " + r.description : ""} [reply with: ${r.id}]`)
    .join("\n");
  captureReply(to, `${bodyText}\n${sections.flatMap((s) => s.rows).map((r) => r.title).join(", ")}`);

  if (!token || !phoneNumberId) {
    log("INFO", `[SIMULATED LIST -> ${to}]\n${bodyText}\n${rendered}`);
    return;
  }

  await postToGraphApi(
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
async function sendWhatsAppAudio(to, audioBuffer, mimeType = "audio/ogg") {
  const { token, phoneNumberId } = credentials();

  if (!token || !phoneNumberId) {
    log("INFO", `[SIMULATED AUDIO -> ${to}] ${audioBuffer.length} bytes of ${mimeType}`);
    return;
  }

  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([audioBuffer], { type: mimeType }), "reply.ogg");

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

module.exports = {
  sendWhatsAppText,
  sendWhatsAppButtons,
  sendWhatsAppList,
  sendWhatsAppAudio,
  beginReplyCapture,
  endReplyCapture,
};
