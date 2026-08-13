const express = require("express");
const { log } = require("../infra/logger");
const { asyncHandler } = require("../infra/asyncHandler");
const tenantStore = require("../store/tenantStore");
const bookings = require("../store/bookingStore");
const users = require("../store/userStore");
const { recordAudit, listAudit } = require("../store/auditLog");
const { requireAuth } = require("./auth");
const onboardingRequests = require("../store/onboardingRequestStore");
const { ADMIN_ASSIGNABLE_PLAN_IDS } = require("../infra/plans");

const router = express.Router();

// Section 8.5 — platform-admin routes. Distinct from every /api/dashboard/*
// route: those are all scoped to the caller's OWN tenant (a real tenant
// admin/provider can never see another tenant's data through them, even by
// guessing ids — see every store module's tenant_id filtering). These
// operate ACROSS tenants by design, which is exactly why they're gated to
// the platform_admin role only, a role distinct from any tenant's own admin
// (src/store/userStore.js).
router.get("/api/platform/tenants", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  // Section 8's own Definition of Done, verbatim: "a platform admin can
  // see both tenants' summary stats from one view." One query per tenant
  // here (not a JOIN) — the tenant count is expected to stay small enough
  // that this is simpler and clearer than an aggregate query, and it
  // reuses each store's own tenant-scoped counting rather than a
  // one-off cross-tenant query living only here.
  const allTenants = await tenantStore.list();
  const summaries = await Promise.all(allTenants.map(async (t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    plan: t.plan,
    status: t.status,
    whatsappConnected: !!(t.whatsappAccessToken && t.whatsappPhoneNumberId),
    bookingCount: (await bookings.values(t.id)).length,
    userCount: (await users.list(t.id)).length,
    createdAt: t.createdAt,
  })));
  res.json(summaries);
}));

router.get("/api/platform/tenants/:id", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const tenant = await tenantStore.getById(id);
  if (!tenant) return res.status(404).json({ error: "Not found" });
  // whatsappAccessToken is a real secret — never returned to any client,
  // including the platform admin's own dashboard (same principle as
  // password_hash never appearing in a users API response).
  const { whatsappAccessToken, ...safeTenant } = tenant;
  res.json(safeTenant);
}));

// New plan, Stream 5 — the literal "select any specific business, then I
// can see whatever they have done and are going on" ask: one tenant's
// booking count, recent activity, config summary, and onboarding status
// in one call. Explicitly audited as its own action (tenant.viewed) — the
// "explicit, audited support access" guardrail from the user's own
// critique doc, so a platform admin looking into a tenant's data leaves
// the same kind of trail every other cross-tenant action here already does,
// not a silent read.
router.get("/api/platform/tenants/:id/detail", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const tenant = await tenantStore.getById(id);
  if (!tenant) return res.status(404).json({ error: "Not found" });

  const [tenantBookings, tenantUsers, recentAudit, onboarding] = await Promise.all([
    bookings.values(id),
    users.list(id),
    listAudit(id, 25),
    onboardingRequests.getForTenant(id),
  ]);
  const bookingsByStatus = tenantBookings.reduce((acc, b) => {
    acc[b.status] = (acc[b.status] || 0) + 1;
    return acc;
  }, {});

  await recordAudit(id, req.user, "tenant.viewed", null);

  const { whatsappAccessToken, ...safeTenant } = tenant;
  res.json({
    tenant: safeTenant,
    bookingCount: tenantBookings.length,
    bookingsByStatus,
    userCount: tenantUsers.length,
    users: tenantUsers.map((u) => ({ email: u.email, role: u.role, active: u.active, workflowId: u.workflowId, providerId: u.providerId })),
    onboarding,
    recentActivity: recentAudit,
  });
}));

router.post("/api/platform/tenants", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const { name, slug, plan, billingEmail } = req.body || {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name is required." });
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: "slug is required and must contain only lowercase letters, numbers, and dashes." });
  }
  try {
    const tenant = await tenantStore.create({ name: name.trim(), slug, plan, billingEmail });
    // No auto-seeded demo catalog here either — same reasoning as POST /api/signup.
    await recordAudit(tenant.id, req.user, "tenant.create", { name: tenant.name, slug: tenant.slug });
    log("INFO", `${req.user.email} created tenant "${tenant.name}" (${tenant.slug})`);
    res.status(201).json(tenant);
  } catch (err) {
    if (err.code === "DUPLICATE_SLUG") return res.status(409).json({ error: err.message });
    throw err;
  }
}));

// Section 8.6 — the tenant lifecycle itself. New plan (subscription-gated
// onboarding) — the full sequence is now:
//   awaiting_payment -> onboarding_pending -> onboarding_in_progress -> active
//   (-> suspended | cancelled, from active)
// A tenant starts at awaiting_payment (self-signup, src/routes/auth.js) —
// nothing further happens until POST /api/billing/checkout's Razorpay
// subscription webhook flips it to onboarding_pending and opens the
// onboarding_requests row (src/store/onboardingRequestStore.js). The
// onboarding team works onboarding_pending/onboarding_in_progress requests
// from the platform-admin queue and marks one complete, which is what
// actually calls this route to flip the tenant to active — this route
// itself stays a generic "move to any valid status" lever (still used
// directly for suspend/reactivate/cancel), not onboarding-specific logic.
// requireAuth()'s tenant-status check is what actually enforces each
// blocked state's real effect (awaiting_payment/onboarding_pending/
// onboarding_in_progress all block the dashboard same as pending always
// did; suspended/cancelled block everything).
const TENANT_STATUSES = new Set(["awaiting_payment", "onboarding_pending", "onboarding_in_progress", "active", "suspended", "cancelled"]);
router.patch("/api/platform/tenants/:id/status", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const { status } = req.body || {};
  if (!TENANT_STATUSES.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...TENANT_STATUSES].join(", ")}` });
  }
  const existing = await tenantStore.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const updated = await tenantStore.setStatus(id, status);
  await recordAudit(id, req.user, "tenant.status_change", { from: existing.status, to: status });
  log("INFO", `${req.user.email} changed tenant ${id} (${existing.slug}) status: ${existing.status} -> ${status}`);
  const { whatsappAccessToken, ...safeTenant } = updated;
  res.json(safeTenant);
}));

// New plan, Block 12 — until now nothing could ever change a tenant's plan
// after creation (every signup path hardcodes "free"); this is that one
// missing lever, deliberately as bare as the rest of this billing skeleton
// — no proration, no real payment collection, just a plan string a
// platform admin sets after handling billing however this pass doesn't
// (an invoice, a manual bank transfer, a conversation).
router.patch("/api/platform/tenants/:id/plan", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const { plan } = req.body || {};
  if (!ADMIN_ASSIGNABLE_PLAN_IDS.has(plan)) {
    return res.status(400).json({ error: `plan must be one of: ${[...ADMIN_ASSIGNABLE_PLAN_IDS].join(", ")}` });
  }
  const existing = await tenantStore.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const updated = await tenantStore.setPlan(id, plan);
  await recordAudit(id, req.user, "tenant.plan_change", { from: existing.plan, to: plan });
  log("INFO", `${req.user.email} changed tenant ${id} (${existing.slug}) plan: ${existing.plan} -> ${plan}`);
  const { whatsappAccessToken, ...safeTenant } = updated;
  res.json(safeTenant);
}));

// Section 8.4 — per-tenant config: branding shown in bot copy/dashboard
// chrome, feature flags (payments/calendar sync on/off — groundwork for
// Sections 9/10, not consulted anywhere yet), and an optional bring-your-
// own Groq key for higher-plan tenants. Also where a tenant's own WhatsApp
// number gets connected (Section 8.3's tenant-resolution depends on this
// being set correctly).
router.patch("/api/platform/tenants/:id/config", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = await tenantStore.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const { branding, featureFlags, groqApiKey, whatsappPhoneNumberId, whatsappBusinessAccountId, whatsappAccessToken } = req.body || {};
  let updated = existing;
  if (branding !== undefined || featureFlags !== undefined || groqApiKey !== undefined) {
    updated = await tenantStore.updateConfig(id, { branding, featureFlags, groqApiKey });
  }
  if (whatsappPhoneNumberId !== undefined || whatsappBusinessAccountId !== undefined || whatsappAccessToken !== undefined) {
    // setWhatsAppCredentials encrypts the access token (secretsEncryption.js)
    // and throws a specific, actionable error if APP_ENCRYPTION_KEY isn't
    // set — found live hitting this endpoint before that env var was
    // configured: without this catch it fell through to the generic global
    // error handler as an opaque 500 "Internal server error", which told
    // the platform_admin nothing about what to actually fix.
    try {
      updated = await tenantStore.setWhatsAppCredentials(id, {
        phoneNumberId: whatsappPhoneNumberId ?? existing.whatsappPhoneNumberId,
        businessAccountId: whatsappBusinessAccountId ?? existing.whatsappBusinessAccountId,
        accessToken: whatsappAccessToken !== undefined ? whatsappAccessToken : existing.whatsappAccessToken,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  await recordAudit(id, req.user, "tenant.config_update", { fields: Object.keys(req.body || {}) });
  const { whatsappAccessToken: _omit, ...safeTenant } = updated;
  res.json(safeTenant);
}));

// New plan, Stream 2 — the onboarding team's actual worklist: every tenant
// that's paid but not yet activated, oldest first (see
// onboardingRequestStore.js's listQueue). This is the literal "select any
// specific business" queue view the onboarding flow depends on — a paid
// signup with nobody ever looking at this list would just sit at
// onboarding_pending forever.
router.get("/api/platform/onboarding-queue", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const queue = await onboardingRequests.listQueue();
  res.json(queue);
}));

router.patch("/api/platform/onboarding-queue/:id/assign", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const { assignedTo } = req.body || {};
  if (typeof assignedTo !== "string" || !assignedTo.trim()) return res.status(400).json({ error: "assignedTo is required." });
  const existing = await onboardingRequests.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const updated = await onboardingRequests.assign(id, assignedTo.trim());
  await recordAudit(existing.tenantId, req.user, "onboarding.assigned", { onboardingRequestId: id, assignedTo: assignedTo.trim() });
  res.json(updated);
}));

// Marks first (or renewed) contact — flips onboarding_requests to
// in_progress and, for symmetry, the tenant itself, so a tenant admin who
// logs back in sees "our team's on it" rather than the generic "queued"
// message (requireAuth() reads onboarding_pending/onboarding_in_progress
// identically today, but the distinction is real and worth recording).
router.patch("/api/platform/onboarding-queue/:id/contacted", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = await onboardingRequests.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const updated = await onboardingRequests.markContacted(id);
  const tenant = await tenantStore.getById(existing.tenantId);
  if (tenant && tenant.status === "onboarding_pending") {
    await tenantStore.setStatus(existing.tenantId, "onboarding_in_progress");
  }
  await recordAudit(existing.tenantId, req.user, "onboarding.contacted", { onboardingRequestId: id });
  res.json(updated);
}));

// The actual activation lever, reached from the queue instead of only a
// manual tenant lookup — reuses tenantStore.setStatus the exact same way
// PATCH /api/platform/tenants/:id/status above does, so both paths produce
// an identical, correctly-audited "tenant.status_change" trail.
router.patch("/api/platform/onboarding-queue/:id/complete", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = await onboardingRequests.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const tenant = await tenantStore.getById(existing.tenantId);
  if (!tenant) return res.status(404).json({ error: "Tenant no longer exists." });

  const updatedRequest = await onboardingRequests.markComplete(id);
  const updatedTenant = await tenantStore.setStatus(existing.tenantId, "active");
  await recordAudit(existing.tenantId, req.user, "tenant.status_change", { from: tenant.status, to: "active" });
  await recordAudit(existing.tenantId, req.user, "onboarding.completed", { onboardingRequestId: id });
  log("INFO", `${req.user.email} completed onboarding for tenant ${existing.tenantId} (${tenant.slug}) — now active.`);
  const { whatsappAccessToken, ...safeTenant } = updatedTenant;
  res.json({ request: updatedRequest, tenant: safeTenant });
}));

module.exports = { router, TENANT_STATUSES };
