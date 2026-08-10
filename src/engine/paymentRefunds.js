const { log } = require("../infra/logger");
const paymentStore = require("../store/paymentStore");
const bookings = require("../store/bookingStore");
const razorpay = require("../infra/paymentProviders/razorpayProvider");

// Section 9.7 — shared by both cancellation paths (server.js's
// provider-initiated dashboard action, workflowEngine.js's
// customer-initiated "CANCEL" reply) so the refund-percent policy is
// computed exactly one way regardless of who cancelled, not two
// almost-identical implementations that could quietly drift apart.
//
// refundPolicy shape (optional, on a workflow or provider config):
//   { "providerCancellation": "full" | "none",
//     "customerCancellation": [ { "hoursBefore": 24, "refundPercent": 100 }, ... ] }
// customerCancellation is checked in the order given; the FIRST entry
// whose hoursBefore the actual notice satisfies wins — so list them
// descending (most notice first). No policy configured defaults to a
// full refund for a provider cancellation (the business's own decision to
// cancel shouldn't cost the customer anything) and a full refund for a
// customer cancellation too, absent any stated policy to the contrary —
// refusing a refund by DEFAULT, with no policy saying so, would be the
// worse mistake for a business's own goodwill.
function computeRefundPercent({ initiatedBy, refundPolicy, visitDateIso, visitTime }) {
  if (initiatedBy === "provider") {
    if (refundPolicy?.providerCancellation === "none") return 0;
    return 100;
  }

  // customer-initiated
  const tiers = refundPolicy?.customerCancellation;
  if (!Array.isArray(tiers) || tiers.length === 0) return 100;

  const visitAt = visitDateIso ? new Date(`${visitDateIso}T${to24Hour(visitTime) || "00:00"}:00`) : null;
  if (!visitAt || Number.isNaN(visitAt.getTime())) return 100; // can't compute notice — don't penalize on an ambiguity

  const hoursNotice = (visitAt.getTime() - Date.now()) / (1000 * 60 * 60);
  for (const tier of tiers) {
    if (hoursNotice >= tier.hoursBefore) return tier.refundPercent;
  }
  return 0;
}

// Minimal 12h "9:30 am" -> "09:30" conversion — visitTime's own display
// format, not reusing dateSlots.js's labelToMinutes() (which returns
// minutes, not a clock string) to avoid a circular-ish dependency for one
// small conversion.
function to24Hour(label) {
  if (!label) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(label.trim());
  if (!m) return null;
  let [, h, min, ampm] = m;
  h = parseInt(h, 10);
  if (ampm.toLowerCase() === "pm" && h !== 12) h += 12;
  if (ampm.toLowerCase() === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

// Finds the booking's most recent 'paid' payment (if any) and issues a
// real refund through Razorpay, recording the result either way. Returns
// { refunded: boolean, amount, percent } — never throws; a refund failure
// is logged and reported back, not allowed to block the cancellation
// itself (the booking is already being cancelled regardless of whether
// money can be returned automatically — see Section 9.8's manual-refund
// dashboard action for the fallback when this can't complete on its own).
async function refundIfPaid(tenantId, booking, { initiatedBy, refundPolicy }) {
  const paidPayment = paymentStore.listForBooking(tenantId, booking.id).find((p) => p.status === "paid");
  if (!paidPayment) return { refunded: false };

  const percent = computeRefundPercent({ initiatedBy, refundPolicy, visitDateIso: booking.visitDate, visitTime: booking.visitTime });
  if (percent <= 0) {
    log("INFO", `No refund issued for booking ${booking.bookingId} (policy computed 0% — ${initiatedBy}-initiated cancellation).`);
    return { refunded: false, percent: 0 };
  }

  const refundAmount = Math.round((paidPayment.amount * percent) / 100);
  try {
    const refund = await razorpay.createRefund({ providerPaymentId: paidPayment.providerPaymentId, amount: refundAmount });
    const status = percent >= 100 ? "refunded" : "partially_refunded";
    paymentStore.markRefunded(paidPayment.id, status, refund.status, refundAmount);
    bookings.updatePaymentStatus(tenantId, booking.id, status);
    log("INFO", `Refunded ₹${refundAmount / 100} (${percent}%) for booking ${booking.bookingId}, ${initiatedBy}-initiated cancellation.`);
    return { refunded: true, amount: refundAmount, percent };
  } catch (err) {
    log("ERROR", `Automatic refund failed for booking ${booking.bookingId}: ${err.message}. A provider/platform admin needs to issue this manually.`);
    return { refunded: false, error: err.message };
  }
}

module.exports = { computeRefundPercent, refundIfPaid };
