const fs = require("fs");
const path = require("path");
const { DatabaseSync, backup } = require("node:sqlite");
const { db, DB_FILE } = require("../store/db");
const { log } = require("./logger");

// Uses node:sqlite's native backup() — SQLite's own Online Backup API,
// not a raw file copy. This matters specifically because the DB runs in
// WAL mode (see db.js): a plain `fs.copyFile` could copy the main file
// mid-write or miss data still sitting in the WAL file, producing a
// corrupt or incomplete backup. The native API handles this correctly
// even with concurrent writes happening, no need to pause the server or
// checkpoint first.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), "..", "backups");
const RETENTION_COUNT = Number(process.env.BACKUP_RETENTION_COUNT) || 14;

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Millisecond + a monotonic counter, not just second-precision — two
// backups requested in quick succession (a manual trigger right after a
// scheduled one, or just fast automated tests) would otherwise collide
// on the same filename and silently overwrite each other instead of
// producing two distinct backups.
let backupCounter = 0;
function timestampedFilename() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
  backupCounter += 1;
  return `bookpilot-${stamp}-${backupCounter}.db`;
}

// "Verified" isn't just "the file exists" — it opens the backup with a
// fresh connection and confirms the row count is at least what the live DB
// reported before the copy started, so a truncated/corrupt backup is
// caught immediately rather than discovered during an actual disaster
// recovery.
//
// Found live: this used to require an EXACT match, which meant any real
// booking written by a live customer during the backup's own async copy
// window (between reading expectedBookingCount and backup() actually
// finishing) got flagged as a verification "failure" — e.g. "expected 51
// booking rows, backup has 52" — even though a backup capturing MORE rows
// than the pre-copy count is exactly what a correct, WAL-consistent
// snapshot is supposed to do with concurrent writes, not corruption. Only
// FEWER rows than expected indicates something was actually lost/truncated.
function verifyBackup(backupPath, expectedBookingCount) {
  const check = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const row = check.prepare("SELECT COUNT(*) AS n FROM bookings").get();
    if (row.n < expectedBookingCount) {
      throw new Error(`Backup verification failed: expected at least ${expectedBookingCount} booking rows, backup has ${row.n}`);
    }
  } finally {
    check.close();
  }
}

function pruneOldBackups() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("bookpilot-") && f.endsWith(".db"))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of files.slice(RETENTION_COUNT)) {
    fs.unlinkSync(path.join(BACKUP_DIR, old.name));
    log("INFO", `Pruned old backup ${old.name} (retention: ${RETENTION_COUNT})`);
  }
}

async function runBackup() {
  ensureBackupDir();
  const filename = timestampedFilename();
  const destPath = path.join(BACKUP_DIR, filename);
  const expectedCount = db.prepare("SELECT COUNT(*) AS n FROM bookings").get().n;

  try {
    await backup(db, destPath);
    verifyBackup(destPath, expectedCount);
    pruneOldBackups();
    log("INFO", `Backup completed and verified: ${filename} (${expectedCount} bookings)`);
    return { ok: true, filename, bookingCount: expectedCount };
  } catch (err) {
    log("ERROR", `Backup failed: ${err.message}`);
    // A partially-written, unverified backup is worse than none — a false
    // sense of safety. Remove it rather than leave it sitting there.
    try {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    } catch {
      // best-effort cleanup
    }
    return { ok: false, error: err.message };
  }
}

function listBackups() {
  ensureBackupDir();
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("bookpilot-") && f.endsWith(".db"))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, sizeBytes: stat.size, createdAt: stat.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

let scheduledTimer = null;
function scheduleBackups(intervalHours = Number(process.env.BACKUP_INTERVAL_HOURS) || 6) {
  if (scheduledTimer) clearInterval(scheduledTimer);
  const intervalMs = intervalHours * 60 * 60 * 1000;
  scheduledTimer = setInterval(() => {
    runBackup().catch((err) => log("ERROR", `Scheduled backup threw: ${err.message}`));
  }, intervalMs);
  scheduledTimer.unref(); // never keep the process alive just for this
  log("INFO", `Automated backups scheduled every ${intervalHours}h -> ${BACKUP_DIR}`);
}

module.exports = { runBackup, listBackups, scheduleBackups, BACKUP_DIR };
