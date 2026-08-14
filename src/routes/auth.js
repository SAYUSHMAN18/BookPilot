const express = require("express");
const { log } = require("../infra/logger");
const { asyncHandler } = require("../infra/asyncHandler");
const { createSessionToken, verifySessionToken, SESSION_TTL_MS } = require("../infra/auth");
const authSessions = require("../store/authSessionStore");
const users = require("../store/userStore");
const tenantStore = require("../store/tenantStore");
const apiKeys = require("../store/apiKeyStore");
const { recordAudit } = require("../store/auditLog");
const { isLoginRateLimited, isApiRateLimited, isSignupRateLimited, isOtpRateLimited } = require("../infra/rateLimit");
const { createOtp, verifyOtp } = require("../store/signupOtpStore");
const { sendEmail } = require("../infra/emailSender");
const { createResetToken, consumeResetToken } = require("../store/passwordResetStore");

// ---------------------------------------------------------------------------
// Provider dashboard — one static page, same UI for every business type.
// "Login" is just picking yourself from a dropdown for now (explicitly
// deferred, not an oversight) — the dropdown is built from that tenant's
// own tenant_workflows rows, so a new provider added there shows up here
// automatically, no dashboard code changes needed.
//
// Hotels: bookings show up here same as any workflow, but the availability
// editor is unavailable for hotel rooms — that table only knows how to
// block a single day/slot, and hotel stays span a date *range* (a
// different, harder problem: does a 3-night block-out prevent bookings
// that only overlap 1 of those nights?). Rather than ship a broken UI
// control for it, it's just not shown for rooms — see README.
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "bp_session";

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function getSessionUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  try {
    return verifySessionToken(token);
  } catch {
    return null; // e.g. SESSION_SECRET missing — treat as logged out, not a crash
  }
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

// Real roles, not a shared secret: every request carries a signed session
// identifying exactly one person. `requireAuth()` with no args just means
// "must be logged in"; `requireAuth("admin")` additionally gates by role.
// Route handlers still do their own per-record ownership checks (a
// provider role alone doesn't prove *which* provider) — this only proves
// identity.
//
// Deliberately re-reads the user row from the DB on every request instead
// of trusting the signed token's payload — a signature only proves the
// token wasn't tampered with, not that the account is still active. Found
// live: deactivating a provider didn't revoke their already-issued cookie
// until it expired (up to 12h) because nothing re-checked `active`. This
// closes that — deactivation (or a future role change) takes effect on
// the very next request, not at next login.
//
// Async now (Postgres) — Express 4 doesn't await middleware, so the body
// runs inside an async IIFE with its rejection routed to next(), same
// "don't let a thrown error hang the request" discipline asyncHandler.js
// already established for route handlers.
// New plan, subscription-gated onboarding — a trailing plain-object arg
// (as opposed to every other arg, which is a role string) opts a route
// into seeing an `awaiting_payment` tenant instead of being blocked by it.
// Needed for exactly one route (POST /api/billing/checkout): a freshly
// signed-up admin must be able to reach checkout despite their tenant not
// being active yet, but nothing else on the dashboard.
function requireAuth(...args) {
  const options = args.length && typeof args[args.length - 1] === "object" ? args.pop() : {};
  const allowedRoles = args;
  return (req, res, next) => {
    (async () => {
      const session = getSessionUser(req);
      if (!session) return res.status(401).json({ error: "Not logged in." });
      // New plan, Block 14 — session list/revoke. A signature and an
      // unexpired `exp` alone used to be the entire check; this closes the
      // one real gap that left (no way to force ONE session to stop
      // working before its natural 12h expiry — a "log out that other
      // device" or a platform_admin responding to a compromised account
      // both needed this). session.sid is missing entirely for a token
      // issued before this table existed — treated as not revoked, same as
      // authSessionStore.isRevoked() itself already documents.
      if (session.sid && (await authSessions.isRevoked(session.sid))) {
        return res.status(401).json({ error: "This session has been logged out. Please log in again." });
      }
      const liveUser = await users.getById(session.uid);
      if (!liveUser || !liveUser.active) {
        return res.status(401).json({ error: "This account is no longer active." });
      }
      // Section 8.6 — a tenant-scoped user (everyone except platform_admin,
      // whose tenantId is always null) is re-checked against their tenant's
      // current lifecycle status on every request, same reasoning as the
      // `active` check just above: a tenant getting suspended must take
      // effect on the user's very next request, not linger until their
      // session naturally expires (up to 12h).
      //
      // New plan, Section 2 — "pending" now blocks here too, a deliberate
      // reversal of this route's own previous behavior. It used to be
      // explicitly NOT a hard gate (a self-signed-up admin got instant
      // dashboard access; "pending" existed only for a platform_admin's own
      // visibility). Account creation is now sales-assisted: a self-signup
      // creates a real, logged-in-capable account, but every dashboard
      // route stays blocked until a platform_admin reviews and activates it
      // (PATCH /api/platform/tenants/:id/status) — see README.
      if (liveUser.tenantId) {
        const tenant = await tenantStore.getById(liveUser.tenantId);
        if (!tenant || tenant.status === "suspended" || tenant.status === "cancelled") {
          return res.status(403).json({ error: `This account's business is ${tenant?.status || "no longer available"}. Contact support if this seems wrong.` });
        }
        // Subscription-gated onboarding sequence: awaiting_payment (no
        // plan chosen yet) -> onboarding_pending/onboarding_in_progress
        // (paid, queued for the onboarding team) -> active. Each reads a
        // DIFFERENT flag so the frontend can route to the right screen
        // ("choose your plan" vs "our team's on it") instead of one generic
        // "pending" message covering two very different states.
        if (tenant.status === "awaiting_payment" && !options.allowAwaitingPayment) {
          return res.status(403).json({ error: "Choose a plan to activate your account.", needsPlanSelection: true });
        }
        if (tenant.status === "onboarding_pending" || tenant.status === "onboarding_in_progress" || tenant.status === "pending") {
          return res.status(403).json({ error: "Your account is pending activation. Our team will be in touch shortly — contact support if it's been a while.", pendingActivation: true });
        }
      }
      if (allowedRoles.length && !allowedRoles.includes(liveUser.role)) {
        return res.status(403).json({ error: "You don't have permission to do that." });
      }
      req.user = { uid: liveUser.id, email: liveUser.email, role: liveUser.role, name: liveUser.name, workflowId: liveUser.workflowId, providerId: liveUser.providerId, tenantId: liveUser.tenantId, sid: session.sid };
      next();
    })().catch(next);
  };
}

// Section 14 — the Public API's own auth: `Authorization: Bearer bpk_...`,
// not a session cookie. A valid key resolves straight to a tenantId (the
// key itself proves which tenant, the way a session cookie proves which
// user) — no separate account/role concept on this path, since a Public
// API caller is a tenant's own backend system, not a human choosing
// between admin/provider views. Rate-limited per key (not per route) so
// a single misbehaving integration can't be worked around by hitting a
// different /api/v1/* endpoint.
function requireApiKey(req, res, next) {
  (async () => {
    const header = req.get("Authorization") || "";
    const rawKey = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!rawKey) return res.status(401).json({ error: "Missing Authorization: Bearer <api key> header." });
    if (isApiRateLimited(rawKey)) return res.status(429).json({ error: "Rate limit exceeded — too many requests with this API key." });
    const tenantId = await apiKeys.verify(rawKey);
    if (!tenantId) return res.status(401).json({ error: "Invalid or revoked API key." });
    const tenant = await tenantStore.getById(tenantId);
    if (!tenant || tenant.status !== "active") {
      return res.status(403).json({ error: "This business's account is not currently active." });
    }
    req.apiTenantId = tenantId;
    next();
  })().catch(next);
}

const router = express.Router();

// New plan, Section 2 — verifies the signer actually owns the email
// before anything else happens. Deliberately loose about whether that
// email already has an account (uniform response either way) — telling
// an anonymous caller "that email's taken" is an enumeration leak this
// endpoint doesn't need to have; POST /api/signup below still gives the
// real "an account already exists" error, but only to someone who could
// also prove they own the code that address's real inbox received.
router.post("/api/signup/request-otp", asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== "string" || !email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  if (isOtpRateLimited(email.trim())) {
    log("WARN", `Signup OTP rate-limited for ${email.trim()}`);
    return res.status(429).json({ error: "Too many codes requested for this email. Please wait a while and try again." });
  }
  const code = await createOtp(email.trim());
  await sendEmail(email.trim(), "Your BookPilot AI verification code", `Your verification code is ${code}. It expires in 10 minutes.`);
  res.json({ ok: true, message: "A verification code has been sent to that email." });
}));

// Self-serve signup — the missing link between the public marketing site
// and the dashboard: until now only a platform_admin could create a
// tenant (POST /api/platform/tenants). Creates the tenant AND its first
// admin account in one request (after verifying the OTP from
// POST /api/signup/request-otp above), then logs that admin in (same
// session-cookie mechanism as /api/auth/login below) — but landing a
// session doesn't mean landing in a working dashboard yet, see below.
//
// New tenants default to "pending" status (tenantStore.create's own
// behavior, same as a platform_admin-created one). Unlike before, this IS
// now a hard gate — requireAuth() blocks "pending" the same way it
// already blocked "suspended"/"cancelled" — so a self-signed-up admin can
// log in (the account is real) but every /api/dashboard/* route 403s
// with a clear "pending activation" message until a platform_admin
// reviews and activates the tenant (PATCH /api/platform/tenants/:id/status).
// This is a deliberate reversal of this route's own previous behavior
// (instant self-serve dashboard access) — see README's "Account creation
// & activation" section for why.
router.post("/api/signup", asyncHandler(async (req, res) => {
  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: "Server misconfigured: SESSION_SECRET is not set." });
  }
  if (isSignupRateLimited(req.ip)) {
    log("WARN", `Signup rate-limited for ${req.ip}`);
    return res.status(429).json({ error: "Too many signup attempts. Try again in a while." });
  }

  const { businessName, ownerName, email, password, otp } = req.body || {};
  if (typeof businessName !== "string" || !businessName.trim()) {
    return res.status(400).json({ error: "Business name is required." });
  }
  if (typeof email !== "string" || !email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (!(await verifyOtp(email.trim(), otp))) {
    return res.status(400).json({ error: "That verification code is invalid or has expired. Request a new one and try again." });
  }
  // Found live (audit pass) — checked here, before any tenant is created,
  // specifically to avoid the realistic failure case below: someone who
  // forgot they already signed up retries with the same email, the
  // tenant gets created successfully, and ONLY THEN does users.create()
  // reject the duplicate — leaving a permanently orphaned tenant behind
  // (awaiting_payment, no user attached, unreachable and unlogginable-
  // into forever). This early check closes the common case; the
  // try/catch around users.create() below still cleans up for the rare
  // remaining case (e.g. a genuine race between two signups for the same
  // email) so a stray tenant can never survive a failed signup either way.
  if (await users.findByEmail(email.trim())) {
    return res.status(409).json({ error: "An account already exists for that email — try logging in instead." });
  }

  // Derive a URL-safe slug from the business name, same character rules
  // POST /api/platform/tenants already enforces (lowercase, digits,
  // dashes) — then de-duplicate against existing tenants by suffixing
  // -2, -3, ... rather than rejecting the signup over a name collision a
  // customer has no way to resolve themselves (unlike the platform_admin
  // form, there's no separate "slug" field on this one).
  const baseSlug = businessName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "business";
  let slug = baseSlug;
  for (let suffix = 2; await tenantStore.getBySlug(slug); suffix++) {
    slug = `${baseSlug}-${suffix}`;
  }

  let tenant;
  try {
    tenant = await tenantStore.create({ name: businessName.trim(), slug, plan: "free", billingEmail: email.trim() });
    // create() always starts a tenant "pending" (the platform_admin-created
    // path's own default) — self-signup moves it one step further along
    // to "awaiting_payment" immediately, since this flow's next stop is
    // POST /api/billing/checkout, not a manual activation.
    tenant = await tenantStore.setStatus(tenant.id, "awaiting_payment");
  } catch (err) {
    if (err.code === "DUPLICATE_SLUG") return res.status(409).json({ error: "A business with a very similar name already exists — try a slightly different name." });
    throw err;
  }
  // A brand new tenant starts with zero businesses — a tenant's admin
  // adds their own real businesses from the dashboard right after
  // activation, nothing is auto-seeded any more.

  let user;
  try {
    user = await users.create({ email: email.trim(), password, role: "admin", name: (ownerName || "").trim() || null, tenantId: tenant.id });
  } catch (err) {
    // Belt and suspenders on top of the early findByEmail() check above:
    // that check closes the common case, this closes the rare remaining
    // one (a genuine race between two signups for the same email, or any
    // other failure here) — either way, the tenant this request just
    // created must not survive as an orphan with nothing pointing at it.
    await tenantStore.removeIfOrphaned(tenant.id);
    if (err.code === "DUPLICATE_EMAIL") return res.status(409).json({ error: "An account already exists for that email — try logging in instead." });
    throw err;
  }

  const { token, sessionId } = createSessionToken({
    uid: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    workflowId: user.workflowId,
    providerId: user.providerId,
  });
  await authSessions.create(sessionId, user.id, Date.now() + SESSION_TTL_MS, req.get("User-Agent"));
  setSessionCookie(res, token);
  await recordAudit(tenant.id, user, "tenant.self_signup", { name: tenant.name, slug: tenant.slug });
  log("INFO", `New signup awaiting plan selection: "${tenant.name}" (${tenant.slug}, tenant id ${tenant.id}) — ${user.email}`);
  res.status(201).json({
    ok: true,
    needsPlanSelection: true,
    user: { email: user.email, role: user.role, name: user.name, tenantId: user.tenantId },
  });
}));

router.post("/api/auth/login", asyncHandler(async (req, res) => {
  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: "Server misconfigured: SESSION_SECRET is not set." });
  }
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  const rateLimitKey = `${req.ip}:${email.trim().toLowerCase()}`;
  if (isLoginRateLimited(rateLimitKey)) {
    log("WARN", `Login rate-limited for ${rateLimitKey}`);
    return res.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
  }

  const user = await users.verifyCredentials(email.trim(), password);
  if (!user) {
    log("WARN", `Failed login attempt for ${email.trim()}`);
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const { token, sessionId } = createSessionToken({
    uid: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    workflowId: user.workflowId,
    providerId: user.providerId,
  });
  await authSessions.create(sessionId, user.id, Date.now() + SESSION_TTL_MS, req.get("User-Agent"));
  setSessionCookie(res, token);
  await recordAudit(user.tenantId, user, "login", null);
  res.json({ ok: true, user: { email: user.email, role: user.role, name: user.name, workflowId: user.workflowId, providerId: user.providerId, tenantId: user.tenantId } });
}));

// Section 6 — self-serve password reset. Before this, a lost password
// meant an admin had to re-create the account (`users.create()`), which
// doesn't even work for the ONE admin account on a single-admin install.
// Deliberately returns the identical response whether or not the email
// exists — a different response ("no account found" vs "email sent")
// would let anyone probe which emails have accounts on this system, a
// real (if minor) information leak the login endpoint doesn't have
// (login already fails identically for "wrong password" and "no such
// user"). Rate-limited the same way login attempts are, keyed separately
// so exhausting one doesn't exhaust the other.
router.post("/api/auth/forgot-password", asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "email is required" });
  }
  const rateLimitKey = `reset:${req.ip}:${email.trim().toLowerCase()}`;
  if (isLoginRateLimited(rateLimitKey)) {
    log("WARN", `Password reset rate-limited for ${rateLimitKey}`);
    return res.status(429).json({ error: "Too many reset requests. Try again in a few minutes." });
  }

  const user = await users.findByEmail(email.trim());
  if (user && user.active) {
    const rawToken = await createResetToken(user.id);
    const resetLink = `${req.protocol}://${req.get("host")}/dashboard?resetToken=${rawToken}`;
    await sendEmail(
      user.email,
      "Reset your BookPilot AI password",
      `Someone requested a password reset for this account. If this was you, set a new password here (valid for 1 hour, works once):\n\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`
    );
    await recordAudit(user.tenantId, user, "password_reset.requested", null);
  } else {
    log("INFO", `Password reset requested for unknown/inactive email: ${email.trim()}`);
  }

  // Same message either way — see comment above.
  res.json({ ok: true, message: "If an account exists for that email, a reset link has been sent." });
}));

router.post("/api/auth/reset-password", asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof token !== "string" || !token) return res.status(400).json({ error: "token is required" });
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const userId = await consumeResetToken(token);
  if (!userId) return res.status(400).json({ error: "That reset link is invalid, expired, or already used. Request a new one." });

  const user = await users.setPassword(userId, newPassword);
  await recordAudit(user.tenantId, user, "password_reset.completed", null);
  log("INFO", `Password reset completed for ${user.email}`);
  res.json({ ok: true, message: "Password updated. You can log in with your new password now." });
}));

router.post("/api/auth/logout", asyncHandler(async (req, res) => {
  const session = getSessionUser(req);
  // The token payload itself has no tenantId (deliberately — see
  // requireAuth()'s comment on always re-reading the live row); a quick
  // lookup here is cheap and keeps this audit entry correctly attributed.
  if (session) {
    const liveUser = await users.getById(session.uid);
    await recordAudit(liveUser?.tenantId ?? null, session, "logout", null);
    // New plan, Block 14 — revoke the session server-side too, not just
    // clear the cookie client-side. Without this, a copied/leaked cookie
    // value would keep working for the rest of its 12h lifetime even
    // after the legitimate owner "logged out."
    if (session.sid) await authSessions.revoke(session.sid, session.uid);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// New plan, Block 14 — session list/revoke, the tenant-facing half.
// "Current" is whichever session this very request is authenticated
// with (req.user.sid) — the client needs that to grey out/disable
// revoking the session it's currently looking through.
router.get("/api/auth/sessions", requireAuth(), asyncHandler(async (req, res) => {
  const sessions = (await authSessions.listForUser(req.user.uid)).map((s) => ({ ...s, isCurrent: s.id === req.user.sid }));
  res.json(sessions);
}));

router.delete("/api/auth/sessions/:id", requireAuth(), asyncHandler(async (req, res) => {
  await authSessions.revoke(req.params.id, req.user.uid); // scoped to the caller's own user id — see authSessionStore's own comment
  res.json({ ok: true });
}));

router.get("/api/auth/me", requireAuth(), (req, res) => {
  res.json({ email: req.user.email, role: req.user.role, name: req.user.name, workflowId: req.user.workflowId, providerId: req.user.providerId });
});

module.exports = { router, requireAuth, requireApiKey, getSessionUser, setSessionCookie, clearSessionCookie, SESSION_COOKIE };
