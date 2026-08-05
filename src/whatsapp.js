const { log } = require("./logger");

function credentials() {
  return { token: process.env.WHATSAPP_TOKEN, phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID };
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

module.exports = { sendWhatsAppText, sendWhatsAppButtons, sendWhatsAppList };
