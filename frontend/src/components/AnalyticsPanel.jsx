import { useEffect, useState } from "react";
import { get } from "../lib/api";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function BarRow({ label, count, max, color }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <div style={{ width: 60, fontSize: 12, color: "var(--muted)" }}>{label}</div>
      <div style={{ flex: 1, background: "var(--bg)", borderRadius: 4, height: 10, overflow: "hidden" }}>
        <div style={{ width: `${Math.max(pct, count ? 3 : 0)}%`, height: "100%", background: color }} />
      </div>
      <div style={{ width: 24, fontSize: 12, textAlign: "right" }}>{count}</div>
    </div>
  );
}

export default function AnalyticsPanel({ refreshKey, queryParams }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    get(`/api/dashboard/analytics?days=${days}${queryParams || ""}`).then(setData).catch((e) => setError(e.message));
  }, [days, refreshKey, queryParams]);

  if (error) return <div className="card"><div className="error-banner">{error}</div></div>;
  if (!data) return <div className="card"><div className="empty">Loading…</div></div>;

  // Same reasoning as Bookings' CSV export — a small business owner needs
  // this for records/reporting outside the app, and there was no way out
  // before. Exports exactly the window currently selected (7/30/90 days).
  function exportCsv() {
    const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [`Analytics — last ${days} days`, ""];
    lines.push("Metric,Value");
    lines.push(`${escape("No-show rate")},${escape(data.noShowRate === null ? "" : `${data.noShowRate}% of ${data.noShowSampleSize}`)}`);
    lines.push(`${escape("Average rating")},${escape(data.avgRating === null ? "" : `${data.avgRating} from ${data.ratingSampleSize}`)}`);
    lines.push(`${escape("Revenue collected")},${escape(data.paidBookingCount > 0 ? `₹${data.revenue} from ${data.paidBookingCount} bookings` : "")}`);
    if (data.providers?.length) {
      lines.push("");
      lines.push(["Provider", "Total", "Arrived", "Cancelled"].map(escape).join(","));
      data.providers.forEach((p) => lines.push([p.providerName, p.total, p.arrived, p.cancelled].map(escape).join(",")));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `analytics-${days}d-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">📈 Analytics</span>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button className="btn-secondary" disabled={data.total === 0} onClick={exportCsv}>⬇ Export CSV</button>
      </div>

      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 14 }}>
        Reply time — p50 {data.responseTime?.p50 ?? "—"}ms, p95 {data.responseTime?.p95 ?? "—"}ms, max {data.responseTime?.max ?? "—"}ms ({data.responseTime?.sampleSize ?? 0} samples since last restart)
      </div>

      {data.total === 0 ? (
        <div className="empty">No bookings yet — analytics appear here as bookings come in.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 22 }}>
          <div>
            <div className="section-label">Most-booked slots</div>
            {data.popularSlots.length
              ? data.popularSlots.map((s) => <BarRow key={s.time} label={s.time} count={s.count} max={Math.max(...data.popularSlots.map((x) => x.count), 1)} color="#0891b2" />)
              : <div className="empty" style={{ padding: "12px 0" }}>No time-slot data (hotel stays don't use slots).</div>}
          </div>
          <div>
            <div className="section-label">Busiest weekdays</div>
            {data.weekdayCounts.map((c, i) => <BarRow key={i} label={WEEKDAY_NAMES[i]} count={c} max={Math.max(...data.weekdayCounts, 1)} color="#a855f7" />)}
          </div>
          <div>
            <div className="section-label">No-show rate</div>
            {data.noShowRate === null
              ? <span style={{ fontSize: 12, color: "var(--muted)" }}>No past appointments yet</span>
              : <><span style={{ fontSize: 22, fontWeight: 700, color: data.noShowRate > 25 ? "var(--danger)" : "var(--success)" }}>{data.noShowRate}%</span>
                 <span style={{ fontSize: 11, color: "var(--muted)" }}> of {data.noShowSampleSize} past</span></>}
          </div>
          <div>
            <div className="section-label">Average rating</div>
            {data.avgRating === null
              ? <span style={{ fontSize: 12, color: "var(--muted)" }}>No feedback yet</span>
              : <><span style={{ fontSize: 22, fontWeight: 700, color: "#d97706" }}>⭐ {data.avgRating}</span>
                 <span style={{ fontSize: 11, color: "var(--muted)" }}> from {data.ratingSampleSize} rating{data.ratingSampleSize === 1 ? "" : "s"}</span></>}
          </div>
          <div>
            <div className="section-label">Revenue collected</div>
            {data.paidBookingCount > 0
              ? <><span style={{ fontSize: 22, fontWeight: 700, color: "var(--success)" }}>₹{data.revenue.toLocaleString("en-IN")}</span>
                 <span style={{ fontSize: 11, color: "var(--muted)" }}> from {data.paidBookingCount} paid booking{data.paidBookingCount === 1 ? "" : "s"}</span></>
              : <span style={{ fontSize: 12, color: "var(--muted)" }}>No payments collected yet</span>}
          </div>
        </div>
      )}

      {data.providers?.length > 1 && (
        <div style={{ marginTop: 18 }}>
          <div className="section-label">Provider performance</div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Provider</th><th>Total</th><th>Arrived</th><th>Cancelled</th></tr></thead>
              <tbody>{data.providers.map((p) => (
                <tr key={`${p.workflowId}::${p.providerId}`}><td>{p.providerName}</td><td>{p.total}</td><td>{p.arrived}</td><td>{p.cancelled}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
