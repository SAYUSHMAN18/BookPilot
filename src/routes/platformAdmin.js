const express = require("express");
const { log } = require("../infra/logger");
const tenantStore = require("../store/tenantStore");
const bookings = require("../store/bookingStore");
const users = require("../store/userStore");
const { recordAudit } = require("../store/auditLog");
const { requireAuth } = require("./auth");

const router = express.Router();

// Section 8.5 — platform-admin routes. Distinct from every /api/dashboard/*
// route: those are all scoped to the caller's OWN tenant (a real tenant
// admin/provider can never see another tenant's data through them, even by
// guessing ids — see every store module's tenant_id filtering). These
// operate ACROSS tenants by design, which is exactly why they're gated to
// the platform_admin role only, a role distinct from any tenant's own admin
// (src/store/userStore.js).
router.get("/api/platform/tenants", requireAuth("platform_admin"), (req, res) => {
  // Section 8's own Definition of Done, verbatim: "a platform admin can
  // see both tenants' summary stats from one view." One query per tenant
  // here (not a JOIN) — the tenant count is expected to stay small enough
  // that this is simpler and clearer than an aggregate query, and it
  // reuses each store's own tenant-scoped counting rather than a
  // one-off cross-tenant query living only here.
  const allTenants = tenantStore.list();
  const summaries = allTenants.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    plan: t.plan,
    status: t.status,
    whatsappConnected: !!(t.whatsappAccessToken && t.whatsappPhoneNumberId),
    bookingCount: bookings.values(t.id).length,
    userCount: users.list(t.id).length,
    createdAt: t.createdAt,
  }));
  res.json(summaries);
});

router.get("/api/platform/tenants/:id", requireAuth("platform_admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const tenant = tenantStore.getById(id);
  if (!tenant) return res.status(404).json({ error: "Not found" });
  // whatsappAccessToken is a real secret — never returned to any client,
  // including the platform admin's own dashboard (same principle as
  // password_hash never appearing in a users API response).
  const { whatsappAccessToken, ...safeTenant } = tenant;
  res.json(safeTenant);
});

router.post("/api/platform/tenants", requireAuth("platform_admin"), (req, res) => {
  const { name, slug, plan, billingEmail } = req.body || {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name is required." });
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: "slug is required and must contain only lowercase letters, numbers, and dashes." });
  }
  try {
    const tenant = tenantStore.create({ name: name.trim(), slug, plan, billingEmail });
    // No auto-seeded demo catalog here either — same reasoning as POST /api/signup.
    recordAudit(tenant.id, req.user, "tenant.create", { name: tenant.name, slug: tenant.slug });
    log("INFO", `${req.user.email} created tenant "${tenant.name}" (${tenant.slug})`);
    res.status(201).json(tenant);
  } catch (err) {
    if (err.code === "DUPLICATE_SLUG") return res.status(409).json({ error: err.message });
    throw err;
  }
});

// Section 8.6 — the tenant lifecycle itself: pending -> active -> suspended
// -> cancelled. requireAuth()'s tenant-status check is what actually
// enforces "a suspended tenant's own users can't do anything" — this route
// is just what moves a tenant between those states.
const TENANT_STATUSES = new Set(["pending", "active", "suspended", "cancelled"]);
router.patch("/api/platform/tenants/:id/status", requireAuth("platform_admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const { status } = req.body || {};
  if (!TENANT_STATUSES.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...TENANT_STATUSES].join(", ")}` });
  }
  const existing = tenantStore.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const updated = tenantStore.setStatus(id, status);
  recordAudit(id, req.user, "tenant.status_change", { from: existing.status, to: status });
  log("INFO", `${req.user.email} changed tenant ${id} (${existing.slug}) status: ${existing.status} -> ${status}`);
  const { whatsappAccessToken, ...safeTenant } = updated;
  res.json(safeTenant);
});

// New plan, Block 12 — until now nothing could ever change a tenant's plan
// after creation (every signup path hardcodes "free"); this is that one
// missing lever, deliberately as bare as the rest of this billing skeleton
// — no proration, no real payment collection, just a plan string a
// platform admin sets after handling billing however this pass doesn't
// (an invoice, a manual bank transfer, a conversation).
const PLAN_IDS = new Set(["free", "growth", "enterprise"]);
router.patch("/api/platform/tenants/:id/plan", requireAuth("platform_admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const { plan } = req.body || {};
  if (!PLAN_IDS.has(plan)) {
    return res.status(400).json({ error: `plan must be one of: ${[...PLAN_IDS].join(", ")}` });
  }
  const existing = tenantStore.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const updated = tenantStore.setPlan(id, plan);
  recordAudit(id, req.user, "tenant.plan_change", { from: existing.plan, to: plan });
  log("INFO", `${req.user.email} changed tenant ${id} (${existing.slug}) plan: ${existing.plan} -> ${plan}`);
  const { whatsappAccessToken, ...safeTenant } = updated;
  res.json(safeTenant);
});

// Section 8.4 — per-tenant config: branding shown in bot copy/dashboard
// chrome, feature flags (payments/calendar sync on/off — groundwork for
// Sections 9/10, not consulted anywhere yet), and an optional bring-your-
// own Groq key for higher-plan tenants. Also where a tenant's own WhatsApp
// number gets connected (Section 8.3's tenant-resolution depends on this
// being set correctly).
router.patch("/api/platform/tenants/:id/config", requireAuth("platform_admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = tenantStore.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const { branding, featureFlags, groqApiKey, whatsappPhoneNumberId, whatsappBusinessAccountId, whatsappAccessToken } = req.body || {};
  let updated = existing;
  if (branding !== undefined || featureFlags !== undefined || groqApiKey !== undefined) {
    updated = tenantStore.updateConfig(id, { branding, featureFlags, groqApiKey });
  }
  if (whatsappPhoneNumberId !== undefined || whatsappBusinessAccountId !== undefined || whatsappAccessToken !== undefined) {
    // setWhatsAppCredentials encrypts the access token (secretsEncryption.js)
    // and throws a specific, actionable error if APP_ENCRYPTION_KEY isn't
    // set — found live hitting this endpoint before that env var was
    // configured: without this catch it fell through to the generic global
    // error handler as an opaque 500 "Internal server error", which told
    // the platform_admin nothing about what to actually fix.
    try {
      updated = tenantStore.setWhatsAppCredentials(id, {
        phoneNumberId: whatsappPhoneNumberId ?? existing.whatsappPhoneNumberId,
        businessAccountId: whatsappBusinessAccountId ?? existing.whatsappBusinessAccountId,
        accessToken: whatsappAccessToken !== undefined ? whatsappAccessToken : existing.whatsappAccessToken,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  recordAudit(id, req.user, "tenant.config_update", { fields: Object.keys(req.body || {}) });
  const { whatsappAccessToken: _omit, ...safeTenant } = updated;
  res.json(safeTenant);
});

module.exports = { router };
