// Item 5 — regression coverage for the actual bug this item fixed: workflow
// definitions (GET/POST/DELETE /api/dashboard/workflows) used to live in one
// shared, un-scoped global object loaded from workflows/*.json — any tenant's
// admin could view, edit, or delete ANY other tenant's business config just
// by knowing (or guessing) a workflow id like "hair". These tests exercise
// the real HTTP routes (not tenantWorkflowStore directly) so they'd have
// caught that bug the same way a real attacker/customer would have hit it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp, signupAndActivate } = require("./_setup");

async function adminSession(app, email, businessName) {
  return signupAndActivate(app, request, { businessName, email });
}

test("GET /api/dashboard/workflows returns the seeded demo catalog for a brand new tenant", async () => {
  const app = await freshApp();
  const { cookie } = await adminSession(app, "owner@example.com", "Fresh Tenant Biz");

  const resp = await request(app).get("/api/dashboard/workflows").set("Cookie", cookie);
  assert.equal(resp.status, 200);
  assert.ok(resp.body.hair, "expected the demo catalog's 'hair' workflow to be seeded automatically");
  assert.ok(resp.body.hotel);
});

test("two tenants each editing a workflow with the SAME id never affects the other tenant's copy", async () => {
  const app = await freshApp();
  const tenantA = await adminSession(app, "a@example.com", "Tenant A Salon");
  const tenantB = await adminSession(app, "b@example.com", "Tenant B Salon");

  // Both tenants got their own independent "hair" row from the seed catalog.
  const beforeB = await request(app).get("/api/dashboard/workflows").set("Cookie", tenantB.cookie);
  const originalLabelB = beforeB.body.hair.label;

  // Tenant A renames its OWN "hair" workflow.
  const aWorkflow = { ...beforeB.body.hair, label: "Tenant A's Renamed Salon" };
  const editResp = await request(app).post("/api/dashboard/workflows").set("Cookie", tenantA.cookie).send(aWorkflow);
  assert.equal(editResp.status, 200);

  // Tenant A's own copy reflects the change...
  const afterA = await request(app).get("/api/dashboard/workflows").set("Cookie", tenantA.cookie);
  assert.equal(afterA.body.hair.label, "Tenant A's Renamed Salon");

  // ...but Tenant B's identically-id'd "hair" workflow is completely untouched.
  const afterB = await request(app).get("/api/dashboard/workflows").set("Cookie", tenantB.cookie);
  assert.equal(afterB.body.hair.label, originalLabelB);
  assert.notEqual(afterB.body.hair.label, "Tenant A's Renamed Salon");
});

test("DELETE /api/dashboard/workflows/:id only removes that tenant's own row, not another tenant's same-id workflow", async () => {
  const app = await freshApp();
  const tenantA = await adminSession(app, "delete-a@example.com", "Delete Tenant A");
  const tenantB = await adminSession(app, "delete-b@example.com", "Delete Tenant B");

  const del = await request(app).delete("/api/dashboard/workflows/hair").set("Cookie", tenantA.cookie);
  assert.equal(del.status, 200);

  const afterA = await request(app).get("/api/dashboard/workflows").set("Cookie", tenantA.cookie);
  assert.ok(!afterA.body.hair, "tenant A deleted its own 'hair' workflow");

  const afterB = await request(app).get("/api/dashboard/workflows").set("Cookie", tenantB.cookie);
  assert.ok(afterB.body.hair, "tenant B's own 'hair' workflow must still exist — deletion must not cross tenants");
});

test("a workflow one tenant creates under a NEW id is invisible to another tenant, and neither can delete it by guessing the id", async () => {
  const app = await freshApp();
  const tenantA = await adminSession(app, "new-a@example.com", "New Workflow Tenant A");
  const tenantB = await adminSession(app, "new-b@example.com", "New Workflow Tenant B");

  const custom = {
    id: "custom-spa",
    label: "Custom Spa",
    description: "test",
    providers: [{ id: "p1", name: "Provider 1", attribute: "Staff", fee: 100 }],
    steps: [{ type: "select_provider", prompt: "Choose:" }],
  };
  const create = await request(app).post("/api/dashboard/workflows").set("Cookie", tenantA.cookie).send(custom);
  assert.equal(create.status, 201);

  const bList = await request(app).get("/api/dashboard/workflows").set("Cookie", tenantB.cookie);
  assert.ok(!bList.body["custom-spa"], "tenant B must never see tenant A's own new workflow");

  const bDelete = await request(app).delete("/api/dashboard/workflows/custom-spa").set("Cookie", tenantB.cookie);
  assert.equal(bDelete.status, 404, "tenant B deleting an id it doesn't own must 404, not silently succeed on tenant A's row");

  const aListAfter = await request(app).get("/api/dashboard/workflows").set("Cookie", tenantA.cookie);
  assert.ok(aListAfter.body["custom-spa"], "tenant A's workflow must survive tenant B's failed delete attempt");
});
