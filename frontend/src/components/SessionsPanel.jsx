import { useEffect, useState } from "react";
import { get, del } from "../lib/api";
import { formatIST } from "../lib/format";

// New plan, Block 14 — session list/revoke. Lets someone see every
// device/browser currently logged into their own account and force one
// of them out (a shared/public computer they forgot to log out of, or a
// session they just don't recognize) without needing to change their
// password to invalidate every session at once.
export default function SessionsPanel({ refreshKey }) {
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  async function load() {
    try { setSessions(await get("/api/auth/sessions")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [refreshKey]);

  async function revoke(id) {
    if (!window.confirm("Log out that session? It'll need to sign in again to use the dashboard.")) return;
    setBusyId(id);
    try {
      await del(`/api/auth/sessions/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">🔐 Active Sessions <span className="count-badge">{sessions.length}</span></span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        Every device currently logged into your account. Log one out if you don't recognize it.
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="table-scroll">
        <table>
          <thead><tr><th>Device</th><th>Signed in</th><th>Expires</th><th>Actions</th></tr></thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{s.userAgent || "Unknown device"}{s.isCurrent && <span className="count-badge" style={{ marginLeft: 6 }}>This device</span>}</td>
                <td>{formatIST(s.createdAt)}</td>
                <td>{formatIST(s.expiresAt)}</td>
                <td>{!s.isCurrent && <button className="btn-danger" style={{ padding: "3px 8px", fontSize: 12 }} disabled={busyId === s.id} onClick={() => revoke(s.id)}>Log out</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
