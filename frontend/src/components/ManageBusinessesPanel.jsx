import { useEffect, useState } from "react";
import { get } from "../lib/api";

// Section 13 — deliberately read-only in this rewrite: the vanilla
// dashboard's full add/edit workflow builder (hand-written JSON steps,
// the AI-drafting modal, the templates marketplace) is a materially
// larger, separate undertaking than porting the day-to-day
// booking-management flows this rewrite prioritized. Editing a business's
// configuration still works in the existing dashboard at /dashboard —
// nothing was removed, just not yet duplicated here. Flagged explicitly,
// not silently missing.
export default function ManageBusinessesPanel({ refreshKey }) {
  const [workflows, setWorkflows] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    get("/api/dashboard/workflows").then(setWorkflows).catch((err) => setError(err.message));
  }, [refreshKey]);

  const list = Object.values(workflows);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">🏪 Manage Businesses</span>
        <span className="count-badge">{list.length}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        Read-only in this view — add/edit a business's steps and providers from the classic dashboard at <a href="/dashboard">/dashboard</a> for now.
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="table-scroll">
        <table>
          <thead><tr><th>Business ID</th><th>Label</th><th>Description</th><th>Providers</th></tr></thead>
          <tbody>
            {list.map((w) => (
              <tr key={w.id}>
                <td>{w.id}</td>
                <td>{w.label}</td>
                <td style={{ whiteSpace: "normal", maxWidth: 360 }}>{w.description}</td>
                <td>{(w.providers?.length || 0) + (w.hotels?.reduce((n, h) => n + (h.rooms?.length || 0), 0) || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
