const crypto = require("crypto");
const express = require("express");
const { log } = require("../infra/logger");
const { handleIncomingMessage } = require("../engine/workflowEngine");
const tenantWorkflowStore = require("../store/tenantWorkflowStore");
const { beginReplyCapture, endStructuredReplyCapture } = require("../infra/whatsapp");
const { isDemoChatRateLimited } = require("../infra/rateLimit");
const { asyncHandler } = require("../infra/asyncHandler");

// Split out of webhook.js so the public marketing site (marketingServer.js)
// can mount just this one, publicly-reachable-by-design route without also
// pulling in /webhook, /api/payments/webhook, and /api/simulate-whatsapp —
// none of which have any business being reachable on the marketing domain.
// Still mounted on the dashboard/bot server (server.js) too, purely so the
// existing test suite (tests/http/demoChat.test.js, which boots server.js's
// app) keeps working unchanged — harmless either way, since this route is
// unauthenticated by design and can't touch any real tenant's data (see
// syntheticDemoWaId below).
function syntheticDemoWaId(sessionId) {
  const hash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return `demo-${hash}`;
}

// demoTenantId is passed in rather than computed here — ensureDemoTenant()
// (src/infra/demoTenant.js) stays a one-time boot-sequence concern for
// whichever process mounts this router, not something this module
// re-derives on its own.
function createDemoChatRouter(demoTenantId) {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // Item 8 — the public marketing site's live chat widget. Deliberately a
  // SEPARATE route from /api/simulate-whatsapp, not a relaxed version of
  // it, because the two have fundamentally different trust models:
  // simulate-whatsapp accepts a client-chosen tenantId (a dev/test tool,
  // disabled by default once real WhatsApp traffic is live) — accepting
  // that same freedom here, on a route meant to be reachable by anyone on
  // the internet with no login, would let a visitor inject fake messages
  // into ANY real tenant's live conversation. This route can't do that even
  // in principle: the tenant is hardcoded to demoTenantId, never read from
  // the request. Safe to leave enabled permanently, independent of whether
  // this install also has real WhatsApp/ALLOW_SIMULATE_ENDPOINT configured.
  //
  // `sessionId` is a random token the widget generates client-side (crypto.
  // randomUUID(), stored in sessionStorage — gone when the tab closes) and
  // is NOT treated as a real phone number; it's hashed into a synthetic
  // waId so two concurrent visitors' demo conversations never collide, and
  // so nothing here ever touches the shape a real WhatsApp id has.
  // ---------------------------------------------------------------------------
  router.post("/api/demo/chat", asyncHandler(async (req, res) => {
    if (await isDemoChatRateLimited(req.ip)) {
      return res.status(429).json({ error: "Too many demo messages from this connection — please wait a few minutes and try again." });
    }
    const { sessionId, text } = req.body || {};
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200) {
      return res.status(400).json({ error: "sessionId is required." });
    }
    if (typeof text !== "string" || !text.trim() || text.length > 500) {
      return res.status(400).json({ error: "text is required and must be 500 characters or fewer." });
    }

    const waId = syntheticDemoWaId(sessionId.trim());
    beginReplyCapture(waId);
    try {
      await handleIncomingMessage(demoTenantId, waId, text.trim(), await tenantWorkflowStore.listForTenant(demoTenantId));
      const captured = endStructuredReplyCapture(waId);
      // `reply` stays exactly the flattened plain-text string this route
      // always returned — kept for compatibility (see tests/http/
      // demoChat.test.js's own assertion on it being a plain string).
      // `parts` is new: one entry per bubble, carrying the SAME text
      // alongside the raw tappable options a real WhatsApp interactive
      // message would have had, instead of those options being collapsed
      // into a comma-separated line inside the text (found live — this
      // is exactly why the live demo widget could only ever render plain
      // text bubbles, never real-looking tappable ones, even for a
      // provider/date/time list). Falls back to a single "..." part so
      // the widget always has at least one bubble to render.
      const parts = captured.length
        ? captured.map((c) => ({ text: c.text, options: c.options ? c.options.map((o) => ({ id: o.id, title: o.title })) : null }))
        : [{ text: "...", options: null }];
      const reply = parts.map((p) => (p.options ? `${p.text}\n${p.options.map((o) => o.title).join(", ")}` : p.text)).join("\n\n");
      res.json({ reply, parts });
    } catch (err) {
      endStructuredReplyCapture(waId);
      log("ERROR", `Demo chat error: ${err.stack || err.message}`);
      res.status(500).json({ reply: "Sorry, something went wrong on my end — could you try that again?" });
    }
  }));

  return router;
}

module.exports = { createDemoChatRouter };
