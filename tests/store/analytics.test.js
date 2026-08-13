// Section 8 regression test — computeAnalytics() called feedback.listAll()
// with no tenantId argument after Section 8 made that argument required,
// which throws a SQLite bind error the instant any feedback row exists
// for the tenant (undefined can't bind to a SQL parameter). Never caught
// by the rest of the suite because no other test exercised analytics with
// real feedback data present. This proves both the crash is fixed and the
// resulting numbers are correctly tenant-scoped.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let bookings, feedback, payments, tenants, computeAnalytics;
const TENANT = 1;
let OTHER_TENANT;

before(async () => {
  await createIsolatedTestDatabase();
  for (const mod of ["../../src/store/db", "../../src/store/bookingStore", "../../src/store/feedbackStore", "../../src/store/paymentStore", "../../src/engine/analytics"]) {
    delete require.cache[require.resolve(mod)];
  }
  bookings = require("../../src/store/bookingStore");
  feedback = require("../../src/store/feedbackStore");
  payments = require("../../src/store/paymentStore");
  tenants = require("../../src/store/tenantStore");
  ({ computeAnalytics } = require("../../src/engine/analytics"));
  OTHER_TENANT = (await tenants.create({ name: "Other Tenant", slug: "other-tenant-analytics-test" })).id;
});

test("computeAnalytics doesn't throw when the tenant has real feedback rows, and avgRating is correct", async () => {
  const booking = await bookings.create(TENANT, "919000005001", {
    bookingId: "ANALYTICS-TEST-1", workflowId: "medical", providerId: "p1", providerName: "Dr. Test",
    visitDate: "2020-01-01", visitTime: "9:00 am", customerName: "Analytics Tester", status: "done", createdAt: Date.now(),
  });
  await feedback.create(TENANT, booking.id, "medical", "919000005001", "5 stars!");

  const result = await computeAnalytics({ tenantId: TENANT, days: 30 });
  assert.equal(result.avgRating, 5);
  assert.equal(result.ratingSampleSize, 1);
});

test("revenue is tenant-scoped and only counts paid payments", async () => {
  const bookingA = await bookings.create(TENANT, "919000005002", {
    bookingId: "ANALYTICS-TEST-2", workflowId: "medical", providerId: "p2", providerName: "Dr. Test2",
    visitDate: "2099-01-01", visitTime: "9:00 am", customerName: "Payer", status: "booked", createdAt: Date.now(),
  });
  const paymentA = await payments.create(TENANT, bookingA.id, { amount: 50000, providerOrderId: "order_a" });
  await payments.markPaid(paymentA.id, "pay_a");

  const bookingOther = await bookings.create(OTHER_TENANT, "919000005003", {
    bookingId: "ANALYTICS-TEST-OTHER", workflowId: "medical", providerId: "p1", providerName: "Dr. Other",
    visitDate: "2099-01-01", visitTime: "9:00 am", customerName: "Other Tenant Payer", status: "booked", createdAt: Date.now(),
  });
  const paymentOther = await payments.create(OTHER_TENANT, bookingOther.id, { amount: 999900, providerOrderId: "order_other" });
  await payments.markPaid(paymentOther.id, "pay_other");

  const resultA = await computeAnalytics({ tenantId: TENANT, days: 30 });
  assert.equal(resultA.revenue, 500, "500 rupees paid, converted correctly from paise");
  assert.ok(resultA.revenue < 9999, "must never include another tenant's revenue");
});
