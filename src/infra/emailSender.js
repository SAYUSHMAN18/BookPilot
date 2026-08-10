const { log } = require("./logger");

// This project has no email provider integration (no SMTP/SendGrid/SES
// credentials, no new dependency added for one) — same honest gap as the
// rest of Section 6's password-reset work: the token generation, hashing,
// expiry, and single-use enforcement (src/passwordResetStore.js) are all
// real, but the actual delivery step is currently always simulated,
// mirroring exactly how sendWhatsAppText() (src/whatsapp.js) degrades to
// logging when WHATSAPP_TOKEN isn't set. Wiring in a real provider later
// only means replacing the body of this one function — every caller
// already treats "sent" as best-effort and fire-and-forget.
async function sendEmail(to, subject, body) {
  log("INFO", `[SIMULATED EMAIL -> ${to}] ${subject}\n${body}`);
  return true;
}

module.exports = { sendEmail };
