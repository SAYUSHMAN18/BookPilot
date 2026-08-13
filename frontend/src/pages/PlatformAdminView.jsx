import { useEffect, useState } from "react";
import { get, post, patch } from "../lib/api";

// New plan, Block 15 — the minimal slice of the Platform Admin Portal
// this pass actually needs: a way to SEE and ACTIVATE pending signups
// without curl. The full portal (health scores, impersonation, universal
// number management, system config) is real, separate, much larger work
// — this is deliberately just enough to use the activation flow the
// backend already has (PATCH /api/platform/tenants/:id/status).
//
// New plan, Stream 2/5 — extended with the subscription-gated onboarding
// lifecycle's own states and the queue that works them, plus a per-tenant
// drill-in (GET /api/platform/tenants/:id/detail) — the literal "select
// any specific business, then I can see whatever they have done" ask.
const STATUS_ORDER = { awaiting_payment: 0, onboarding_pending: 1, onboarding_in_progress: 2, pending: 3, active: 4, suspended: 5, cancelled: 6 };
const STATUS_BADGE_CLASS = {
  active: "status-arrived",
  suspended: "status-no_show",
  cancelled: "status-cancelled",
  awaiting_payment: "status-payment_pending",
  onboarding_pending: "status-payment_pending",
  onboarding_in_progress: "status-rescheduled",
  pending: "status-payment_pending",
};

export default function PlatformAdminView({ currentUserEmail, logout }) {
  const [tenants, setTenants] = useState([]);
  const [queue, setQueue] = useState([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [detailTenantId, setDetailTenantId] = useState(null);

  async function load() {
    try {
      const [list, onboardingQueue] = await Promise.all([get("/api/platform/tenants"), get("/api/platform/onboarding-queue")]);
      setTenants([...list].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.createdAt - a.createdAt));
      setQueue(onboardingQueue);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function setStatus(id, status) {
    setBusyId(id);
    setError("");
    try {
      await patch(`/api/platform/tenants/${id}/status`, { status });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  // New plan, Block 12 — the one place a tenant's plan can be changed at
  // all; every creation path (self-signup, this view's own Create Tenant
  // modal) hardcodes "free".
  async function setPlan(id, plan) {
    setBusyId(id);
    setError("");
    try {
      await patch(`/api/platform/tenants/${id}/plan`, { plan });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function markContacted(requestId) {
    setBusyId(`queue-${requestId}`);
    setError("");
    try {
      await patch(`/api/platform/onboarding-queue/${requestId}/contacted`, {});
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function markComplete(requestId) {
    setBusyId(`queue-${requestId}`);
    setError("");
    try {
      await patch(`/api/platform/onboarding-queue/${requestId}/complete`, {});
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const pendingCount = tenants.filter((t) => t.status === "pending").length;

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand">BookPilot AI — Platform Admin</span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{currentUserEmail}</span>
        <button className="btn-link" onClick={logout}>Log out</button>
      </header>
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}

        {queue.length > 0 && (
          <div className="card">
            <div className="card-header">
              <span className="card-title">🚀 Onboarding Queue <span className="count-badge">{queue.length}</span></span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Business</th><th>Plan</th><th>Status</th><th>Contact</th><th>Waiting since</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {queue.map((q) => (
                    <tr key={q.id}>
                      <td>{q.tenant.name} <code style={{ fontSize: 11 }}>{q.tenant.slug}</code></td>
                      <td>{q.tenant.plan}</td>
                      <td><span className={`status-badge ${STATUS_BADGE_CLASS[q.tenant.status] || "status-payment_pending"}`}>{q.tenant.status}</span></td>
                      <td>{q.tenant.billingEmail || "—"}</td>
                      <td>{new Date(q.createdAt).toLocaleString()}</td>
                      <td style={{ display: "flex", gap: 6 }}>
                        {q.status === "pending" && (
                          <button className="btn-secondary" disabled={busyId === `queue-${q.id}`} onClick={() => markContacted(q.id)}>Mark Contacted</button>
                        )}
                        <button className="btn-primary" disabled={busyId === `queue-${q.id}`} onClick={() => markComplete(q.id)}>Complete → Activate</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <span className="card-title">🏢 Tenants <span className="count-badge">{tenants.length}</span></span>
            <button className="btn-primary" onClick={() => setShowCreate(true)}>＋ Create Tenant</button>
          </div>
          {pendingCount > 0 && (
            <div style={{ background: "#fef3c7", border: "1px solid #fde68a", color: "#92400e", padding: "10px 14px", borderRadius: "var(--radius-sm)", fontSize: 13, marginBottom: 14 }}>
              🔔 {pendingCount} signup{pendingCount === 1 ? "" : "s"} waiting for activation.
            </div>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Business</th><th>Slug</th><th>Plan</th><th>Status</th><th>WhatsApp</th><th>Bookings</th><th>Users</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id}>
                    <td><button className="btn-link" style={{ fontWeight: 700, color: "var(--text)", textDecoration: "none" }} onClick={() => setDetailTenantId(t.id)}>{t.name}</button></td>
                    <td><code>{t.slug}</code></td>
                    <td>
                      <select value={t.plan} disabled={busyId === t.id} onChange={(e) => setPlan(t.id, e.target.value)} style={{ fontSize: 12, padding: "3px 6px" }}>
                        <option value="free">Starter (free)</option>
                        <option value="starter">Starter</option>
                        <option value="growth">Growth</option>
                        <option value="enterprise">Enterprise</option>
                      </select>
                    </td>
                    <td><span className={`status-badge ${STATUS_BADGE_CLASS[t.status] || "status-payment_pending"}`}>{t.status}</span></td>
                    <td>{t.whatsappConnected ? "✅" : "—"}</td>
                    <td>{t.bookingCount}</td>
                    <td>{t.userCount}</td>
                    <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button className="btn-secondary" onClick={() => setDetailTenantId(t.id)}>View</button>
                      {t.status === "pending" && (
                        <button className="btn-primary" disabled={busyId === t.id} onClick={() => setStatus(t.id, "active")}>Activate</button>
                      )}
                      {t.status === "active" && (
                        <button className="btn-secondary" disabled={busyId === t.id} onClick={() => setStatus(t.id, "suspended")}>Suspend</button>
                      )}
                      {t.status === "suspended" && (
                        <button className="btn-primary" disabled={busyId === t.id} onClick={() => setStatus(t.id, "active")}>Reactivate</button>
                      )}
                      {t.status !== "cancelled" && (
                        <button className="btn-danger" disabled={busyId === t.id} onClick={() => { if (window.confirm(`Cancel "${t.name}"? Its users will lose dashboard access.`)) setStatus(t.id, "cancelled"); }}>Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
      {showCreate && <CreateTenantModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {detailTenantId && <TenantDetailModal tenantId={detailTenantId} onClose={() => setDetailTenantId(null)} />}
    </div>
  );
}

// New plan, Stream 5 — the drill-in itself: booking counts by status,
// team roster, onboarding status, and the tenant's own recent audit
// trail, all from the one GET /api/platform/tenants/:id/detail call
// (which itself logs a tenant.viewed audit entry server-side — see
// platformAdmin.js — so this view being opened is itself part of the
// trail it displays).
function TenantDetailModal({ tenantId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    get(`/api/platform/tenants/${tenantId}/detail`).then(setData).catch((err) => setError(err.message));
  }, [tenantId]);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card" style={{ maxWidth: 640, maxHeight: "85vh", overflowY: "auto" }}>
        <div className="card-header" style={{ marginBottom: 0 }}>
          <span className="card-title">{data ? data.tenant.name : "Loading…"}</span>
          <button className="btn-link" style={{ fontSize: 20, fontWeight: "bold" }} onClick={onClose}>×</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {data && (
          <>
            <div className="stat-bar" style={{ marginTop: 4 }}>
              <div className="stat-tile"><div className="n">{data.bookingCount}</div><div className="l">Bookings</div></div>
              <div className="stat-tile"><div className="n">{data.userCount}</div><div className="l">Team members</div></div>
              <div className="stat-tile"><div className="n">{data.tenant.plan}</div><div className="l">Plan</div></div>
              <div className="stat-tile"><div className="n">{data.tenant.status}</div><div className="l">Status</div></div>
            </div>

            {data.onboarding && (
              <div style={{ marginBottom: 16 }}>
                <div className="section-label">Onboarding</div>
                <div style={{ fontSize: 13 }}>
                  Status: <strong>{data.onboarding.status}</strong>
                  {data.onboarding.assignedTo && <> · Assigned to {data.onboarding.assignedTo}</>}
                  {data.onboarding.contactedAt && <> · First contacted {new Date(data.onboarding.contactedAt).toLocaleString()}</>}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <div className="section-label">Bookings by status</div>
              {Object.keys(data.bookingsByStatus).length === 0 ? (
                <div className="empty" style={{ padding: "8px 0" }}>No bookings yet.</div>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {Object.entries(data.bookingsByStatus).map(([status, count]) => (
                    <span key={status} className={`status-badge status-${status}`}>{status}: {count}</span>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div className="section-label">Team</div>
              {data.users.length === 0 ? (
                <div className="empty" style={{ padding: "8px 0" }}>No users yet.</div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Email</th><th>Role</th><th>Status</th></tr></thead>
                    <tbody>{data.users.map((u) => (
                      <tr key={u.email}><td>{u.email}</td><td>{u.role}</td><td>{u.active ? "Active" : "Inactive"}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <div className="section-label">Recent activity</div>
              {data.recentActivity.length === 0 ? (
                <div className="empty" style={{ padding: "8px 0" }}>No activity recorded yet.</div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead>
                    <tbody>{data.recentActivity.map((a) => (
                      <tr key={a.id}><td>{new Date(a.createdAt).toLocaleString()}</td><td>{a.actorEmail}</td><td>{a.action}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CreateTenantModal({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [plan, setPlan] = useState("free");
  const [billingEmail, setBillingEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    setError("");
    if (!name.trim()) return setError("A tenant name is required.");
    if (!/^[a-z0-9-]+$/.test(slug)) return setError("Slug must be lowercase letters, numbers, and dashes only.");
    setBusy(true);
    try {
      await post("/api/platform/tenants", { name: name.trim(), slug, plan, billingEmail: billingEmail.trim() || undefined });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card" style={{ maxWidth: 420 }}>
        <div className="card-header" style={{ marginBottom: 0 }}>
          <span className="card-title">Create Tenant</span>
          <button className="btn-link" style={{ fontSize: 20, fontWeight: "bold" }} onClick={onClose}>×</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div>
          <label className="form-label">Business Name</label>
          <input className="form-input" value={name} onChange={(e) => { setName(e.target.value); if (!slug) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")); }} />
        </div>
        <div>
          <label className="form-label">Slug</label>
          <input className="form-input" value={slug} onChange={(e) => setSlug(e.target.value)} />
        </div>
        <div>
          <label className="form-label">Plan</label>
          <select className="form-select" value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="free">Free</option>
            <option value="growth">Growth</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </div>
        <div>
          <label className="form-label">Billing Email (optional)</label>
          <input className="form-input" type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy} onClick={handleCreate}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}
