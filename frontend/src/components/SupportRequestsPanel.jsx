import { useEffect, useState } from "react";
import { get, patch } from "../lib/api";
import { formatIST } from "../lib/format";

export default function SupportRequestsPanel({ refreshKey, workflowLabel }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  async function load() {
    try { setRows(await get("/api/dashboard/support-requests")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [refreshKey]);

  const openCount = rows.filter((r) => !r.resolved).length;

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">🆘 Support Requests</span>
        <span className="count-badge">{openCount} open</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        A customer asked for a human twice in the same conversation. The bot can't connect them directly, but every one of these lands here so someone real can follow up.
      </div>
      {error && <div className="error-banner">{error}</div>}
      {rows.length === 0 ? <div className="empty">No support requests yet.</div> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>When (IST)</th><th>Customer</th><th>Business</th><th>Message</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{formatIST(r.createdAt)}</td>
                  <td>{r.waId}</td>
                  <td>{workflowLabel ? workflowLabel(r.workflowId) : r.workflowId}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 320 }}>{r.message}</td>
                  <td>{r.resolved ? <span style={{ color: "var(--success)" }}>Resolved</span> : <span style={{ color: "var(--danger)" }}>Open</span>}</td>
                  <td>
                    {!r.resolved && (
                      <button className="btn-secondary" style={{ padding: "3px 8px", fontSize: 12 }} onClick={async () => { await patch(`/api/dashboard/support-requests/${r.id}`, { resolved: true }); load(); }}>Mark resolved</button>
                    )}
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
