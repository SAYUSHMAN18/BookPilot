const crypto = require("crypto");

// Password hashing (scrypt, built into Node — no bcrypt dependency needed)
// and signed session tokens (HMAC, hand-rolled JWT-alike) so this project's
// "no native modules, minimal deps" stance holds for auth too.

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not set. Generate one (e.g. `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`) and set it in .env before starting the server."
    );
  }
  return secret;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

// payload: { uid, email, role, workflowId, providerId }
function createSessionToken(payload) {
  const body = base64url(JSON.stringify({ ...payload, exp: Date.now() + SESSION_TTL_MS }));
  const sig = crypto.createHmac("sha256", getSessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expectedSig = crypto.createHmac("sha256", getSessionSecret()).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig || "");
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

module.exports = { hashPassword, verifyPassword, createSessionToken, verifySessionToken, SESSION_TTL_MS };
