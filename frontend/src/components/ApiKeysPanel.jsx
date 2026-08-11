import { useEffect, useState } from "react";
import { get, post, del } from "../lib/api";
import { formatIST } from "../lib/format";

export default function ApiKeysPanel({ refreshKey }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [justCreated, setJustCreated] = useState(null); // { key, record } — shown once, then never again

  async function load() {
    try { setRows(await get("/api/dashboard/api-keys")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [refreshKey]);

  async function create() {
    if (!name.trim()) return setError("Give this key a name (e.g. \"Website integration\") so you can tell it apart later.");
    setError("");
    try {
      const result = await post("/api/dashboard/api-keys", { name: name.trim() });
      setJustCreated(result);
      setName("");
      load();
    } catch (err) { setError(err.message); }
  }

  async function revoke(id) {
    if (!window.confirm("Revoke this API key? Any integration using it will stop working immediately.")) return;
    try { await del(`/api/dashboard/api-keys/${id}`); load(); } catch (err) { setError(err.message); }
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">🔑 API Keys</span>
        <span className="count-badge">{rows.filter((k) => !k.revoked).length} active</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        For your own website or backend to call the Public API (<code>GET /api/v1/availability</code>, <code>GET /api/v1/bookings/:bookingId</code>) directly — <code>Authorization: Bearer &lt;key&gt;</code>. Each key is shown in full exactly once, right after you create it; after that only its prefix is ever shown again. Full request/response reference: <a href="/openapi.yaml" target="_blank" rel="noreferrer">OpenAPI spec</a> (import into Postman, Insomnia, or Swagger Editor).
      </div>
      {error && <div className="error-banner">{error}</div>}

      {justCreated && (
        <div style={{ background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: "var(--radius-sm)", padding: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Copy this key now — it won't be shown again:</div>
          <code style={{ display: "block", background: "var(--card)", padding: 8, borderRadius: 4, wordBreak: "break-all", fontSize: 13 }}>{justCreated.key}</code>
          <button className="btn-secondary" style={{ marginTop: 8, fontSize: 12, padding: "4px 10px" }} onClick={() => setJustCreated(null)}>Done, I've saved it</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input placeholder="Key name (e.g. Website integration)" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
        <button className="btn-primary" onClick={create}>＋ Create Key</button>
      </div>

      {rows.length === 0 ? <div className="empty">No API keys yet.</div> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td><code>{k.keyPrefix}…</code></td>
                  <td>{formatIST(k.createdAt)}</td>
                  <td>{k.lastUsedAt ? formatIST(k.lastUsedAt) : "Never"}</td>
                  <td>{k.revoked ? <span style={{ color: "var(--danger)" }}>Revoked</span> : <span style={{ color: "var(--success)" }}>Active</span>}</td>
                  <td>{!k.revoked && <button className="btn-danger" style={{ padding: "3px 8px", fontSize: 12 }} onClick={() => revoke(k.id)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
