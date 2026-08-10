const crypto = require("crypto");

// Section 8.3 introduces the first real secret stored in the DB itself
// (a tenant's WhatsApp access token) rather than in `.env` — Section
// 12.3 is where the plan formally scopes "encrypt secrets at rest," but
// there's no reason to knowingly write a plaintext token into a new
// column today and call it a TODO for later. AES-256-GCM via Node's
// built-in crypto (no new dependency, same "no native modules" stance as
// password hashing/session signing in src/infra/auth.js). A single
// app-level key from the environment, not per-tenant keys — matching
// what Section 12.3 itself specifies ("a single app-level encryption
// key... not per-tenant keys unless the plan already calls for
// per-tenant key management," which it doesn't).
const ALGORITHM = "aes-256-gcm";

function getKey() {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "APP_ENCRYPTION_KEY is not set. Generate one (e.g. `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`) and set it in .env before storing any tenant secret."
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must be a 32-byte value, hex-encoded (64 hex characters).");
  }
  return key;
}

// Returns null for null/undefined input (a tenant with no WhatsApp token
// configured yet, e.g. still in onboarding) rather than encrypting an
// empty string — callers can check for null the same way they'd check
// for an absent value anywhere else in this codebase.
function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM's recommended IV length
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv:authTag:ciphertext, all hex — one column, self-contained, same
  // "salt:hash" shape convention as hashPassword() in src/infra/auth.js.
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptSecret(stored) {
  if (!stored) return null;
  const [ivHex, authTagHex, dataHex] = String(stored).split(":");
  if (!ivHex || !authTagHex || !dataHex) return null;
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}

module.exports = { encryptSecret, decryptSecret };
