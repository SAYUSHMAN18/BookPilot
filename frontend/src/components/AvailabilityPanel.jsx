import { useEffect, useState } from "react";
import { get, post, del } from "../lib/api";

export default function AvailabilityPanel({ provider }) {
  const [blocks, setBlocks] = useState([]);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  async function load() {
    if (!provider?.supportsAvailability) return;
    try {
      const rows = await get(`/api/dashboard/availability?workflowId=${encodeURIComponent(provider.workflowId)}&providerId=${encodeURIComponent(provider.providerId)}`);
      setBlocks(rows);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [provider?.workflowId, provider?.providerId]);

  if (!provider || !provider.supportsAvailability) return null;

  async function addBlock() {
    if (!date) return setError("Pick a date first.");
    setError("");
    try {
      await post("/api/dashboard/availability", {
        workflowId: provider.workflowId, providerId: provider.providerId,
        date, time: time || undefined, endTime: endTime || undefined, reason: reason || undefined,
      });
      setDate(""); setTime(""); setEndTime(""); setReason("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">🗓 Availability</span></div>
      <div className="filters-row">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" placeholder="Start (optional)" value={time} onChange={(e) => setTime(e.target.value)} title="Start time — leave blank to block the whole day" />
        <span style={{ color: "var(--muted)", fontSize: 13 }}>to</span>
        <input type="time" placeholder="End" value={endTime} onChange={(e) => setEndTime(e.target.value)} title="End time — leave blank to block just the start time" />
        <input type="text" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 190 }} />
        <button className="btn-primary" onClick={addBlock}>Block</button>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        Leave both times blank to block the entire day. Set a start and end to block a range (e.g. 2:30–3:40 excludes every slot in between, not just one). Leave end blank with a start set to block just that one slot. Applies immediately to the WhatsApp bot's available slots.
      </div>
      {error && <div className="error-banner">{error}</div>}
      {blocks.length === 0 ? (
        <div className="empty">No availability blocks set.</div>
      ) : (
        blocks.map((b) => {
          const when = !b.time ? " (whole day)" : b.endTime ? ` from ${b.time} to ${b.endTime}` : ` at ${b.time}`;
          return (
            <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span>{b.date}{when}{b.reason ? ` — ${b.reason}` : ""}</span>
              <button className="btn-danger" onClick={async () => { await del(`/api/dashboard/availability/${b.id}`); load(); }}>Remove</button>
            </div>
          );
        })
      )}
    </div>
  );
}
