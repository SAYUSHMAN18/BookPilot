import { useEffect, useState } from "react";
import { get, post, patch } from "../lib/api";

// New plan, Block 15 — the minimal slice of the Platform Admin Portal
// this pass actually needs: a way to SEE and ACTIVATE pending signups
// without curl. The full portal (health scores, impersonation, universal
// number management, system config) is real, separate, much larger work
// — this is deliberately just enough to use the activation flow the
// backend already has (PATCH /api/platform/tenants/:id/status).
const STATUS_ORDER = { pending: 0, active: 1, suspended: 2, cancelled: 3 };

export default function PlatformAdminView({ currentUserEmail, logout }) {
  const [tenants, setTenants] = useState([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    try {
      const list = await get("/api/platform/tenants");
      setTenants([...list].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.createdAt - a.createdAt));
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

  const pendingCount = tenants.filter((t) => t.status === "pending").length;

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand">BookPilot AI — Platform Admin</span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{currentUserEmail}</span>
        <button className="btn-link" onClick={logout}>Log out</button>
      </header>
      <main className="app-main">
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
          {error && <div className="error-banner">{error}</div>}
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Business</th><th>Slug</th><th>Plan</th><th>Status</th><th>WhatsApp</th><th>Bookings</th><th>Users</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td><code>{t.slug}</code></td>
                    <td>
                      <select value={t.plan} disabled={busyId === t.id} onChange={(e) => setPlan(t.id, e.target.value)} style={{ fontSize: 12, padding: "3px 6px" }}>
                        <option value="free">Starter (free)</option>
                        <option value="growth">Growth</option>
                        <option value="enterprise">Enterprise</option>
                      </select>
                    </td>
                    <td><span className={`status-badge status-${t.status === "cancelled" ? "cancelled" : t.status === "active" ? "arrived" : t.status === "suspended" ? "no_show" : "payment_pending"}`}>{t.status}</span></td>
                    <td>{t.whatsappConnected ? "✅" : "—"}</td>
                    <td>{t.bookingCount}</td>
                    <td>{t.userCount}</td>
                    <td style={{ display: "flex", gap: 6 }}>
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
