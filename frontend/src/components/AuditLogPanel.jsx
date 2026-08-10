import { useEffect, useState } from "react";
import { get } from "../lib/api";
import { formatIST } from "../lib/format";

export default function AuditLogPanel({ refreshKey }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    get("/api/dashboard/audit-log").then(setRows).catch((err) => setError(err.message));
  }, [refreshKey]);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">🕵️ Audit Log</span>
        <span className="count-badge">{rows.length}</span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {rows.length === 0 ? <div className="empty">No audit entries yet.</div> : (
        <div className="table-scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table>
            <thead><tr><th>When (IST)</th><th>Who</th><th>Role</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{formatIST(r.createdAt)}</td>
                  <td>{r.actorEmail}</td>
                  <td>{r.actorRole}</td>
                  <td>{r.action}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 360, fontSize: 12, color: "var(--muted)" }}>{r.detail ? JSON.stringify(r.detail) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
