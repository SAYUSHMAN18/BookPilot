const nodemailer = require("nodemailer");
const { log } = require("./logger");

// Email sender — uses Nodemailer when SMTP credentials are configured in .env,
// falls back to console-only logging (same simulated behaviour as before)
// when they aren't, so local dev without email still works fine.
//
// Supported .env vars:
//   EMAIL_HOST     SMTP host        (default: smtp.gmail.com)
//   EMAIL_PORT     SMTP port        (default: 587)
//   EMAIL_USER     sender address   (e.g. yourapp@gmail.com)
//   EMAIL_PASS     app password     (Gmail: generate one at myaccount.google.com/apppasswords)
//   EMAIL_FROM     "From" label     (default: "BookPilot AI <EMAIL_USER>")
//
// Gmail quick-start:
//   1. Enable 2-Step Verification on your Google account.
//   2. Go to myaccount.google.com/apppasswords → generate an App Password.
//   3. Set EMAIL_USER=youremail@gmail.com and EMAIL_PASS=<the 16-char app password>.
//   That's it — no EMAIL_HOST / EMAIL_PORT needed, the defaults handle Gmail.

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    // No credentials — stay in simulated mode
    return null;
  }

  _transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: Number(process.env.EMAIL_PORT) === 465, // true only for port 465
    auth: { user, pass },
  });

  return _transporter;
}

async function sendEmail(to, subject, body) {
  const transporter = getTransporter();

  if (!transporter) {
    // Simulated mode — OTP is visible in the server console / log file
    log("INFO", `[SIMULATED EMAIL -> ${to}] ${subject}\n${body}`);
    log("WARN", "No EMAIL_USER / EMAIL_PASS set in .env — email not actually sent. Add them to send real emails (see src/infra/emailSender.js for instructions).");
    return true;
  }

  const from = process.env.EMAIL_FROM || `BookPilot AI <${process.env.EMAIL_USER}>`;
  try {
    const info = await transporter.sendMail({ from, to, subject, text: body });
    log("INFO", `Email sent to ${to} — messageId: ${info.messageId}`);
    return true;
  } catch (err) {
    // Log but don't throw — callers treat email as best-effort/fire-and-forget
    log("ERROR", `Failed to send email to ${to}: ${err.message}`);
    return false;
  }
}

module.exports = { sendEmail };
