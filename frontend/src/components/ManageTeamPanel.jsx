import { useEffect, useState } from "react";
import { get, post, patch } from "../lib/api";

// A random, copy-pasteable temporary password — one less thing to invent
// when adding someone. Shown in plain text right here (same "shown once"
// pattern API key creation already uses) so it can be handed to the new
// login's owner; they're expected to change it after first sign-in.
function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export default function ManageTeamPanel({ refreshKey, providers, currentUserEmail }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", name: "", role: "provider", providerKey: "" });

  async function load() {
    try { setRows(await get("/api/dashboard/users")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [refreshKey]);

  async function save() {
    setError("");
    const [workflowId, providerId] = (form.providerKey || "").split("::");
    try {
      await post("/api/dashboard/users", {
        email: form.email.trim(), password: form.password, name: form.name.trim() || undefined,
        role: form.role, workflowId: form.role === "provider" ? workflowId : undefined, providerId: form.role === "provider" ? providerId : undefined,
      });
      setForm({ email: "", password: "", name: "", role: "provider", providerKey: "" });
      setAdding(false);
      load();
    } catch (err) { setError(err.message); }
  }

  async function toggleActive(u) {
    if (u.email === currentUserEmail && u.active) return; // guard mirrors server's own "can't deactivate yourself" rule
    try { await patch(`/api/dashboard/users/${u.id}`, { active: !u.active }); load(); } catch (err) { setError(err.message); }
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">👥 Manage Team</span>
        <span className="count-badge">{rows.length}</span>
        <button className="btn-primary" onClick={() => setAdding((a) => !a)} style={{ marginLeft: "auto" }}>＋ Add Login</button>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        One login per person — a provider account only ever sees its own workflow/provider's bookings and availability, enforced on the server, not just hidden in this UI.
      </div>
      {error && <div className="error-banner">{error}</div>}
      {adding && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14, background: "var(--bg)", padding: 12, borderRadius: "var(--radius-sm)" }}>
          <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="Temporary password" type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={{ flex: 1 }} />
            <button type="button" className="btn-secondary" onClick={() => setForm({ ...form, password: generatePassword() })}>🎲 Generate</button>
          </div>
          <input placeholder="Display name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="provider">Provider</option>
            <option value="admin">Admin</option>
          </select>
          {form.role === "provider" && (
            <select value={form.providerKey} onChange={(e) => setForm({ ...form, providerKey: e.target.value })}>
              <option value="">Select business/provider…</option>
              {providers.map((p) => <option key={`${p.workflowId}::${p.providerId}`} value={`${p.workflowId}::${p.providerId}`}>{p.workflowLabel} — {p.providerName}</option>)}
            </select>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary" onClick={save}>Create</button>
            <button className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Business / Provider</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.name || "—"}</td>
                <td>{u.role === "admin" ? "👑 Admin" : "🏢 Provider"}</td>
                <td>{u.role === "provider" ? (providers.find((p) => p.workflowId === u.workflowId && p.providerId === u.providerId)?.providerName || `${u.workflowId}/${u.providerId}`) : "—"}</td>
                <td>{u.active ? "Active" : "Deactivated"}</td>
                <td>
                  {u.email !== currentUserEmail && (
                    <button className={u.active ? "btn-danger" : "btn-secondary"} style={{ padding: "3px 8px", fontSize: 12 }} onClick={() => toggleActive(u)}>
                      {u.active ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
