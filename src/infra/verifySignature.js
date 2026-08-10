const crypto = require("crypto");

// Meta signs every webhook POST body with your app secret. Verifying it
// stops randoms who discover your webhook URL from injecting fake messages.
// If WHATSAPP_APP_SECRET isn't set, verification is skipped (dev/test mode)
// — server.js logs a loud warning on startup so this doesn't go unnoticed.
function isValidSignature(rawBody, signatureHeader) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return true;
  if (!signatureHeader || !rawBody) return false;

  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);

  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

module.exports = { isValidSignature };
