// Section 5.1 — not just "a file gets created," but a genuine restore
// test: back up a DB with real data, then open the BACKUP FILE ITSELF
// (not the original) with a fresh connection and confirm the actual data
// is readable from it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-backup-test-"));
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-backup-dest-"));
process.env.BACKUP_RETENTION_COUNT = "3";
for (const mod of ["../../src/store/db", "../../src/store/bookingStore", "../../src/infra/backupStore"]) {
  delete require.cache[require.resolve(mod)];
}
const bookings = require("../../src/store/bookingStore");
const { runBackup, listBackups } = require("../../src/infra/backupStore");
const TENANT = 1; // the default tenant, created by db.js's own migration

test("runBackup produces a file that a fresh connection can actually read real data from", async () => {
  bookings.create(TENANT, "919000000001", {
    bookingId: "BACKUP-TEST-1", workflowId: "medical", providerId: "p1", providerName: "Dr. Test",
    visitDate: "2099-01-01", visitTime: "9:00 am", customerName: "Backup Tester", status: "booked", createdAt: Date.now(),
  });

  const result = await runBackup();
  assert.equal(result.ok, true);
  assert.equal(result.bookingCount, 1);

  const backupPath = path.join(process.env.BACKUP_DIR, result.filename);
  assert.ok(fs.existsSync(backupPath));

  // The actual restore test — open the BACKUP file (not the live DB) with
  // its own fresh connection and read the real row back out of it.
  const restored = new DatabaseSync(backupPath, { readOnly: true });
  const row = restored.prepare("SELECT * FROM bookings WHERE booking_id = ?").get("BACKUP-TEST-1");
  restored.close();
  assert.ok(row, "expected the booking to actually be present in the backup file");
  assert.equal(row.customer_name, "Backup Tester");
});

test("old backups beyond the retention count are pruned", async () => {
  for (let i = 0; i < 5; i++) {
    await runBackup();
    await new Promise((r) => setTimeout(r, 20)); // distinct mtimes to sort by
  }
  const backups = listBackups();
  assert.ok(backups.length <= 3, `expected at most 3 backups (retention count), found ${backups.length}`);
});
