// Self-audit finding: POST /api/dashboard/upload-image had no test coverage
// at all before this. Proves both branches of src/infra/uploads.js's
// saveUploadedImage() — local disk (the default, object storage
// unconfigured) and real object storage (S3_* env vars set, PUT stubbed via
// global.fetch, same stubbing pattern tests/infra/outboundQueue.test.js and
// tests/infra/alerting.test.js already use) — plus the fallback when object
// storage is configured but the PUT itself fails.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const request = require("supertest");
const { freshApp, signupAndActivate } = require("./_setup");

// A minimal valid 1x1 PNG — small enough to inline, real enough to pass
// multer's mimetype-sniffing-free extension/mimetype fileFilter check
// (that check trusts the Content-Type field supertest sets from .attach()'s
// filename extension, same as a real browser upload would send).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("POST /api/dashboard/upload-image saves to local disk when object storage is not configured", async () => {
  const app = await freshApp();
  const { cookie, tenantId } = await signupAndActivate(app, request, { businessName: "Upload Test Biz", email: "upload-local@example.com" });

  const resp = await request(app).post("/api/dashboard/upload-image").set("Cookie", cookie).attach("image", TINY_PNG, "photo.png");

  assert.equal(resp.status, 200);
  assert.match(resp.body.url, new RegExp(`^/uploads/${tenantId}/[0-9a-f-]+\\.png$`));

  const { UPLOAD_DIR } = require("../../src/infra/uploads");
  const filename = resp.body.url.split("/").pop();
  const savedPath = path.join(UPLOAD_DIR, String(tenantId), filename);
  assert.ok(fs.existsSync(savedPath), "expected the uploaded file to actually exist on local disk");
  assert.deepEqual(fs.readFileSync(savedPath), TINY_PNG);
});

test("POST /api/dashboard/upload-image uploads to object storage when S3_* is configured, and never touches local disk", async () => {
  const app = await freshApp({
    envOverrides: {},
  });
  process.env.S3_BUCKET = "test-bucket";
  process.env.S3_ENDPOINT = "s3.example-test.com";
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY_ID = "test-key-id";
  process.env.S3_SECRET_ACCESS_KEY = "test-secret";
  process.env.S3_PUBLIC_URL_BASE = "https://cdn.example-test.com";

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, text: async () => "" };
  };

  try {
    const { cookie, tenantId } = await signupAndActivate(app, request, { businessName: "Upload S3 Test Biz", email: "upload-s3@example.com" });
    const resp = await request(app).post("/api/dashboard/upload-image").set("Cookie", cookie).attach("image", TINY_PNG, "photo.png");

    assert.equal(resp.status, 200);
    assert.match(resp.body.url, new RegExp(`^https://cdn\\.example-test\\.com/${tenantId}/[0-9a-f-]+\\.png$`));

    assert.equal(calls.length, 1, "expected exactly one PUT to object storage");
    assert.equal(calls[0].opts.method, "PUT");
    assert.ok(calls[0].url.startsWith("https://s3.example-test.com/test-bucket/"));
    assert.equal(calls[0].opts.headers.Authorization.startsWith("AWS4-HMAC-SHA256"), true);

    const { UPLOAD_DIR } = require("../../src/infra/uploads");
    const tenantDir = path.join(UPLOAD_DIR, String(tenantId));
    assert.ok(!fs.existsSync(tenantDir), "local disk must not be touched when the object storage upload succeeds");
  } finally {
    global.fetch = originalFetch;
  }
});

test("POST /api/dashboard/upload-image falls back to local disk if object storage is configured but the PUT fails", async () => {
  const app = await freshApp();
  process.env.S3_BUCKET = "test-bucket";
  process.env.S3_ENDPOINT = "s3.example-test.com";
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY_ID = "test-key-id";
  process.env.S3_SECRET_ACCESS_KEY = "test-secret";

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "simulated object storage outage" });

  try {
    const { cookie, tenantId } = await signupAndActivate(app, request, { businessName: "Upload Fallback Test Biz", email: "upload-fallback@example.com" });
    const resp = await request(app).post("/api/dashboard/upload-image").set("Cookie", cookie).attach("image", TINY_PNG, "photo.png");

    assert.equal(resp.status, 200, "an object storage outage must not fail the upload outright — it should fall back to local disk");
    assert.match(resp.body.url, new RegExp(`^/uploads/${tenantId}/[0-9a-f-]+\\.png$`));
  } finally {
    global.fetch = originalFetch;
  }
});
