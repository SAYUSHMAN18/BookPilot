import { useEffect, useState } from "react";
import { get, post } from "../lib/api";

// Item 7 — the go-live journey's persistent checklist. Every item's
// `done` is computed live from real tenant state server-side (see
// GET /api/dashboard/setup-checklist) — this component just renders it
// and lets an admin dismiss the card once they're done exploring it.
export default function SetupChecklistPanel({ refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [dismissing, setDismissing] = useState(false);

  async function load() {
    try { setData(await get("/api/dashboard/setup-checklist")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load();   }, [refreshKey]);

  async function dismiss() {
    setDismissing(true);
    try {
      await post("/api/dashboard/setup-checklist/dismiss", {});
      setData((d) => ({ ...d, dismissed: true }));
    } catch (err) {
      setError(err.message);
    } finally {
      setDismissing(false);
    }
  }

  if (error) return <div className="card"><div className="error-banner">{error}</div></div>;
  if (!data || data.dismissed) return null;

  const doneCount = data.items.filter((i) => i.done).length;
  const pct = Math.round((doneCount / data.items.length) * 100);

  return (
    <div className="card" style={{ background: "linear-gradient(135deg, rgba(79,70,229,0.05), rgba(124,58,237,0.02))", border: "1px solid rgba(79,70,229,0.18)" }}>
      <div className="card-header">
        <span className="card-title">🚀 Getting Started <span className="count-badge">{doneCount} of {data.items.length}</span></span>
        <button className="btn-link" disabled={dismissing} onClick={dismiss}>
          {data.allDone ? "Dismiss ✕" : "Hide for now"}
        </button>
      </div>
      <div className="checklist-progress"><div className="checklist-progress-fill" style={{ width: `${pct}%` }} /></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
        {data.items.map((item) => (
          <div key={item.id} className="checklist-item">
            <span className={"checklist-check" + (item.done ? " done" : "")}>{item.done ? "✓" : ""}</span>
            <div>
              <div className={"checklist-label" + (item.done ? " done" : "")}>{item.label}</div>
              {!item.done && <div className="checklist-hint">{item.hint}</div>}
            </div>
          </div>
        ))}
      </div>
      {data.allDone && (
        <div style={{ marginTop: 4, fontSize: 12, color: "var(--success)", fontWeight: 600 }}>
          🎉 You're all set — your bot is live and ready for real customers.
        </div>
      )}
    </div>
  );
}
