const crypto = require("crypto");

// Section 10.2 — the `state` parameter every OAuth 2.0 authorization
// request carries through to its callback. Two jobs: (1) CSRF protection
// (an attacker can't forge a callback that links THEIR Google Calendar to
// someone else's booking business, since they can't produce a validly-
// signed state), and (2) carrying which (tenant, workflow, provider) this
// connection is for across the redirect to Google and back, since that
// context has to survive an external hop the session cookie alone
// wouldn't reliably preserve. Same hand-rolled HMAC-over-base64url-JSON
// shape as src/infra/auth.js's session tokens — reusing SESSION_SECRET
// rather than requiring yet another dedicated secret in .env.
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a real consent-screen click-through, short enough that a leaked/logged URL goes stale fast

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set — required to sign OAuth state tokens.");
  }
  return secret;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

// payload: { tenantId, workflowId, providerId }
function signOAuthState(payload) {
  const body = base64url(JSON.stringify({ ...payload, nonce: crypto.randomBytes(8).toString("hex"), exp: Date.now() + STATE_TTL_MS }));
  const sig = crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

// Returns the payload if the state is validly signed and unexpired, null otherwise.
// Never throws — a forged/expired/malformed state is a normal occurrence
// (a stale bookmarked callback URL, a tampered query string), not a crash.
function verifyOAuthState(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  let expectedSig;
  try {
    expectedSig = crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
  } catch {
    return null;
  }
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

module.exports = { signOAuthState, verifyOAuthState };
