// Section 5.5 — the real server handles many WhatsApp webhooks concurrently
// (Express's event loop interleaves them, same as this test does with
// Promise.all over randomly-delayed writes), all hitting the same Postgres
// database. Two things actually need proving, not just "no crash":
// (1) a burst of DIFFERENT bookings never loses or duplicates a write, and
// (2) two customers racing for the SAME slot can never both win — the
// UNIQUE index (src/store/bookingStore.js's SlotTakenError) is the
// authoritative guard, not just the JS-level availability check that runs
// first and can never fully close that race on its own.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

// This file predates the Postgres migration and used to call bookingStore
// synchronously (bookings.create(...)/.values(...) with no `await`),
// relying on SQLite's DATA_DIR-per-run file isolation and node:sqlite's
// DatabaseSync being synchronous in the first place. Converted here to the
// same isolated-Postgres-database + async pattern every other test file in
// this suite now uses (see tests/helpers/isolatedDb.js) — the concurrency-
// proving premise itself is unchanged and, if anything, more meaningful
// under a real client/server database than it was under a single-process
// embedded one. The one test that's gone outright: SQLite's node:sqlite-
// native online backup() has no Postgres equivalent (see src/routes/
// dashboard.js's own comment on why that mechanism was removed, in favor
// of Cloud SQL's built-in backups) — removed here rather than left
// pointing at a module that no longer exists.
let bookings;
const TENANT = 1; // the default tenant, created by db.js's own migration

before(async () => {
  await createIsolatedTestDatabase();
  delete require.cache[require.resolve("../../src/store/db")];
  delete require.cache[require.resolve("../../src/store/bookingStore")];
  bookings = require("../../src/store/bookingStore");
});

// A tiny random delay before the actual DB write, so the Promise.all below
// doesn't just execute all N writes back-to-back in submission order — it
// interleaves them the way concurrent HTTP request handlers actually would.
function jitter() {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
}

test("a concurrent burst of distinct bookings loses nothing and creates no duplicates", async () => {
  const COUNT = 50;
  const attempts = Array.from({ length: COUNT }, (_, i) =>
    (async () => {
      await jitter();
      return bookings.create(TENANT, `91900000${String(i).padStart(4, "0")}`, {
        bookingId: `WAL-BURST-${i}`,
        workflowId: "medical",
        providerId: "p1",
        providerName: "Dr. Test",
        visitDate: "2099-02-01",
        visitTime: `${9 + Math.floor(i / 4)}:${(i % 4) * 15} am`.replace(":0 ", ":00 "),
        customerName: `Burst Customer ${i}`,
        status: "booked",
        createdAt: Date.now(),
      });
    })()
  );

  const results = await Promise.all(attempts);
  assert.equal(results.length, COUNT);
  assert.ok(results.every((b) => b && b.id), "every concurrent write should have returned a real created booking");

  const ids = new Set(results.map((b) => b.bookingId));
  assert.equal(ids.size, COUNT, "expected all booking ids to be distinct — a lost/overwritten write would shrink this set");

  const persisted = (await bookings.values(TENANT)).filter((b) => b.bookingId.startsWith("WAL-BURST-"));
  assert.equal(persisted.length, COUNT, "expected every concurrently-created booking to actually be persisted");
});

test("two customers racing for the exact same slot: exactly one wins, the DB is the authority", async () => {
  const CONTENDERS = 8;
  const slot = { providerId: "p-race", visitDate: "2099-03-01", visitTime: "10:00 am" };

  const attempts = Array.from({ length: CONTENDERS }, (_, i) =>
    (async () => {
      await jitter();
      try {
        const booking = await bookings.create(TENANT, `91900001${String(i).padStart(4, "0")}`, {
          bookingId: `WAL-RACE-${i}`,
          workflowId: "medical",
          providerId: slot.providerId,
          providerName: "Dr. Race",
          visitDate: slot.visitDate,
          visitTime: slot.visitTime,
          customerName: `Racer ${i}`,
          status: "booked",
          createdAt: Date.now(),
        });
        return { ok: true, booking };
      } catch (err) {
        return { ok: false, error: err };
      }
    })()
  );

  const results = await Promise.all(attempts);
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);

  assert.equal(winners.length, 1, `expected exactly one winner for the contested slot, got ${winners.length}`);
  assert.equal(losers.length, CONTENDERS - 1);
  for (const loss of losers) {
    // src/store/bookingStore.js translates Postgres's UNIQUE-violation
    // (error code 23505, regardless of which unique index/constraint
    // tripped) into a SlotTakenError with .code === "SLOT_TAKEN" — the
    // same shape SQLite's version used, just sourced from a different
    // underlying DB error. Every loser should fail with THAT translated
    // error, not a raw 23505 or something else.
    assert.equal(loss.error.code, "SLOT_TAKEN", "every loser should fail with the DB-level SlotTakenError, not something else");
  }

  const persistedForSlot = (await bookings.values(TENANT)).filter(
    (b) => b.providerId === slot.providerId && b.visitDate === slot.visitDate && b.visitTime === slot.visitTime
  );
  assert.equal(persistedForSlot.length, 1, "the contested slot must have exactly one row in the DB no matter how many raced for it");
});
