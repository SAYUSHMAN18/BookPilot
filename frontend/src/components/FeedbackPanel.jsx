import { useEffect, useState } from "react";
import { get } from "../lib/api";
import { formatIST } from "../lib/format";

export default function FeedbackPanel({ refreshKey, workflowLabel }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    get("/api/dashboard/feedback").then(setRows).catch((err) => setError(err.message));
  }, [refreshKey]);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">💬 Feedback</span>
        <span className="count-badge">{rows.length}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        Collected after a provider marks a booking complete — the bot asks once, no repeated nudging.
      </div>
      {error && <div className="error-banner">{error}</div>}
      {rows.length === 0 ? <div className="empty">No feedback yet.</div> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>When (IST)</th><th>Customer</th><th>Booking</th><th>Business</th><th>Rating</th><th>Comment</th></tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td>{formatIST(f.createdAt)}</td>
                  <td>{f.waId}</td>
                  <td>{f.bookingLabel || "—"}</td>
                  <td>{workflowLabel ? workflowLabel(f.workflowId) : (f.workflowId || "—")}</td>
                  <td>{f.rating ? "⭐".repeat(f.rating) : "—"}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 320 }}>{f.comment || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
