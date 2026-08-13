const path = require("path");
const express = require("express");
const { asyncHandler } = require("../infra/asyncHandler");
const bookings = require("../store/bookingStore");
const tenantWorkflowStore = require("../store/tenantWorkflowStore");
const { getAvailableSlots } = require("../engine/workflowEngine");
const { requireApiKey } = require("./auth");

const router = express.Router();

// Section 14 — Public API (/api/v1/*). A tenant's own website/backend can
// call these directly, authenticated with an API key (requireApiKey) rather
// than a dashboard session — e.g. a "Check availability" widget embedded on
// the tenant's own site, or a confirmation page that looks up a booking by
// id after a customer completes one elsewhere.
//
// Deliberately READ-ONLY for this pass — no POST /api/v1/bookings to create
// or cancel a booking through this API yet. Every write this project makes
// today goes through src/engine/workflowEngine.js's recordBooking(), which
// is coupled to a conversational session (step validation, provider/date/
// time selection state) in a way that isn't yet factored into a reusable,
// session-independent "create one valid booking" function. Building that
// safely — without either duplicating workflowEngine's validation logic
// (a second copy that could drift) or risking a booking that skips a check
// the WhatsApp flow enforces — is real, separate design work, not something
// to rush through here. Flagged explicitly rather than silently shipping a
// write path that looks equivalent to the conversational one but isn't.
//
// New plan, Block 19 — a real, importable OpenAPI 3.0 spec for this Public
// API, kept as a plain static YAML file (no new dependency — nothing here
// parses or generates it, the file itself IS the deliverable) rather than a
// full Swagger UI, which would need a CDN script this project's own CSP
// deliberately blocks. Unauthenticated, same as the docs a `curl` or a
// browser tab reaches with no API key at all — the spec describes the API,
// it isn't the API.
router.get("/openapi.yaml", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "openapi.yaml"));
});

router.get("/api/v1/availability", requireApiKey, asyncHandler(async (req, res) => {
  const { workflowId, providerId, date } = req.query;
  if (typeof workflowId !== "string" || typeof providerId !== "string" || typeof date !== "string") {
    return res.status(400).json({ error: "workflowId, providerId, and date (YYYY-MM-DD) are required query params." });
  }
  const workflow = await tenantWorkflowStore.get(req.apiTenantId, workflowId);
  if (!workflow) return res.status(404).json({ error: "Unknown workflowId." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be in YYYY-MM-DD format." });

  const slots = await getAvailableSlots(req.apiTenantId, workflow, providerId, date);
  res.json({ workflowId, providerId, date, slots });
}));

router.get("/api/v1/bookings/:bookingId", requireApiKey, asyncHandler(async (req, res) => {
  // The tenant-issued bookingId (e.g. "APT-20260101-XY12"), not this app's
  // internal numeric row id — the same identifier a customer's own
  // confirmation message already shows them, since this route exists for a
  // tenant's own site to look up a booking a customer already has.
  const booking = await bookings.getByBookingId(req.apiTenantId, req.params.bookingId);
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  const { waId: _omit, ...publicBooking } = booking; // the customer's phone number stays internal-only, even to the tenant's own integration
  res.json(publicBooking);
}));

module.exports = { router };
