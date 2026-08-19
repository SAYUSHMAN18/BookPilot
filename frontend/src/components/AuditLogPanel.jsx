import { useEffect, useState } from "react";
import { get } from "../lib/api";
import { formatIST } from "../lib/format";

// login/logout aren't dot-suffixed like the rest ("workflow.update",
// "booking.delete") — checked as whole-string first, everything else by
// its suffix after the last dot.
function actionTone(action) {
  if (action === "login" || action === "logout") return "session";
  if (action.endsWith(".create") || action.endsWith(".install") || action.endsWith(".publish")) return "create";
  if (action.endsWith(".delete")) return "delete";
  if (action.endsWith(".update") || action.endsWith(".reschedule") || action.endsWith(".serve") || action.endsWith(".complete")) return "update";
  return "default";
}

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
                  <td><span className={`audit-action-badge audit-action-${actionTone(r.action)}`}>{r.action}</span></td>
                  <td style={{ whiteSpace: "normal", maxWidth: 360 }}>
                    {r.detail
                      ? <div className="audit-detail-chips">{Object.entries(r.detail).map(([k, v]) => (
                          <span className="audit-detail-chip" key={k}><b>{k}</b>: {typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                        ))}</div>
                      : <span style={{ color: "var(--subtle)" }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
