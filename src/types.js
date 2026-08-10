// Section 15 — JSDoc typedefs for this codebase's core data shapes, not a
// TypeScript migration. `checkJs`/`jsconfig.json` at the repo root turns
// these into real editor type-checking (autocomplete, "property doesn't
// exist" warnings) in any JSDoc-annotated file without a compile step, a
// build tool, or renaming a single `.js` file to `.ts` — consistent with
// this project's "no heavy tooling unless it earns its keep" stance
// everywhere else (node:sqlite over better-sqlite3, hand-rolled auth over
// jsonwebtoken/bcrypt, plain fetch over axios). This file has zero
// runtime behavior — it only exists for the `@typedef`s.
//
// Not applied everywhere yet: src/store/bookingStore.js is annotated as
// the worked example (see `// @ts-check` at its top) showing what real
// type-checking on a JSDoc'd module looks like; extending the same
// `@ts-check` + `@param`/`@returns` treatment to the rest of src/store/
// and src/engine/ is real, incremental, low-risk follow-up work — each
// file can be done independently, in any order, without touching this
// one, unlike a big-bang TypeScript conversion.

/**
 * @typedef {Object} Booking
 * @property {number} id
 * @property {number} tenantId
 * @property {string} waId
 * @property {string} bookingId
 * @property {string} bookingCode
 * @property {string} workflowId
 * @property {string} providerId
 * @property {string|null} providerName
 * @property {string|null} hotelId
 * @property {string|null} hotelName
 * @property {string|null} visitDate
 * @property {string|null} visitDateLabel
 * @property {string|null} visitTime
 * @property {string|null} checkInIso
 * @property {number|null} nights
 * @property {string|null} customerName
 * @property {string|null} age
 * @property {string|null} gender
 * @property {string|null} reason
 * @property {"booked"|"arrived"|"cancelled"|"rescheduled"|"serving"|"done"|"no_show"|"payment_pending"} status
 * @property {number} createdAt
 * @property {string|null} cancelledBy
 * @property {string|null} rescheduledDate
 * @property {string|null} rescheduledTime
 * @property {string|null} rescheduleNote
 * @property {string|null} providerNote
 * @property {number|null} feedbackRequestedAt
 * @property {"not_required"|"pending"|"paid"|"failed"|"refunded"|"partially_refunded"} paymentStatus
 */

/**
 * @typedef {Object} Payment
 * @property {number} id
 * @property {number} tenantId
 * @property {number} bookingId
 * @property {number} amount Smallest currency unit (paise for INR)
 * @property {string} currency
 * @property {"created"|"paid"|"failed"|"refunded"|"partially_refunded"} status
 * @property {string} provider
 * @property {string|null} providerOrderId
 * @property {string|null} providerPaymentId
 * @property {string|null} refundStatus
 * @property {number|null} refundAmount
 * @property {string|null} failureReason
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} Tenant
 * @property {number} id
 * @property {string} name
 * @property {string} slug
 * @property {"pending"|"active"|"suspended"|"cancelled"} status
 * @property {string|null} whatsappPhoneNumberId
 * @property {string|null} whatsappBusinessAccountId
 * @property {number} createdAt
 */

/**
 * @typedef {Object} User
 * @property {number} id
 * @property {string} email
 * @property {"admin"|"provider"|"platform_admin"} role
 * @property {string|null} name
 * @property {string|null} workflowId
 * @property {string|null} providerId
 * @property {number|null} tenantId Always null for role === 'platform_admin'
 * @property {boolean} active
 * @property {number} createdAt
 */

/**
 * @typedef {Object} ApiKeyRecord
 * @property {number} id
 * @property {number} tenantId
 * @property {string} name
 * @property {string} keyPrefix
 * @property {number} createdAt
 * @property {number|null} lastUsedAt
 * @property {boolean} revoked
 */

module.exports = {};
