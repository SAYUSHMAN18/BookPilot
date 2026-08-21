const crypto = require("crypto");

// Self-audit finding: uploaded business/provider photos (src/infra/
// uploads.js) were written to local disk under DATA_DIR — this app's own
// db.js comment already flags DATA_DIR itself as "ephemeral disk" on any
// real PaaS host (Render, Cloud Run): every uploaded photo is silently
// gone on the next deploy/restart/scale event, with no error to notice it
// by until an admin asks why their business photo disappeared.
//
// This is a minimal, hand-rolled AWS Signature Version 4 signer for a
// single PUT-object call — not the official @aws-sdk/client-s3 (a few MB,
// dozens of transitive deps, for one operation this app actually needs) —
// same "no heavy deps, hand-roll the one operation the plan calls for"
// posture as secretsEncryption.js (AES-256-GCM via Node's own crypto, not
// a KMS SDK) and src/infra/auth.js (hand-rolled password hashing, not
// bcrypt). SigV4 is a published spec, not a vendor-specific format, so
// this works unmodified against real AWS S3, Cloudflare R2, Backblaze B2,
// DigitalOcean Spaces, MinIO, or any other S3-compatible endpoint — an
// operator picks whichever one fits their budget, sets five env vars, and
// nothing else about this app's code needs to know which they chose.
//
// Same "unconfigured = current behavior, nothing silently required" stance
// as Razorpay/Groq/Calendar/LOG_DRAIN_URL/ALERT_WEBHOOK_URL elsewhere in
// this codebase: isConfigured() gates every call site in uploads.js, and
// the local-disk path (this app's original, still fully working behavior)
// is exactly what runs when these env vars are unset.

function isConfigured() {
  return !!(process.env.S3_BUCKET && process.env.S3_ENDPOINT && process.env.S3_REGION && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// AWS SigV4's own required derivation chain — each step's key is only
// ever used to sign the next, fixed literal string ("aws4_request" at the
// end), never reused for anything else. See AWS's own SigV4 documentation
// for why this exact chain (date -> region -> service -> request) is what
// scopes a signature to one specific day/region/service rather than being
// valid indefinitely, everywhere.
function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

// Uploads one object via a signed PUT and returns its public URL. `key`
// should already be a safe, pre-generated path segment (uploads.js always
// passes a `${tenantId}/${crypto.randomUUID()}.ext` shape) — this function
// doesn't sanitize it further, same trust boundary as the local-disk path
// it replaces (multer's own filename() callback is what avoids path
// traversal there).
async function uploadBuffer(key, buffer, contentType) {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  // Endpoint host only (e.g. "s3.amazonaws.com", "<accountid>.r2.cloudflarestorage.com")
  // — no scheme, no bucket, no trailing slash. S3_PUBLIC_URL_BASE lets an
  // operator serving uploads through a CDN/custom domain in front of the
  // bucket (common for R2/Spaces) return THAT url instead of the raw
  // endpoint one; defaults to the standard virtual-hosted-style URL when unset.
  const endpointHost = process.env.S3_ENDPOINT;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8); // YYYYMMDD

  const payloadHash = sha256Hex(buffer);
  const canonicalUri = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const canonicalHeaders = `host:${endpointHost}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, "s3");
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${endpointHost}${canonicalUri}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Host: endpointHost,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: authorization,
      "Content-Type": contentType,
      "Content-Length": String(buffer.length),
    },
    body: buffer,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Object storage upload failed (${resp.status}): ${detail.slice(0, 500)}`);
  }

  const publicBase = process.env.S3_PUBLIC_URL_BASE;
  return publicBase ? `${publicBase.replace(/\/$/, "")}/${key}` : url;
}

module.exports = { isConfigured, uploadBuffer };
