const tenantStore = require("../store/tenantStore");
const { log } = require("./logger");

// Item 8 — the public marketing site's live chat widget (POST
// /api/demo/chat) needs somewhere to run real conversations that isn't
// any actual customer's business. A dedicated, permanent tenant — created
// once (idempotent via its well-known slug, safe to call on every boot)
// and never assigned real WhatsApp credentials, so its sends always stay
// in simulated/logged mode regardless of what any real tenant on this
// install has configured. Never the upgrade-continuity fallback tenant
// (id 1) — a real single-tenant install's actual business could BE
// tenant 1, and a public demo visitor must never be able to touch it.
//
// Pulled out of server.js into its own module because BOTH the dashboard/
// bot process (server.js) and the marketing process (marketingServer.js)
// need it now — the demo chat route can be mounted on either (or both;
// see marketingServer.js's own comment on why), and each process calls
// this independently at its own startup. Idempotent by design (checked by
// slug, forced active every call) specifically so that's safe: whichever
// process starts first creates the row, the other just finds it already
// there and active — no coordination between the two processes needed.
const DEMO_TENANT_SLUG = "bookpilot-live-demo";
async function ensureDemoTenant() {
  const existing = await tenantStore.getBySlug(DEMO_TENANT_SLUG);
  // tenantStore.create() always starts a tenant "pending" (every tenant
  // needs a platform_admin to explicitly activate it — see requireAuth()'s
  // own comment). The demo tenant never has a real user logging in
  // through it, so "pending" would just be permanent, meaningless clutter
  // in a platform admin's activation queue — force it active on every
  // boot, not just at creation, so an install that already had this
  // tenant from before this check existed gets corrected too.
  if (existing) {
    if (existing.status !== "active") await tenantStore.setStatus(existing.id, "active");
    return existing.id;
  }
  const created = await tenantStore.create({ name: "BookPilot AI — Live Demo", slug: DEMO_TENANT_SLUG, plan: "free" });
  await tenantStore.setStatus(created.id, "active");
  log("INFO", `Created dedicated demo tenant (id ${created.id}) for the public marketing chat widget.`);
  return created.id;
}

module.exports = { DEMO_TENANT_SLUG, ensureDemoTenant };
