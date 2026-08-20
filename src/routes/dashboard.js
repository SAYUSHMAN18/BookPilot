const path = require("path");
const express = require("express");
const multer = require("multer");
const { log } = require("../infra/logger");
const { asyncHandler } = require("../infra/asyncHandler");
const { requireAuth } = require("./auth");
const bookings = require("../store/bookingStore");
const { blockSlot, unblockSlot, getBlockById, listBlocksForProvider, timeToMinutes } = require("../store/availabilityStore");
const { labelToMinutes, formatLongDate, parseIsoDate } = require("../engine/dateSlots");
const users = require("../store/userStore");
const { recordAudit, listAudit } = require("../store/auditLog");
const { generateWorkflowFromDescription } = require("../ai/workflowGenerator");
const knowledge = require("../store/knowledgeStore");
const templates = require("../store/templateStore");
const { computeAnalytics } = require("../engine/analytics");
const { getUsageSummary, tenantHasFeature, planFeatures } = require("../engine/billing");
const supportRequests = require("../store/supportRequestStore");
const feedbackStore = require("../store/feedbackStore");
const { getErrorRate } = require("../infra/alerting");
const { MAX_DOC_CHARS } = require("../ai/factualQA");
const {
  sendWhatsAppText,
  sendFeedbackRatingList,
  sendWithRetry
} = require("../infra/whatsapp");
const outboundQueueStore = require("../store/outboundQueueStore");
const { computeQueuePosition, sameQueueBookings, markAlerted, wasAlerted, isOptedOutOfAlerts } = require("../store/queueStore");
const tenantStore = require("../store/tenantStore");
const tenantWorkflowStore = require("../store/tenantWorkflowStore");
const paymentStore = require("../store/paymentStore");
const razorpay = require("../infra/paymentProviders/razorpayProvider");
const { refundIfPaid } = require("../engine/paymentRefunds");
const { uploadImage, uploadDocument } = require("../infra/uploads");
const { extractTextFromDocument } = require("../infra/documentExtract");
const { resolveMapsLink } = require("../infra/mapsLinkResolver");
const apiKeys = require("../store/apiKeyStore");
const { syncBookingRescheduled, syncBookingCancelled } = require("../engine/calendarSync");
const { calendarConnections } = require("../store/calendarStore");
const googleCalendar = require("../infra/calendarProviders/googleCalendarProvider");
const { signOAuthState, verifyOAuthState } = require("../infra/oauthState");
const dashboardEvents = require("../infra/dashboardEvents");
const { publishBookingEvent } = require("../infra/publishBookingEvent");
const { isTerminal } = require("../engine/bookingStateMachine");

const router = express.Router();

async function listAllProviders(tenantId) {
  const list = [];
  const workflows = await tenantWorkflowStore.listForTenant(tenantId);
  for (const workflow of Object.values(workflows)) {
    for (const p of workflow.providers || []) {
      list.push({
        workflowId: workflow.id,
        workflowLabel: workflow.label,
        providerId: p.id,
        providerName: p.name,
        providerAttribute: p.attribute || null,
        providerFee: p.fee || null,
        address: p.address || workflow.businessAddress || null,
        mapQuery: p.mapQuery || workflow.mapQuery || null,
        photo: p.photo || null,
        supportsAvailability: true,
        type: "provider",
      });
    }
    for (const hotel of workflow.hotels || []) {
      for (const room of hotel.rooms || []) {
        list.push({
          workflowId: workflow.id,
          workflowLabel: workflow.label,
          providerId: room.id,
          providerName: room.name,           // just the room name — no hotel prefix
          hotelId: hotel.id,
          hotelName: hotel.name,
          hotelLocation: hotel.location || null,
          hotelPhoto: hotel.photo || null,
          mapQuery: hotel.mapQuery || null,
          supportsAvailability: false,
          type: "hotel_room",
        });
      }
    }
  }
  return list;
}

// Item 4 — /dashboard was the hand-rolled dashboard.html shell; that file
// reached full feature parity in the React/Vite app (frontend/, built via
// `npm run build` there into public/app/) and has been deleted, so old
// links/bookmarks/the Google OAuth callback below just redirect to the
// real thing now.
router.get("/dashboard", (req, res) => {
  res.redirect(302, "/app");
});
// Found live: the bare domain root had no route at all, so a visitor who
// just typed/bookmarked the plain URL (a completely normal thing to do —
// this is the dashboard's own domain, not a deep link) fell through to the
// generic catch-all and saw a raw {"error":"Not found"} JSON blob instead
// of the dashboard. Same redirect-to-the-real-thing pattern as /dashboard
// above, just for the other natural entry point.
router.get("/", (req, res) => {
  res.redirect(302, "/app");
});
router.use("/app", express.static(path.join(__dirname, "..", "..", "public", "app")));
// New plan, Stream 4 — the React app now has a real client-side router
// (react-router-dom), so a hard refresh/direct link on any sub-route
// (e.g. /app/bookings) is a real browser navigation to a path express.static
// above has no file for — it calls next() and falls through to here rather
// than 404ing. Always serves the same built index.html; the client router
// takes it from there. Deliberately AFTER the static mount (real asset
// files like /app/assets/x.js must still be served as themselves, not this).
router.get("/app/*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "app", "index.html"));
});
// Item 7 — the go-live journey's persistent checklist. Computed live from
// real state every call (no separate "wizard progress" table to keep in
// sync or let drift) — each item's `done` is a genuine fact about the
// tenant (has any workflow been customized, is a real WhatsApp number
// connected, is there more than just the founding admin, has a booking
// ever landed), not a step someone can check off without doing it.
// `dismissed` persists in the tenant's own feature_flags_json (Section 8's
// existing per-tenant config store) — no schema change needed for it.
router.get("/api/dashboard/setup-checklist", requireAuth("admin"), asyncHandler(async (req, res) => {
  const tenant = await tenantStore.getById(req.user.tenantId);
  const team = await users.list(req.user.tenantId);
  const teamCount = team.length;
  const allBookings = await bookings.values(req.user.tenantId);
  const bookingCount = allBookings.length;

  const items = [
    {
      id: "customize-business",
      label: "Customize your first business",
      done: await tenantWorkflowStore.hasCustomizations(req.user.tenantId),
      hint: "Add your first real business under Manage Businesses — with its own photo (upload or a URL) and location (map pin, or typed coordinates/Maps link) per provider.",
    },
    {
      id: "connect-whatsapp",
      label: "Connect your WhatsApp number",
      done: !!tenant?.whatsappPhoneNumberId,
      hint: "Ask an admin to set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID — or keep testing with simulated messages for now.",
    },
    {
      id: "invite-team",
      label: "Invite your team",
      done: teamCount > 1,
      hint: "Add a login for each provider under Manage Team, so everyone only sees their own bookings.",
    },
    {
      id: "first-booking",
      label: "Get your first booking",
      done: bookingCount > 0,
      hint: "Message your WhatsApp number (or try the simulate endpoint) to see a real booking land here.",
    },
  ];

  res.json({
    items,
    allDone: items.every((i) => i.done),
    dismissed: !!tenant?.featureFlags?.setupChecklistDismissed,
  });
}));

router.post("/api/dashboard/setup-checklist/dismiss", requireAuth("admin"), asyncHandler(async (req, res) => {
  const tenant = await tenantStore.getById(req.user.tenantId);
  await tenantStore.updateConfig(req.user.tenantId, { featureFlags: { ...tenant.featureFlags, setupChecklistDismissed: true } });
  res.json({ ok: true });
}));

// New plan, Block 12 — the tenant's own view of the billing skeleton
// above: which plan they're on and how their usage compares to it this
// month. Admin only, same as everything else that reveals account-level
// (not booking-level) information.
router.get("/api/dashboard/billing", requireAuth("admin"), asyncHandler(async (req, res) => {
  const tenant = await tenantStore.getById(req.user.tenantId);
  res.json(await getUsageSummary(req.user.tenantId, tenant.plan));
}));

router.get("/api/dashboard/providers", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const all = await listAllProviders(req.user.tenantId);
  if (req.user.role === "provider") {
    // Not the roster — only the caller's own entry, so a provider session
    // can render its label without ever learning who else is on the platform.
    return res.json(all.filter((p) => p.workflowId === req.user.workflowId && p.providerId === req.user.providerId));
  }
  res.json(all);
}));

// Admin role view — every booking across every business, one call. The
// client already has /api/dashboard/providers loaded, so it joins on
// workflowId+providerId client-side for human-readable labels rather than
// this endpoint duplicating that lookup server-side. Admin-only: this is
// exactly the cross-business visibility a provider must never get.
router.get("/api/dashboard/all-bookings", requireAuth("admin"), asyncHandler(async (req, res) => {
  res.json(await bookings.values(req.user.tenantId));
}));

router.get("/api/dashboard/audit-log", requireAuth("admin"), asyncHandler(async (req, res) => {
  res.json(await listAudit(req.user.tenantId));
}));

// Backups (Section 5.1) used to live here (a node:sqlite-native online
// backup + manual-trigger/list routes) — removed as part of the Postgres
// migration (src/store/db.js) since that mechanism was SQLite-file-
// specific with no Postgres equivalent. Cloud SQL's own built-in automated
// backups + point-in-time recovery replace it at the infrastructure level
// (see README's deployment section) — a net simplification, not a gap:
// nothing in this app needs to re-implement what the managed database
// already does more reliably.

// Durable outbound queue (Section 5.3) — visibility into proactive sends
// (arrival alerts, feedback requests) that failed their immediate retries
// and are now waiting on the background worker (see startOutboundQueueWorker()
// near app.listen below).
router.get("/api/dashboard/outbound-queue", requireAuth("admin"), asyncHandler(async (req, res) => {
  res.json({
    counts: await outboundQueueStore.statusCounts(req.user.tenantId),
    recent: await outboundQueueStore.listRecent(req.user.tenantId),
  });
}));

// Section 5.4 — the two rates worth an admin's attention at a glance: how
// often the app is erroring (webhook handling, Groq calls, DB writes —
// anything logged at ERROR), and how often proactive WhatsApp sends are
// failing even after retries. Both are already tracked durably/in-memory
// elsewhere (src/alerting.js, src/outboundQueueStore.js) — this just
// surfaces them together in one place instead of an operator having to
// know to check two different things.
router.get("/api/dashboard/alerts", requireAuth("admin"), asyncHandler(async (req, res) => {
  // errorRate is deliberately global, not tenant-scoped — it's a signal
  // about this one Node process's overall health (Groq/DB/webhook
  // errors), not about any tenant's business data, so a tenant admin
  // seeing "the platform had N errors recently" isn't a meaningful leak
  // the way seeing another tenant's bookings/backups would be.
  const outboundCounts = await outboundQueueStore.statusCounts(req.user.tenantId);
  const outboundTotal = outboundCounts.pending + outboundCounts.sent + outboundCounts.failed;
  res.json({
    errorRate: getErrorRate(),
    outboundQueue: {
      ...outboundCounts,
      failureRate: outboundTotal > 0 ? outboundCounts.failed / outboundTotal : 0,
    },
  });
}));

// Business/workflow management — admin only, and (Item 5) tenant-scoped:
// every read/write here goes through tenantWorkflowStore keyed on
// req.user.tenantId, so a save/delete here takes effect immediately for
// that tenant's own WhatsApp bot and dashboard, and is invisible to every
// other tenant, no restart needed.
const WORKFLOW_ID_RE = /^[a-z0-9_-]+$/i;

function validateWorkflowShape(workflow) {
  const hasInventory = workflow?.providers?.length || workflow?.hotels?.length;
  if (!workflow || typeof workflow !== "object") return "Workflow body must be a JSON object.";
  if (!workflow.id || typeof workflow.id !== "string" || !WORKFLOW_ID_RE.test(workflow.id)) {
    return "id is required and must contain only letters, numbers, dashes, and underscores.";
  }
  if (!workflow.label || typeof workflow.label !== "string") return "label is required.";
  if (!hasInventory) return "At least one entry in providers[] or hotels[] is required.";
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) return "steps[] is required and must be non-empty.";
  return null;
}

router.get("/api/dashboard/workflows", requireAuth("admin"), asyncHandler(async (req, res) => {
  res.json(await tenantWorkflowStore.listForTenant(req.user.tenantId));
}));

// Device-upload path for a business/provider photo — the alternative to
// just pasting an externally-hosted image URL, which is all the "Photo
// URL" field on a workflow/provider ever supported before. Returns a URL
// in exactly the same shape ("/uploads/<tenantId>/<file>") that field
// already accepts, so the frontend just writes the response straight into
// it — no separate "uploaded image" concept on the backend.
router.post("/api/dashboard/upload-image", requireAuth("admin"), (req, res) => {
  uploadImage.single("image")(req, res, async (err) => {
    if (err) {
      const message =
        err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
          ? "Image must be 5MB or smaller."
          : err.message || "Upload failed.";
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: "No image file provided." });
    const url = `/uploads/${req.user.tenantId}/${req.file.filename}`;
    await recordAudit(req.user.tenantId, req.user, "image.upload", { filename: req.file.filename, size: req.file.size });
    res.json({ url });
  });
});

// Best-effort auto-fill from a pasted Google Maps / share.google link — see
// src/infra/mapsLinkResolver.js's own comment for exactly what is and
// isn't actually recoverable this way (name: reliably; photo and exact
// coordinates: not from a share.google link, verified live). Never
// silently 200s with nothing found — the frontend needs to tell the admin
// what it could and couldn't fill in.
router.post("/api/dashboard/resolve-maps-link", requireAuth("admin"), asyncHandler(async (req, res) => {
  const { url } = req.body || {};
  if (typeof url !== "string" || !url.trim()) return res.status(400).json({ error: "url is required." });
  try {
    const result = await resolveMapsLink(url.trim());
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// AI Workflow Generator — drafts a workflow from a plain-language
// description, but never writes anything. The admin reviews/edits the
// draft in the same modal used for hand-written JSON, and only the
// existing POST /api/dashboard/workflows below (with its own
// validateWorkflowShape check) actually persists it.
router.post("/api/dashboard/workflows/generate", requireAuth("admin"), asyncHandler(async (req, res) => {
  const { description } = req.body || {};
  if (typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "A business description is required." });
  }
  try {
    const workflow = await generateWorkflowFromDescription(description.trim());
    const validationWarning = validateWorkflowShape(workflow);
    await recordAudit(req.user.tenantId, req.user, "workflow.generate", { description: description.trim().slice(0, 200), valid: !validationWarning });
    res.json({ workflow, validationWarning: validationWarning || null });
  } catch (err) {
    log("ERROR", `Workflow generation failed: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
}));


// Found live (real bug, real WhatsApp number): typing a business by name/id
// mid-flow to switch away from a DIFFERENT business already in progress
// silently failed — the customer stayed stuck in the wrong business's
// current step instead of switching, because couldBeADifferentBusiness()
// (classify.js) and the keyword-fallback classifier both key off
// workflow.keywords, which the admin form never exposes as a field. Every
// business made through it — including the 3 real ones already live —
// had keywords: undefined. Rather than add a whole extra "keywords" UI
// field nobody asked for, this derives a reasonable default from the
// "What it's for" description every business already fills in (it's
// already written as a comma-separated list of terms, e.g. "car service,
// auto repair, vehicle maintenance, spare parts" — exactly keyword shape)
// — only when keywords isn't explicitly set, so raw-JSON authors can still
// hand-pick their own.
function deriveKeywordsFromDescription(description) {
  if (typeof description !== "string") return [];
  return description
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

router.post("/api/dashboard/workflows", requireAuth("admin"), asyncHandler(async (req, res) => {
  const workflow = req.body;
  const validationError = validateWorkflowShape(workflow);
  if (validationError) return res.status(400).json({ error: validationError });
  if (!Array.isArray(workflow.keywords) || workflow.keywords.length === 0) {
    workflow.keywords = deriveKeywordsFromDescription(workflow.description);
  }

  const isUpdate = !!(await tenantWorkflowStore.get(req.user.tenantId, workflow.id));
  await tenantWorkflowStore.upsert(req.user.tenantId, workflow);
  await recordAudit(req.user.tenantId, req.user, isUpdate ? "workflow.update" : "workflow.create", { workflowId: workflow.id });
  log("INFO", `${req.user.email} ${isUpdate ? "updated" : "created"} workflow "${workflow.id}"`);
  res.status(isUpdate ? 200 : 201).json({ ok: true });
}));

router.delete("/api/dashboard/workflows/:id", requireAuth("admin"), asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!(await tenantWorkflowStore.get(req.user.tenantId, id))) return res.status(404).json({ error: "Unknown workflowId" });
  await tenantWorkflowStore.remove(req.user.tenantId, id);
  await recordAudit(req.user.tenantId, req.user, "workflow.delete", { workflowId: id });
  log("INFO", `${req.user.email} deleted workflow "${id}"`);
  res.json({ ok: true });
}));

// Team management — admin only. This is what makes "every business gets
// its own login and only sees its own data" self-serve instead of a CLI
// step: an admin creates one account per doctor/stylist/room here, each
// pinned to exactly one workflowId+providerId, and requireAuth() + the
// per-route ownership checks above do the actual isolation.
// Section 14 — API key management for the Public API above. Admin-only,
// same as Manage Team: issuing a credential another system can act with
// is exactly the kind of action a provider account shouldn't have.
router.get("/api/dashboard/api-keys", requireAuth("admin"), asyncHandler(async (req, res) => {
  res.json(await apiKeys.listForTenant(req.user.tenantId));
}));

router.post("/api/dashboard/api-keys", requireAuth("admin"), asyncHandler(async (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "A name for this key is required (e.g. \"Website integration\")." });
  const { key, record } = await apiKeys.create(req.user.tenantId, name.trim().slice(0, 100));
  await recordAudit(req.user.tenantId, req.user, "api_key.create", { id: record.id, name: record.name });
  log("INFO", `${req.user.email} created API key "${record.name}" (${record.keyPrefix}...).`);
  // The only response that will ever carry the full raw key — shown to
  // the admin exactly once, matching the create/record split in
  // src/store/apiKeyStore.js's own doc comment.
  res.status(201).json({ key, record });
}));

router.delete("/api/dashboard/api-keys/:id", requireAuth("admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  await apiKeys.revoke(req.user.tenantId, id);
  await recordAudit(req.user.tenantId, req.user, "api_key.revoke", { id });
  log("INFO", `${req.user.email} revoked API key ${id}.`);
  res.json({ ok: true });
}));

router.get("/api/dashboard/users", requireAuth("admin"), asyncHandler(async (req, res) => {
  res.json(await users.list(req.user.tenantId));
}));

router.post("/api/dashboard/users", requireAuth("admin"), asyncHandler(async (req, res) => {
  const { email, password, role, name, workflowId, providerId } = req.body || {};
  if (typeof email !== "string" || !email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (role !== "admin" && role !== "provider") {
    return res.status(400).json({ error: "role must be 'admin' or 'provider'." });
  }
  if (role === "provider") {
    if (typeof workflowId !== "string" || typeof providerId !== "string") {
      return res.status(400).json({ error: "workflowId and providerId are required for a provider account." });
    }
    const allProviders = await listAllProviders(req.user.tenantId);
    const matches = allProviders.some((p) => p.workflowId === workflowId && p.providerId === providerId);
    if (!matches) return res.status(400).json({ error: "Unknown workflowId/providerId — pick one from the provider list." });

    // Plan-gated (billing pass, found live): team logins were unlimited
    // on every plan — the marketing site's own pricing implies Enterprise
    // gets more team capacity than Starter/Growth. The tenant's own admin
    // account is exempt (that's the one login that manages the tenant,
    // not a "team member" seat).
    const tenant = await tenantStore.getById(req.user.tenantId);
    const maxTeamMembers = planFeatures(tenant?.plan).maxTeamMembers;
    if (Number.isFinite(maxTeamMembers)) {
      const existingProviderCount = (await users.list(req.user.tenantId)).filter((u) => u.role === "provider").length;
      if (existingProviderCount >= maxTeamMembers) {
        return res.status(403).json({ error: `Your plan allows up to ${maxTeamMembers} team member login(s). Upgrade your plan from the Billing page to add more.` });
      }
    }
  }

  try {
    const user = await users.create({
      email: email.trim(),
      password,
      role,
      name: typeof name === "string" && name.trim() ? name.trim() : null,
      workflowId: role === "provider" ? workflowId : null,
      providerId: role === "provider" ? providerId : null,
      tenantId: req.user.tenantId,
    });
    await recordAudit(req.user.tenantId, req.user, "user.create", { email: user.email, role: user.role, workflowId: user.workflowId, providerId: user.providerId });
    log("INFO", `${req.user.email} created a ${role} account for ${user.email}`);
    res.status(201).json(user);
  } catch (err) {
    if (err.code === "DUPLICATE_EMAIL") return res.status(409).json({ error: err.message });
    log("ERROR", `Failed to create user: ${err.message}`);
    res.status(500).json({ error: "Failed to create account." });
  }
}));

router.patch("/api/dashboard/users/:id", requireAuth("admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (typeof req.body?.active !== "boolean") return res.status(400).json({ error: "active (boolean) is required." });
  if (id === req.user.uid && !req.body.active) {
    return res.status(400).json({ error: "You can't deactivate your own account." });
  }
  const user = await users.setActive(req.user.tenantId, id, req.body.active);
  if (!user) return res.status(404).json({ error: "Not found" });
  await recordAudit(req.user.tenantId, req.user, user.active ? "user.activate" : "user.deactivate", { email: user.email });
  res.json(user);
}));

router.get("/api/dashboard/bookings", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  // A provider session is pinned to exactly one workflowId+providerId —
  // for that role the query params are ignored outright (not merely
  // validated), so there's no way to read someone else's bookings by
  // editing the URL.
  const { workflowId, providerId } = req.user.role === "provider" ? req.user : req.query;
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId query params are required" });
  const allBookings = await bookings.values(req.user.tenantId);
  const rows = allBookings.filter((b) => b.workflowId === workflowId && b.providerId === providerId);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  res.json(rows);
}));
// Provider-initiated booking management.
// Providers can only manage bookings belonging to their own
// workflowId + providerId. Admins can manage all bookings in the tenant.
router.patch(
  "/api/dashboard/bookings/:id",
  requireAuth("admin", "provider"),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid booking id" });
    }

    const booking = await bookings.getById(req.user.tenantId, id);

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Providers may only manage their own bookings.
    if (
      req.user.role === "provider" &&
      (
        booking.workflowId !== req.user.workflowId ||
        booking.providerId !== req.user.providerId
      )
    ) {
      return res.status(403).json({
        error: "You can only manage your own bookings.",
      });
    }

    const {
      action,
      rescheduleDate,
      rescheduleTime,
      note,
    } = req.body || {};

    const cappedNote =
      typeof note === "string"
        ? note.slice(0, 500)
        : null;

    /*
     * ------------------------------------------------------------
     * CANCEL
     * ------------------------------------------------------------
     */
    if (action === "cancel") {
      if (booking.status === "cancelled") {
        return res.status(400).json({
          error: "Booking is already cancelled.",
        });
      }

      // Terminal bookings cannot be changed.
      if (isTerminal(booking.status)) {
        return res.status(400).json({
          error:
            `Cannot cancel a booking that's already marked ` +
            `${booking.status.replace("_", "-")} — ` +
            `it's a completed record, not an active one.`,
        });
      }

      const updated = await bookings.updateWithMeta(
        req.user.tenantId,
        id,
        {
          status: "cancelled",
          cancelledBy: req.user.email,
          rescheduleNote: cappedNote,
        }
      );

      await recordAudit(
        req.user.tenantId,
        req.user,
        "booking.cancel",
        {
          bookingId: booking.bookingId,
          waId: booking.waId,
          workflowId: booking.workflowId,
          note: cappedNote,
        }
      );

      log(
        "INFO",
        `${req.user.email} cancelled booking ` +
        `${booking.bookingId} for ${booking.waId}`
      );

      // Provider cancellation refund policy.
      const workflowForRefund =
        await tenantWorkflowStore.get(
          req.user.tenantId,
          booking.workflowId
        );

      const refundResult = await refundIfPaid(
        req.user.tenantId,
        booking,
        {
          initiatedBy: "provider",
          refundPolicy: workflowForRefund?.refundPolicy,
        }
      );

      // Notify customer.
      const providerLabel =
        booking.providerName || "your provider";

      const whenLabel =
        booking.visitDateLabel ||
        booking.visitDate ||
        booking.checkInIso ||
        "";

      const timeLabel =
        booking.visitTime
          ? ` at ${booking.visitTime}`
          : "";

      const noteText = cappedNote
        ? `\n\nNote from provider: "${cappedNote}"`
        : "";

      const refundText = refundResult.refunded
        ? `\n\n💳 A refund of ₹${refundResult.amount / 100} has been issued.`
        : "";

      const msg =
        `❌ Your booking (${booking.bookingId}) with ${providerLabel}` +
        `${whenLabel ? " on " + whenLabel : ""}` +
        `${timeLabel} has been cancelled by the provider.` +
        noteText +
        refundText +
        `\n\nIf you'd like to rebook, simply message us and we'll find you a new slot.`;

      try {
        await sendWhatsAppText(
          booking.tenantId,
          booking.waId,
          msg
        );
      } catch (err) {
        log(
          "WARN",
          `WhatsApp notification failed for cancel of ` +
          `${booking.bookingId}: ${err.message}`
        );
      }

      await syncBookingCancelled(
        req.user.tenantId,
        booking
      );

      publishBookingEvent(
        req.user.tenantId,
        "booking.updated",
        updated
      );

      return res.json({
        ok: true,
        booking: updated,
        refund: refundResult,
      });
    }

    /*
     * ------------------------------------------------------------
     * RESCHEDULE
     * ------------------------------------------------------------
     */
    if (action === "reschedule") {
      if (
        !rescheduleDate ||
        typeof rescheduleDate !== "string"
      ) {
        return res.status(400).json({
          error:
            "rescheduleDate (YYYY-MM-DD) is required for reschedule.",
        });
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(rescheduleDate)) {
        return res.status(400).json({
          error:
            "rescheduleDate must be in YYYY-MM-DD format.",
        });
      }

      // Terminal bookings cannot be rescheduled.
      // A booking currently being served also cannot be moved.
      if (
        isTerminal(booking.status) ||
        booking.status === "serving"
      ) {
        return res.status(400).json({
          error:
            `Cannot reschedule a booking that's ` +
            `${booking.status === "serving"
              ? "currently being served"
              : `already marked ${booking.status.replace("_", "-")}`
            } — cancel and create a new booking instead.`,
        });
      }

      // Rescheduling currently applies only to time-slot bookings.
      if (!booking.visitTime || !booking.visitDate) {
        return res.status(400).json({
          error:
            "Reschedule only supports time-slot bookings, not hotel stays. " +
            "Cancel and create a new booking for a date-range change.",
        });
      }

      const oldWhen =
        (booking.visitDateLabel ||
          booking.visitDate ||
          "") +
        (booking.visitTime
          ? ` at ${booking.visitTime}`
          : "");

      let updated;

      try {
        updated = await bookings.updateWithMeta(
          req.user.tenantId,
          id,
          {
            status: "booked",

            cancelledBy: req.user.email,

            rescheduledDate: rescheduleDate,
            rescheduledTime: rescheduleTime || null,

            rescheduleNote: cappedNote,

            // IMPORTANT:
            // These are the actual fields used by STATUS,
            // queue calculations, dashboard and slot locking.
            visitDate: rescheduleDate,
            visitTime: rescheduleTime || null,
            visitDateLabel:
              formatLongDate(
                parseIsoDate(rescheduleDate)
              ),
          }
        );
      } catch (err) {
        if (err instanceof bookings.SlotTakenError) {
          return res.status(409).json({
            error:
              "That slot is already booked. Choose a different date/time.",
          });
        }

        throw err;
      }

      await recordAudit(
        req.user.tenantId,
        req.user,
        "booking.reschedule",
        {
          bookingId: booking.bookingId,
          waId: booking.waId,
          oldDate: booking.visitDate,
          oldTime: booking.visitTime,
          newDate: rescheduleDate,
          newTime: rescheduleTime || null,
          note: cappedNote,
        }
      );

      log(
        "INFO",
        `${req.user.email} rescheduled booking ` +
        `${booking.bookingId} for ${booking.waId} → ` +
        `${rescheduleDate} ${rescheduleTime || ""}`
      );

      // Notify customer.
      const providerLabel =
        booking.providerName || "your provider";

      const newWhen =
        rescheduleDate +
        (rescheduleTime
          ? ` at ${rescheduleTime}`
          : "");

      const noteText = cappedNote
        ? `\n\nMessage from provider: "${cappedNote}"`
        : "";

      const msg =
        `📅 Your booking (${booking.bookingId}) with ` +
        `${providerLabel} has been rescheduled by the provider.` +
        (oldWhen
          ? `\n\nOld: ${oldWhen}`
          : "") +
        `\nNew: ${newWhen}` +
        noteText +
        `\n\nReply STATUS to see your updated booking details.`;

      try {
        await sendWhatsAppText(
          booking.tenantId,
          booking.waId,
          msg
        );
      } catch (err) {
        log(
          "WARN",
          `WhatsApp notification failed for reschedule of ` +
          `${booking.bookingId}: ${err.message}`
        );
      }

      const workflowForCalendar =
        await tenantWorkflowStore.get(
          req.user.tenantId,
          updated.workflowId
        );

      await syncBookingRescheduled(
        req.user.tenantId,
        updated,
        workflowForCalendar
      );

      publishBookingEvent(
        req.user.tenantId,
        "booking.updated",
        updated
      );

      return res.json({
        ok: true,
        booking: updated,
      });
    }

    /*
     * ------------------------------------------------------------
     * NO-SHOW
     * ------------------------------------------------------------
     */
    if (action === "no_show") {
      if (!booking.visitTime || !booking.visitDate) {
        return res.status(400).json({
          error:
            "no_show only applies to a time-slot booking.",
        });
      }

      if (isTerminal(booking.status)) {
        return res.status(400).json({
          error:
            `Cannot mark a ${booking.status} booking as no-show.`,
        });
      }

      const updated = await bookings.updateWithMeta(
        req.user.tenantId,
        id,
        {
          status: "no_show",
          providerNote: cappedNote,
        }
      );

      const workflowForNoShow =
        await tenantWorkflowStore.get(
          req.user.tenantId,
          booking.workflowId
        );

      const policy =
        workflowForNoShow?.refundPolicy?.noShow;

      let refundResult = {
        refunded: false,
      };

      if (policy === "refund") {
        refundResult = await refundIfPaid(
          req.user.tenantId,
          booking,
          {
            initiatedBy: "provider",
            refundPolicy: {
              providerCancellation: "full",
            },
          }
        );
      } else {
        // Default: retain an already-paid deposit.
        const paymentsForBooking =
          await paymentStore.listForBooking(
            req.user.tenantId,
            booking.id
          );

        const hadPaidDeposit =
          paymentsForBooking.some(
            (p) => p.status === "paid"
          );

        if (hadPaidDeposit) {
          log(
            "INFO",
            `Deposit retained for no-show booking ` +
            `${booking.bookingId} ` +
            `(policy: retain, the default).`
          );
        }
      }

      await recordAudit(
        req.user.tenantId,
        req.user,
        "booking.no_show",
        {
          bookingId: booking.bookingId,
          waId: booking.waId,
          refunded: refundResult.refunded,
        }
      );

      log(
        "INFO",
        `${req.user.email} marked booking ` +
        `${booking.bookingId} as no-show.`
      );

      publishBookingEvent(
        req.user.tenantId,
        "booking.updated",
        updated
      );

      return res.json({
        ok: true,
        booking: updated,
        refund: refundResult,
      });
    }

    if (
      (action === "serve" || action === "complete") &&
      isTerminal(booking.status)
    ) {
      return res.status(400).json({
        error:
          `Cannot mark a booking that's already ` +
          `${booking.status.replace("_", "-")} as ${action === "serve" ? "serving" : "complete"}.`,
      });
    }

    /*
     * ------------------------------------------------------------
     * SERVE
     * ------------------------------------------------------------
     */
    if (action === "serve") {
      const allBookings =
        await bookings.values(
          req.user.tenantId
        );

      for (const other of allBookings) {
        if (
          other.id !== booking.id &&
          other.workflowId === booking.workflowId &&
          other.providerId === booking.providerId &&
          other.visitDate === booking.visitDate &&
          other.status === "serving"
        ) {
          await bookings.updateWithMeta(
            req.user.tenantId,
            other.id,
            {
              status: "done",
            }
          );
        }
      }
    }

    /*
     * ------------------------------------------------------------
     * COMPLETE / SERVE STATUS UPDATE
     * ------------------------------------------------------------
     */
    if (action !== "serve" && action !== "complete") {
      return res.status(400).json({
        error:
          'action must be "cancel", "reschedule", "serve", "complete", or "no_show".',
      });
    }

    const newStatus =
      action === "serve"
        ? "serving"
        : "done";

    const updated =
      await bookings.updateWithMeta(
        req.user.tenantId,
        id,
        {
          status: newStatus,
          providerNote: cappedNote,
          feedbackRequestedAt:
            action === "complete"
              ? Date.now()
              : null,
        }
      );

    await recordAudit(
      req.user.tenantId,
      req.user,
      `booking.${action}`,
      {
        bookingId: booking.bookingId,
        waId: booking.waId,
        note: cappedNote,
      }
    );

    log(
      "INFO",
      `${req.user.email} marked booking ` +
      `${booking.bookingId} as ${newStatus}`
    );

    /*
     * ------------------------------------------------------------
     * QUEUE SHIFT NOTIFICATION
     * ------------------------------------------------------------
     */
    if (
      action === "serve" &&
      booking.visitTime
    ) {
      await notifyQueueShifts(
        req.user.tenantId,
        booking.workflowId,
        booking.providerId,
        booking.visitDate,
        id
      );
    }

    /*
     * ------------------------------------------------------------
     * COMPLETION + FEEDBACK
     * ------------------------------------------------------------
     */
    if (action === "complete") {
      const providerLabel =
        booking.providerName ||
        "your provider";

      const noteText = cappedNote
        ? `\n\n📝 Note from ${providerLabel}: "${cappedNote}"`
        : "";

      const msg =
        `✅ Your visit with ${providerLabel} is complete.` +
        `${noteText}\n\n` +
        "How was your visit? Please select a rating below, " +
        "or reply with a few words.";

      const sent = await sendWithRetry(
        booking.tenantId,
        booking.waId,
        msg
      );

      if (!sent) {
        log(
          "WARN",
          `Completion/feedback-request message to ` +
          `${booking.waId} for booking ${booking.bookingId} ` +
          `queued for durable retry after immediate attempts failed.`
        );
      }

      // Send the clickable 1–5 rating list.
      try {
        await sendFeedbackRatingList(booking.tenantId, booking.waId);
      } catch (err) {
        log(
          "WARN",
          `Failed to send feedback rating list to ` +
          `${booking.waId}: ${err.message}`
        );
      }
    }

    publishBookingEvent(
      req.user.tenantId,
      "booking.updated",
      updated
    );

    return res.json({
      ok: true,
      booking: updated,
    });
  })
);

// Hard delete — admin-only.
// Providers should use cancel/no-show rather than permanently deleting
// booking records.
router.delete(
  "/api/dashboard/bookings/:id",
  requireAuth("admin"),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: "Invalid booking id",
      });
    }

    const booking =
      await bookings.getById(
        req.user.tenantId,
        id
      );

    if (!booking) {
      return res.status(404).json({
        error: "Booking not found",
      });
    }

    await bookings.remove(
      req.user.tenantId,
      id
    );

    await recordAudit(
      req.user.tenantId,
      req.user,
      "booking.delete",
      {
        bookingId: booking.bookingId,
        waId: booking.waId,
      }
    );

    log(
      "INFO",
      `${req.user.email} permanently deleted booking ` +
      `${booking.bookingId}.`
    );

    res.json({
      ok: true,
    });
  })
);

// Recomputes live queue position for everyone else still active
// in this provider's queue for this date.
async function notifyQueueShifts(
  tenantId,
  workflowId,
  providerId,
  date,
  excludeId
) {
  const others =
    await sameQueueBookings(
      tenantId,
      workflowId,
      providerId,
      date,
      excludeId
    );

  for (const other of others) {
    const position =
      await computeQueuePosition(other);

    if (position !== 0) {
      continue;
    }

    if (
      await wasAlerted(
        tenantId,
        other.id
      )
    ) {
      continue;
    }

    if (
      await isOptedOutOfAlerts(
        other.waId
      )
    ) {
      continue;
    }

    // Mark first so repeated requests cannot create an alert storm.
    await markAlerted(
      tenantId,
      other.id
    );

    const sent = await sendWithRetry(
      tenantId,
      other.waId,
      `🔔 You're next! ${other.providerName} ` +
      `will see you shortly for your ${other.visitTime} appointment.` +
      `\n\n(Reply STOP ALERTS to turn these off.)`
    );

    if (!sent) {
      log(
        "WARN",
        `"You're next" alert to ${other.waId} ` +
        `for booking ${other.bookingId} queued for durable retry ` +
        `after immediate attempts failed.`
      );
    }
  }
}

// Recomputes live queue position for everyone else still active in this
// provider's queue for this date and sends a one-time "you're next" alert
// to anyone who just crossed into position 0 — called after any action
// that could shift the queue (serve/complete). Best-effort: uses
// sendWithRetry (Section 3.6's stopgap retry) so a transient WhatsApp API
// failure doesn't just silently drop the alert, but a failure here never
// blocks or fails the triggering request itself.
async function notifyQueueShifts(tenantId, workflowId, providerId, date, excludeId) {
  const others = await sameQueueBookings(tenantId, workflowId, providerId, date, excludeId);
  for (const other of others) {
    const position = await computeQueuePosition(other);
    if (position !== 0) continue;
    if (await wasAlerted(tenantId, other.id)) continue;
    if (await isOptedOutOfAlerts(other.waId)) continue;

    await markAlerted(tenantId, other.id); // mark first — never re-attempt-storm the same alert if the send itself throws
    const sent = await sendWithRetry(
      tenantId,
      other.waId,
      `🔔 You're next! ${other.providerName} will see you shortly for your ${other.visitTime} appointment.\n\n(Reply STOP ALERTS to turn these off.)`
    );
    if (!sent) log("WARN", `"You're next" alert to ${other.waId} for booking ${other.bookingId} queued for durable retry after immediate attempts failed.`);
  }
}



router.get("/api/dashboard/availability", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const { workflowId, providerId } = req.user.role === "provider" ? req.user : req.query;
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId query params are required" });
  res.json(await listBlocksForProvider(req.user.tenantId, workflowId, providerId));
}));

router.post("/api/dashboard/availability", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const workflowId = req.user.role === "provider" ? req.user.workflowId : body.workflowId;
  const providerId = req.user.role === "provider" ? req.user.providerId : body.providerId;
  const { date, time, endTime, reason } = body;
  if (typeof workflowId !== "string" || typeof providerId !== "string" || typeof date !== "string") {
    return res.status(400).json({ error: "workflowId, providerId, and date are required strings" });
  }
  if (!(await tenantWorkflowStore.get(req.user.tenantId, workflowId))) return res.status(400).json({ error: "Unknown workflowId" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
  if (time !== undefined && time !== null && typeof time !== "string") {
    return res.status(400).json({ error: "time must be a string (or omitted to block the whole day)" });
  }
  if (endTime !== undefined && endTime !== null && typeof endTime !== "string") {
    return res.status(400).json({ error: "endTime must be a string, or omitted" });
  }
  if (endTime && !time) {
    return res.status(400).json({ error: "endTime needs a time (the range's start) too." });
  }
  // 2.4: start < end, checked server-side regardless of what the <input
  // type="time"> pair in the dashboard already enforces client-side.
  if (time && endTime && timeToMinutes(endTime) <= timeToMinutes(time)) {
    return res.status(400).json({ error: "endTime must be after time." });
  }

  const cappedReason = typeof reason === "string" ? reason.slice(0, 200) : null;
  await blockSlot(req.user.tenantId, workflowId, providerId, date, time || null, endTime || null, cappedReason);
  await recordAudit(req.user.tenantId, req.user, "availability.block", { workflowId, providerId, date, time: time || null, endTime: endTime || null, reason: cappedReason });

  // Advisory, not a hard reject — surface which existing bookings fall
  // inside the new block so the provider can decide whether to also
  // cancel/reschedule them, rather than the block silently coexisting
  // with confirmed bookings it now conflicts with (Section 2.4).
  let conflictingBookings = [];
  if (time) {
    const startMin = timeToMinutes(time);
    const endMin = endTime ? timeToMinutes(endTime) : startMin + 1;
    const allBookings = await bookings.values(req.user.tenantId);
    conflictingBookings = allBookings
      .filter((b) => {
        if (b.workflowId !== workflowId || b.providerId !== providerId || b.visitDate !== date || b.status === "cancelled" || !b.visitTime) {
          return false;
        }
        const bookedMin = labelToMinutes(b.visitTime);
        return bookedMin !== null && bookedMin >= startMin && bookedMin < endMin;
      })
      .map((b) => ({ bookingId: b.bookingId, customerName: b.customerName, visitTime: b.visitTime }));
  }

  res.status(201).json({ ok: true, conflictingBookings });
}));

router.delete("/api/dashboard/availability/:id", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const block = await getBlockById(req.user.tenantId, id);
  if (!block) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && (block.workflowId !== req.user.workflowId || block.providerId !== req.user.providerId)) {
    return res.status(403).json({ error: "You can only remove your own availability blocks." });
  }
  await unblockSlot(req.user.tenantId, id);
  await recordAudit(req.user.tenantId, req.user, "availability.unblock", { id, workflowId: block.workflowId, providerId: block.providerId, date: block.date, time: block.time, endTime: block.endTime });
  res.json({ ok: true });
}));

// Support requests — what makes human escalation (Section 1.4) land
// somewhere real instead of a dead end. Same role scoping as every other
// resource: a provider sees only requests tied to their own workflow (or
// with no workflow yet resolved — a fresh complaint before the customer
// named a business — which nobody can scope, so only admin sees those).
router.get("/api/dashboard/support-requests", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const list = req.user.role === "provider"
    ? await supportRequests.listForWorkflow(req.user.tenantId, req.user.workflowId)
    : await supportRequests.listAll(req.user.tenantId);
  res.json(list);
}));

router.patch("/api/dashboard/support-requests/:id", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (typeof req.body?.resolved !== "boolean") return res.status(400).json({ error: "resolved (boolean) is required." });
  const existing = await supportRequests.getById(req.user.tenantId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && existing.workflowId !== req.user.workflowId) {
    return res.status(403).json({ error: "You can only manage support requests for your own business." });
  }
  const updated = await supportRequests.setResolved(req.user.tenantId, id, req.body.resolved);
  await recordAudit(req.user.tenantId, req.user, updated.resolved ? "support_request.resolve" : "support_request.reopen", { id, waId: updated.waId });
  res.json(updated);
}));

// Feedback (Section 4) — same role scoping as everything else.
router.get("/api/dashboard/feedback", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const list = req.user.role === "provider" ? await feedbackStore.listForWorkflow(req.user.tenantId, req.user.workflowId) : await feedbackStore.listAll(req.user.tenantId);
  // Joined with the booking's own label fields client-side needs (booking
  // id, customer name) so the dashboard doesn't have to make a second
  // round trip per row to make sense of who left what.
  const withBookingInfo = await Promise.all(list.map(async (f) => {
    const b = await bookings.getById(req.user.tenantId, f.bookingId);
    return { ...f, bookingLabel: b?.bookingId || null, customerName: b?.customerName || null, workflowId: b?.workflowId || null };
  }));
  res.json(withBookingInfo);
}));

// Analytics — same role scoping as every other dashboard route: a
// provider only ever gets their own numbers (the query params are ignored
// for that role, not merely validated), an admin gets platform-wide.
router.get("/api/dashboard/analytics", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const scope = req.user.role === "provider"
    ? { workflowId: req.user.workflowId, providerId: req.user.providerId }
    : { workflowId: req.query.workflowId || null, providerId: req.query.providerId || null };
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
  res.json(await computeAnalytics({ tenantId: req.user.tenantId, ...scope, days }));
}));

// Section 9.8 — payment visibility + the manual "issue refund" escape
// hatch for whatever the automatic cancellation-triggered flow doesn't
// cover (a partial goodwill refund outside the stated policy, a payment
// stuck in a state the webhook never resolved, etc.).
router.get("/api/dashboard/payments", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const list = await paymentStore.listForTenant(req.user.tenantId);
  // Provider role sees only payments for their own bookings — same
  // ownership-check style as GET /api/dashboard/feedback above (a join
  // back to bookings, since payments itself doesn't carry workflow/
  // provider id — it only ever needs tenant_id + booking_id).
  let scoped = list;
  if (req.user.role === "provider") {
    const flags = await Promise.all(list.map(async (p) => {
      const b = await bookings.getById(req.user.tenantId, p.bookingId);
      return b && b.workflowId === req.user.workflowId && b.providerId === req.user.providerId;
    }));
    scoped = list.filter((_, i) => flags[i]);
  }
  const withBookingInfo = await Promise.all(scoped.map(async (p) => {
    const b = await bookings.getById(req.user.tenantId, p.bookingId);
    return { ...p, bookingLabel: b?.bookingId || null, customerName: b?.customerName || null, workflowId: b?.workflowId || null };
  }));
  res.json(withBookingInfo);
}));

router.post("/api/dashboard/payments/:id/refund", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const payment = await paymentStore.getById(req.user.tenantId, id);
  if (!payment) return res.status(404).json({ error: "Not found" });
  if (payment.status !== "paid") return res.status(400).json({ error: `Cannot refund a payment with status "${payment.status}" — only a paid payment can be refunded.` });

  const booking = await bookings.getById(req.user.tenantId, payment.bookingId);
  if (req.user.role === "provider" && booking && (booking.workflowId !== req.user.workflowId || booking.providerId !== req.user.providerId)) {
    return res.status(403).json({ error: "You can only refund payments for your own bookings." });
  }

  const { amount } = req.body || {}; // optional partial-refund amount in rupees; omitted = full refund
  const refundAmountPaise = typeof amount === "number" && amount > 0 ? Math.round(amount * 100) : undefined;
  if (refundAmountPaise !== undefined && refundAmountPaise > payment.amount) {
    return res.status(400).json({ error: "Refund amount cannot exceed the original payment amount." });
  }

  try {
    const refund = await razorpay.createRefund({ providerPaymentId: payment.providerPaymentId, amount: refundAmountPaise });
    const finalAmount = refundAmountPaise ?? payment.amount;
    const status = finalAmount >= payment.amount ? "refunded" : "partially_refunded";
    await paymentStore.markRefunded(payment.id, status, refund.status, finalAmount);
    if (booking) {
      await bookings.updatePaymentStatus(req.user.tenantId, booking.id, status);
      publishBookingEvent(req.user.tenantId, "booking.updated", { ...booking, paymentStatus: status });
    }
    await recordAudit(req.user.tenantId, req.user, "payment.manual_refund", { paymentId: payment.id, bookingId: payment.bookingId, amount: finalAmount });
    log("INFO", `${req.user.email} manually refunded ₹${finalAmount / 100} for payment ${payment.id} (booking ${payment.bookingId}).`);
    res.json({ ok: true, refundAmount: finalAmount, status });
  } catch (err) {
    log("ERROR", `Manual refund failed for payment ${payment.id}: ${err.message}`);
    res.status(502).json({ error: `Refund failed: ${err.message}` });
  }
}));

// Section 10.2 — Google Calendar OAuth. A provider session is pinned to
// exactly one workflowId+providerId (same pattern as GET
// /api/dashboard/bookings above); an admin acting on a specific
// provider's behalf must pass both as query params/body fields.
function resolveWorkflowProvider(req) {
  return req.user.role === "provider" ? { workflowId: req.user.workflowId, providerId: req.user.providerId } : { workflowId: req.query.workflowId || req.body?.workflowId, providerId: req.query.providerId || req.body?.providerId };
}

router.get("/api/dashboard/calendar/status", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const { workflowId, providerId } = resolveWorkflowProvider(req);
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId are required" });
  const connection = await calendarConnections.getForProvider(req.user.tenantId, workflowId, providerId);
  res.json({ configured: googleCalendar.isConfigured(), connection: calendarConnections.toPublicView(connection) });
}));

// A real browser top-level navigation (the "Connect Calendar" button is a
// plain link, not a fetch call) — redirects to Google's own consent
// screen rather than returning JSON, since there's no XHR caller to hand
// JSON back to.
router.get("/api/dashboard/calendar/connect", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const { workflowId, providerId } = resolveWorkflowProvider(req);
  if (!workflowId || !providerId) return res.status(400).send("workflowId and providerId are required.");
  if (!googleCalendar.isConfigured()) {
    return res.status(503).send("Google Calendar isn't configured on this server yet (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI). Ask an admin to set it up.");
  }
  // Plan-gated (billing pass, found live): matches the "not configured"
  // response above in spirit — this is a real, working feature the
  // marketing site already claims as Growth-only, so a Starter tenant
  // gets an honest explanation here instead of silently working anyway.
  if (!(await tenantHasFeature(req.user.tenantId, "calendarSync"))) {
    return res.status(403).send("Calendar sync is a Growth-plan feature. Upgrade your plan from the Billing page to connect Google Calendar.");
  }
  const state = signOAuthState({ tenantId: req.user.tenantId, workflowId, providerId });
  res.redirect(googleCalendar.getAuthUrl(state));
}));

// Google redirects the browser here after consent. Not JSON — this is a
// top-level navigation, so it redirects back into the dashboard UI with a
// query flag the frontend reads to show a toast, same shape as any
// OAuth-callback page.
router.get("/api/dashboard/calendar/callback", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/dashboard?calendar=error&message=${encodeURIComponent(String(error))}`);

  const statePayload = verifyOAuthState(state);
  if (!statePayload || statePayload.tenantId !== req.user.tenantId) {
    return res.redirect(`/dashboard?calendar=error&message=${encodeURIComponent("Invalid or expired connection request — please try again.")}`);
  }
  if (!code || typeof code !== "string") {
    return res.redirect(`/dashboard?calendar=error&message=${encodeURIComponent("Google did not return an authorization code.")}`);
  }

  try {
    const tokens = await googleCalendar.exchangeCodeForTokens(code);
    await calendarConnections.create(req.user.tenantId, statePayload.workflowId, statePayload.providerId, {
      calendarType: "google",
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
    });
    await recordAudit(req.user.tenantId, req.user, "calendar.connect", { workflowId: statePayload.workflowId, providerId: statePayload.providerId });
    log("INFO", `${req.user.email} connected Google Calendar for ${statePayload.workflowId}/${statePayload.providerId}.`);
    res.redirect("/dashboard?calendar=connected");
  } catch (err) {
    log("ERROR", `Google Calendar connection failed for tenant ${req.user.tenantId}: ${err.message}`);
    res.redirect(`/dashboard?calendar=error&message=${encodeURIComponent(err.message)}`);
  }
}));

router.post("/api/dashboard/calendar/disconnect", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const { workflowId, providerId } = resolveWorkflowProvider(req);
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId are required" });
  const connection = await calendarConnections.getForProvider(req.user.tenantId, workflowId, providerId);
  if (!connection) return res.status(404).json({ error: "No active calendar connection to disconnect." });
  await calendarConnections.disconnect(req.user.tenantId, connection.id);
  await recordAudit(req.user.tenantId, req.user, "calendar.disconnect", { workflowId, providerId });
  log("INFO", `${req.user.email} disconnected Google Calendar for ${workflowId}/${providerId}.`);
  res.json({ ok: true });
}));

// Requested directly: a Starter tenant books through the shared platform
// WhatsApp number; Growth/Enterprise can connect their OWN WhatsApp
// Business number instead, so only their business's own customers ever
// reach it. The infrastructure for this already existed (tenantStore.
// setWhatsAppCredentials, and src/routes/webhook.js already routes an
// incoming message by phone_number_id — see its own comment) but was
// platform-admin-only (PATCH /api/platform/tenants/:id/config); this is
// the tenant-facing self-service version, gated on plan.
//
// Unlike Calendar sync above, there's no OAuth flow to redirect through —
// a business gets their phoneNumberId/businessAccountId/accessToken from
// their own Meta Business Manager / WhatsApp Cloud API setup (a real
// external prerequisite this app has no way to provision for them), so
// this is a plain form submitting those three values, not a "Connect"
// button.
router.get("/api/dashboard/whatsapp-number/status", requireAuth("admin"), asyncHandler(async (req, res) => {
  const tenant = await tenantStore.getById(req.user.tenantId);
  res.json({
    eligible: !!planFeatures(tenant?.plan).ownWhatsAppNumber,
    // phoneNumberId is an identifier, not a secret (Meta shows it in
    // plain text in their own dashboard) — safe to return. The access
    // token itself never leaves setWhatsAppCredentials/the DB.
    connected: !!(tenant?.whatsappPhoneNumberId && tenant?.whatsappAccessToken),
    phoneNumberId: tenant?.whatsappPhoneNumberId || null,
  });
}));

router.post("/api/dashboard/whatsapp-number/connect", requireAuth("admin"), asyncHandler(async (req, res) => {
  if (!(await tenantHasFeature(req.user.tenantId, "ownWhatsAppNumber"))) {
    return res.status(403).json({ error: "Connecting your own WhatsApp number is a Growth-plan feature. Upgrade your plan from the Billing page." });
  }
  const { phoneNumberId, businessAccountId, accessToken } = req.body || {};
  if (!phoneNumberId?.trim() || !accessToken?.trim()) {
    return res.status(400).json({ error: "phoneNumberId and accessToken are required — find both in your Meta Business Manager's WhatsApp Cloud API setup." });
  }

  // A phone_number_id can only ever belong to one tenant — this is the
  // ONLY signal webhook.js uses to route an incoming message (see its own
  // comment) — so two tenants sharing one would mean whichever connected
  // it SECOND silently steals the first tenant's customer conversations.
  // The DB's own UNIQUE constraint (src/store/db.js) would reject this
  // regardless; checking first gives a clear, actionable error instead of
  // a bare constraint-violation message.
  const existingOwner = await tenantStore.getByPhoneNumberId(phoneNumberId.trim());
  if (existingOwner && existingOwner.id !== req.user.tenantId) {
    return res.status(409).json({ error: "This WhatsApp number is already connected to a different BookPilot account." });
  }

  try {
    const updated = await tenantStore.setWhatsAppCredentials(req.user.tenantId, {
      phoneNumberId: phoneNumberId.trim(),
      businessAccountId: businessAccountId?.trim() || null,
      accessToken: accessToken.trim(),
    });
    await recordAudit(req.user.tenantId, req.user, "whatsapp_number.connect", { phoneNumberId: updated.whatsappPhoneNumberId });
    log("INFO", `${req.user.email} connected their own WhatsApp number for tenant ${req.user.tenantId}.`);
    res.json({ ok: true, phoneNumberId: updated.whatsappPhoneNumberId });
  } catch (err) {
    // Same specific-error-over-opaque-500 reasoning as the platform-admin
    // version of this (APP_ENCRYPTION_KEY not set on this server yet) —
    // a tenant admin can't fix that themselves, but at least knows to
    // contact support with a real reason instead of "something broke."
    return res.status(400).json({ error: err.message });
  }
}));

router.post("/api/dashboard/whatsapp-number/disconnect", requireAuth("admin"), asyncHandler(async (req, res) => {
  const tenant = await tenantStore.getById(req.user.tenantId);
  if (!tenant?.whatsappPhoneNumberId) return res.status(404).json({ error: "No WhatsApp number is currently connected." });
  // Clears back to null, not to some other value — webhook.js's own
  // fallback (no tenant claims a phone_number_id -> tenant 1) only
  // applies when NO tenant has ever claimed one; every other tenant with
  // nothing connected here simply has no way to receive a direct message,
  // which is correct: they're back to using the shared platform number,
  // routed the same way it already was before they ever connected their own.
  await tenantStore.setWhatsAppCredentials(req.user.tenantId, { phoneNumberId: null, businessAccountId: null, accessToken: null });
  await recordAudit(req.user.tenantId, req.user, "whatsapp_number.disconnect", {});
  log("INFO", `${req.user.email} disconnected their own WhatsApp number for tenant ${req.user.tenantId}.`);
  res.json({ ok: true });
}));

// Section 11 — Server-Sent Events. A dashboard tab open on GET
// /api/dashboard/bookings-shaped data used to only ever learn about a new
// booking, cancellation, or support escalation by the user clicking
// "Refresh" (or the periodic poll a few other dashboards resort to) —
// this makes it push instead. Plain SSE (EventSource), not WebSockets:
// one-directional (server -> browser) is all the dashboard ever needed,
// SSE auto-reconnects on its own with zero client code, and it rides
// over a normal HTTPS GET (no extra infra, no new dependency) — the same
// "simplest thing that's actually correct" bias as everywhere else in
// this codebase.
//
// A provider session only ever receives events for its own
// workflowId+providerId, OR workflow-scoped events (support requests)
// that don't carry a providerId at all — never another provider's
// bookings, even within the same tenant. An admin session receives every
// event for its own tenant, matching the same full-tenant visibility
// GET /api/dashboard/all-bookings already grants.
// Section 12 — each open SSE connection holds a socket + a heartbeat
// timer for as long as it's open; nothing previously stopped one browser
// tab (or a malicious/buggy client scripting `new EventSource(...)` in a
// loop) from opening an unbounded number of them under the same account
// and slowly exhausting the process's file descriptors. A small per-user
// cap closes that gap without needing a general-purpose connection-limit
// middleware — SSE is the only long-lived connection this app holds
// open, so it's the only place this matters.
const MAX_SSE_CONNECTIONS_PER_USER = 5;
const sseConnectionsByUser = new Map(); // uid -> count

router.get("/api/dashboard/events", requireAuth("admin", "provider"), (req, res) => {
  const { uid, tenantId, role, workflowId, providerId } = req.user;

  const openCount = sseConnectionsByUser.get(uid) || 0;
  if (openCount >= MAX_SSE_CONNECTIONS_PER_USER) {
    return res.status(429).json({ error: "Too many open live-update connections for this account. Close some other dashboard tabs and try again." });
  }
  sseConnectionsByUser.set(uid, openCount + 1);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disables proxy buffering if this ever runs behind nginx
  });
  res.write(":connected\n\n"); // opens the stream immediately rather than waiting for the first real event

  const unsubscribe = dashboardEvents.subscribe((evt) => {
    if (evt.tenantId !== tenantId) return;
    if (role === "provider") {
      if (evt.payload?.workflowId !== workflowId) return;
      // Some event types (support_request.created) are workflow-scoped,
      // not tied to one provider — only filter on providerId when the
      // event actually carries one.
      if (evt.payload?.providerId && evt.payload.providerId !== providerId) return;
    }
    res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
  });

  // Keeps the connection alive through any intermediary that would
  // otherwise time out an idle HTTP connection (a load balancer, some
  // browsers) — a comment line, not a real event, so it's invisible to
  // EventSource's onmessage/addEventListener.
  const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    const remaining = (sseConnectionsByUser.get(uid) || 1) - 1;
    if (remaining <= 0) sseConnectionsByUser.delete(uid);
    else sseConnectionsByUser.set(uid, remaining);
  });
});

// Marketplace — publish a working business as a reusable template (shared
// across every tenant, deliberately — see workflow_templates' own comment
// in src/store/db.js), then install it later (into any tenant, or another
// business within the same one) as a fresh, tenant-owned workflow. Admin
// only: installing makes it live for that tenant's WhatsApp bot
// immediately, same blast radius as creating one by hand.
router.get("/api/dashboard/templates", requireAuth("admin"), asyncHandler(async (req, res) => {
  // Strip the full definition from the list — it can be large and the
  // browser only needs it at install time, which re-fetches by id.
  const list = await templates.list();
  res.json(list.map(({ definition, ...rest }) => ({
    ...rest,
    stepCount: definition.steps?.length ?? 0,
    providerCount: definition.providers?.length ?? definition.hotels?.length ?? 0,
  })));
}));

router.post("/api/dashboard/templates", requireAuth("admin"), asyncHandler(async (req, res) => {
  const { workflowId, name, industry, description } = req.body || {};
  const source = await tenantWorkflowStore.get(req.user.tenantId, workflowId);
  if (!source) return res.status(400).json({ error: "Unknown workflowId — publish from an existing business." });
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "A template name is required." });

  const template = await templates.create({
    name: name.trim().slice(0, 120),
    industry: typeof industry === "string" ? industry.trim().slice(0, 60) : null,
    description: typeof description === "string" ? description.trim().slice(0, 500) : source.description || null,
    definition: source,
    createdBy: req.user.email,
  });
  await recordAudit(req.user.tenantId, req.user, "template.publish", { templateId: template.id, name: template.name, fromWorkflowId: workflowId });
  res.status(201).json({ id: template.id, name: template.name });
}));

router.post("/api/dashboard/templates/:id/install", requireAuth("admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const template = await templates.getById(id);
  if (!template) return res.status(404).json({ error: "Template not found" });

  const { newId, newLabel } = req.body || {};
  if (typeof newId !== "string" || !WORKFLOW_ID_RE.test(newId)) {
    return res.status(400).json({ error: "newId is required and must contain only letters, numbers, dashes, and underscores." });
  }
  if (await tenantWorkflowStore.get(req.user.tenantId, newId)) return res.status(409).json({ error: `A business with id "${newId}" already exists.` });

  // Deep copy so the stored template is never mutated by the install.
  const workflow = JSON.parse(JSON.stringify(template.definition));
  workflow.id = newId;
  if (typeof newLabel === "string" && newLabel.trim()) workflow.label = newLabel.trim();

  const validationError = validateWorkflowShape(workflow);
  if (validationError) return res.status(400).json({ error: `Template produced an invalid workflow: ${validationError}` });

  await tenantWorkflowStore.upsert(req.user.tenantId, workflow);
  await recordAudit(req.user.tenantId, req.user, "template.install", { templateId: id, newWorkflowId: newId });
  log("INFO", `${req.user.email} installed template "${template.name}" as workflow "${newId}"`);
  res.status(201).json({ ok: true, workflowId: newId });
}));

router.delete("/api/dashboard/templates/:id", requireAuth("admin"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const template = await templates.getById(id);
  if (!template) return res.status(404).json({ error: "Template not found" });
  await templates.remove(id);
  await recordAudit(req.user.tenantId, req.user, "template.delete", { templateId: id, name: template.name });
  res.json({ ok: true });
}));

// Knowledge base (RAG-lite) — the FAQ/policy/pricing text the WhatsApp
// bot is allowed to answer questions from. Scoped per business: a provider
// manages only their own workflow's entries, an admin manages any.
// Providers CAN edit these (unlike workflow config, which is admin-only) —
// answering "do you take insurance?" is the provider's own domain
// knowledge, not a platform-level setting.
//
// Reuses factualQA.js's own MAX_DOC_CHARS rather than a separate, larger
// cap here — real gap, found while reconciling the two: this used to allow
// saving up to 5000 chars per document, but buildKnowledgeBase() (the
// thing that actually reads these back out at query time) only ever uses
// the first 1500 of it. An admin could save a 4000-char policy doc, get no
// error, and never learn that ~2500 chars of it were silently invisible to
// every customer question the bot answers. One cap now, enforced at write
// time with a clear error instead of a silent truncation.
const MAX_KNOWLEDGE_CONTENT = MAX_DOC_CHARS;

function resolveKnowledgeWorkflowId(req, requested) {
  if (req.user.role === "provider") return req.user.workflowId;
  return requested;
}

// Document upload for the knowledge base — extracts text from a PDF/
// DOCX/TXT file so an admin/provider can hand the bot a real policy
// document, price list, or FAQ sheet instead of retyping it by hand. This
// route only extracts and returns the text for review (same "draft, then
// the admin explicitly saves" pattern the AI workflow-generator already
// uses) — it never writes a knowledge_documents row itself; the existing
// POST /api/dashboard/knowledge above does that once the admin has had a
// chance to check the extracted text actually reads correctly (PDF text
// extraction is not always clean — tables/columns/scanned-image PDFs can
// come out garbled or empty).
router.post("/api/dashboard/knowledge/extract-document", requireAuth("admin", "provider"), (req, res) => {
  uploadDocument.single("document")(req, res, async (err) => {
    if (err) {
      const message =
        err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
          ? "Document must be 10MB or smaller."
          : err.message || "Upload failed.";
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: "No document provided." });
    try {
      const text = await extractTextFromDocument(req.file.buffer, req.file.mimetype);
      const trimmed = text.trim();
      if (!trimmed) {
        return res.status(422).json({ error: "Couldn't find any readable text in that document — it may be a scanned image rather than real text." });
      }
      const title = req.file.originalname.replace(/\.[^.]+$/, "").slice(0, 200);
      await recordAudit(req.user.tenantId, req.user, "knowledge.extract", { filename: req.file.originalname, extractedChars: trimmed.length });
      res.json({ title, content: trimmed.slice(0, MAX_KNOWLEDGE_CONTENT) });
    } catch (err) {
      log("ERROR", `Knowledge document extraction failed for ${req.file.originalname}: ${err.message}`);
      res.status(400).json({ error: "Couldn't read that document — make sure it's a valid PDF, DOCX, or plain text file." });
    }
  });
});

router.get("/api/dashboard/knowledge", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const workflowId = resolveKnowledgeWorkflowId(req, req.query.workflowId);
  if (!workflowId) return res.json(await knowledge.listAll(req.user.tenantId)); // admin, no workflow filter (still tenant-scoped)
  res.json(await knowledge.listForWorkflow(req.user.tenantId, workflowId));
}));

router.post("/api/dashboard/knowledge", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const { title, content } = req.body || {};
  const workflowId = resolveKnowledgeWorkflowId(req, req.body?.workflowId);
  if (typeof workflowId !== "string" || !(await tenantWorkflowStore.get(req.user.tenantId, workflowId))) {
    return res.status(400).json({ error: "A known workflowId is required." });
  }
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required." });
  if (typeof content !== "string" || !content.trim()) return res.status(400).json({ error: "content is required." });
  if (content.trim().length > MAX_KNOWLEDGE_CONTENT) {
    return res.status(400).json({ error: `content must be ${MAX_KNOWLEDGE_CONTENT} characters or fewer (got ${content.trim().length}).` });
  }

  const doc = await knowledge.create(req.user.tenantId, workflowId, title.trim().slice(0, 200), content.trim());
  await recordAudit(req.user.tenantId, req.user, "knowledge.create", { workflowId, id: doc.id, title: doc.title });
  res.status(201).json(doc);
}));

router.put("/api/dashboard/knowledge/:id", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = await knowledge.getById(req.user.tenantId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && existing.workflowId !== req.user.workflowId) {
    return res.status(403).json({ error: "You can only edit your own business's knowledge base." });
  }
  const { title, content } = req.body || {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required." });
  if (typeof content !== "string" || !content.trim()) return res.status(400).json({ error: "content is required." });
  if (content.trim().length > MAX_KNOWLEDGE_CONTENT) {
    return res.status(400).json({ error: `content must be ${MAX_KNOWLEDGE_CONTENT} characters or fewer (got ${content.trim().length}).` });
  }

  const doc = await knowledge.update(req.user.tenantId, id, title.trim().slice(0, 200), content.trim());
  await recordAudit(req.user.tenantId, req.user, "knowledge.update", { workflowId: existing.workflowId, id, title: doc.title });
  res.json(doc);
}));

router.delete("/api/dashboard/knowledge/:id", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = await knowledge.getById(req.user.tenantId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && existing.workflowId !== req.user.workflowId) {
    return res.status(403).json({ error: "You can only delete your own business's knowledge base." });
  }
  await knowledge.remove(req.user.tenantId, id);
  await recordAudit(req.user.tenantId, req.user, "knowledge.delete", { workflowId: existing.workflowId, id, title: existing.title });
  res.json({ ok: true });
}));


module.exports = { router };
