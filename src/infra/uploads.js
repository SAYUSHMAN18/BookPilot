const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { DATA_DIR } = require("../store/db");
const objectStorage = require("./objectStorage");
const { log } = require("./logger");

// Local disk storage under the same DATA_DIR db.js already uses (so a test
// run's fresh DATA_DIR isolates its uploads exactly like it isolates the
// sqlite file — nothing extra to bust/clean up). Served back out at
// GET /uploads/:tenantId/:file by server.js via express.static, so a saved
// business.photo URL is just "/uploads/<tenantId>/<file>", the same shape
// as any externally-hosted photo URL an admin could already paste in.
//
// This is now the FALLBACK path, not the only one — see saveUploadedImage()
// below. Kept as the default (objectStorage unconfigured) so a fresh/local
// install behaves exactly as before with zero setup, matching every other
// optional integration in this codebase.
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

const EXTENSION_BY_MIMETYPE = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

// Memory storage, not disk — saveUploadedImage() below needs the raw
// buffer either way (to PUT to object storage, or to write to local disk
// itself), so multer no longer owns where the bytes end up.
const storage = multer.memoryStorage();

const uploadImage = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB — plenty for a provider/business photo
  fileFilter(req, file, cb) {
    if (!EXTENSION_BY_MIMETYPE[file.mimetype]) {
      return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed."));
    }
    cb(null, true);
  },
});

// Found live (self-audit): local disk under DATA_DIR is ephemeral on any
// real PaaS host — an uploaded business photo silently disappears on the
// next deploy/restart. Saves to real object storage when configured
// (objectStorage.js's own S3_* env vars), falling back to local disk
// otherwise so a fresh/local install needs zero extra setup to work. Scoped
// by tenantId in the storage key/path either way — one tenant's admin can
// never overwrite or guess another tenant's uploaded file, same per-tenant
// isolation discipline every store in this codebase follows.
async function saveUploadedImage(tenantId, file) {
  const filename = `${crypto.randomUUID()}${EXTENSION_BY_MIMETYPE[file.mimetype]}`;
  const key = `${tenantId}/${filename}`;

  if (objectStorage.isConfigured()) {
    try {
      const url = await objectStorage.uploadBuffer(key, file.buffer, file.mimetype);
      return { url, filename };
    } catch (err) {
      log("ERROR", `Object storage upload failed (${err.message}) — falling back to local disk for this upload.`);
      // Falls through to the local-disk path below rather than failing the
      // request outright — an admin's upload still succeeds (just not
      // durable across a redeploy) instead of a misconfigured/temporarily
      // down object storage blocking every photo upload entirely.
    }
  }

  const dir = path.join(UPLOAD_DIR, String(tenantId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), file.buffer);
  return { url: `/uploads/${tenantId}/${filename}`, filename };
}

// Knowledge-base document upload — deliberately memory storage, not disk:
// unlike a business/provider photo (which needs a persistent URL to show
// customers later), a KB doc is only ever read ONCE, at upload time, to
// extract its text — nothing downstream ever needs the original file
// again, so there's nothing worth writing to disk or cleaning up later.
const DOCUMENT_MIMETYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "text/plain",
]);
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // text-heavy PDFs run bigger than a photo; still bounded
  fileFilter(req, file, cb) {
    if (!DOCUMENT_MIMETYPES.has(file.mimetype)) {
      return cb(new Error("Only PDF, DOCX, or plain text (.txt) files are allowed."));
    }
    cb(null, true);
  },
});

module.exports = { uploadImage, uploadDocument, saveUploadedImage, UPLOAD_DIR };
