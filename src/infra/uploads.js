const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { DATA_DIR } = require("../store/db");

// Local disk storage under the same DATA_DIR db.js already uses (so a test
// run's fresh DATA_DIR isolates its uploads exactly like it isolates the
// sqlite file — nothing extra to bust/clean up). Served back out at
// GET /uploads/:tenantId/:file by server.js via express.static, so a saved
// business.photo URL is just "/uploads/<tenantId>/<file>", the same shape
// as any externally-hosted photo URL an admin could already paste in.
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

const EXTENSION_BY_MIMETYPE = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const storage = multer.diskStorage({
  destination(req, file, cb) {
    // Scoped by the uploading admin's own tenantId — one tenant's admin can
    // never overwrite or guess another tenant's uploaded file path, same
    // per-tenant isolation discipline every store in this codebase follows.
    const dir = path.join(UPLOAD_DIR, String(req.user.tenantId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    // Random name, not the original filename — avoids path traversal and
    // collisions without needing to sanitize whatever the browser sent.
    cb(null, `${crypto.randomUUID()}${EXTENSION_BY_MIMETYPE[file.mimetype]}`);
  },
});

const uploadImage = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB — plenty for a provider/business photo, small enough to not need real object storage yet
  fileFilter(req, file, cb) {
    if (!EXTENSION_BY_MIMETYPE[file.mimetype]) {
      return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed."));
    }
    cb(null, true);
  },
});

module.exports = { uploadImage, UPLOAD_DIR };
