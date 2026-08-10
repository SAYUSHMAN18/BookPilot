// Section 9.1 — the abstraction every call site in this codebase talks
// to, so Razorpay (today's only implementation, src/infra/paymentProviders/
// razorpayProvider.js) can be swapped or joined by Stripe/others later
// without touching workflowEngine.js or server.js. Mirrors the same
// "interface as a comment + duck typing" convention this codebase already
// uses elsewhere (no TypeScript yet — Section 15.1 is where that's
// evaluated) rather than introducing a class hierarchy for a two-method
// contract.
//
// A conforming provider module exports:
//
//   createOrder({ amount, currency, receipt, notes }) -> Promise<{ orderId, amount, currency, raw }>
//     amount is in the smallest currency unit (paise for INR), matching
//     both Razorpay's own convention and payments.amount's column
//     comment — never a float rupee amount, to avoid floating-point
//     rounding anywhere near real money.
//
//   verifyWebhookSignature(rawBody, signatureHeader) -> boolean
//     rawBody is the exact, unparsed request body bytes/string — the
//     signature is computed over the raw bytes, not a re-serialized JS
//     object, same discipline src/infra/verifySignature.js already
//     applies to Meta's webhook signature.
//
//   parseWebhookEvent(parsedBody) -> { type, orderId, paymentId, amount, currency, raw } | null
//     type is one of 'payment.captured' | 'payment.failed' | 'refund.processed'.
//     Returns null for an event type this integration doesn't act on
//     (Razorpay's webhook fires for many event types this app has no
//     opinion about) — the caller should just acknowledge and ignore those,
//     not treat an unrecognized event as an error.
//
//   createRefund({ providerPaymentId, amount }) -> Promise<{ refundId, status, raw }>
//     amount omitted (or equal to the original) means a full refund;
//     a smaller amount is a partial refund. Matches payments.refund_amount.
//
// Every method is async and every implementation MUST fail closed: a
// network error or non-2xx response throws, it never silently returns a
// success-shaped object. Callers (server.js, workflowEngine.js) decide
// what "payment failed to even start" means for the customer; this layer
// only ever reports what actually happened.

module.exports = {}; // documentation-only module — see razorpayProvider.js for the real implementation
