import { useEffect, useState } from "react";
import { get } from "../lib/api";
import { IconCalendar, IconClock, IconCard, IconXCircle, IconTrendUp } from "./Icons";
import AnimatedNumber from "./AnimatedNumber";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Found live (redesign pass): this used to be a flat-color div bar with
// hardcoded hex (#0891b2/#a855f7) that never adapted to dark mode — now
// pulls from the same --profile/--spark tokens every gradient elsewhere in
// the app uses, so it stays consistent across light/dark instead of being
// the one chart that doesn't. `tone` picks which gradient (kept as a prop,
// not two copy-pasted components) so the two charts on this page read as
// visually distinct series, matching how Overview already color-codes its
// own stat tiles by meaning (good/bad) rather than arbitrarily.
function BarRow({ label, count, max, tone }) {
  const pct = max > 0 ? Math.max(Math.round((count / max) * 100), count ? 4 : 0) : 0;
  return (
    <div className="chart-bar-row">
      <div className="chart-bar-label">{label}</div>
      <div className="chart-bar-track">
        <div className={"chart-bar-fill" + (tone === "spark" ? " spark" : "")} style={{ width: `${pct}%` }} title={`${label}: ${count}`} />
      </div>
      <div className="chart-bar-value">{count}</div>
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
    <>
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

        {data.total === 0 ? (
          <div className="empty">No bookings yet — analytics appear here as bookings come in.</div>
        ) : (
          <>
            {/* Headline numbers as real stat tiles — same component
                OverviewPage's own stat-bar uses, so this reads as one
                consistent dashboard rather than Analytics being the one
                page still doing plain-text metrics. */}
            <div className="stat-bar">
              <div className="stat-tile">
                <div className="stat-tile-icon"><IconCalendar /></div>
                <div className="n"><AnimatedNumber value={data.total} /></div>
                <div className="l">Bookings ({days}d)</div>
              </div>
              <div className="stat-tile">
                <div className={"stat-tile-icon" + (data.noShowRate === null ? "" : data.noShowRate > 25 ? " bad" : " good")}><IconXCircle /></div>
                {data.noShowRate === null
                  ? <div className="stat-tile-empty">No past appointments yet</div>
                  : <><div className="n"><AnimatedNumber value={data.noShowRate} format={(n) => `${n}%`} /></div><div className="l">No-shows · {data.noShowSampleSize} past</div></>}
              </div>
              <div className="stat-tile">
                <div className="stat-tile-icon good"><IconTrendUp /></div>
                {data.avgRating === null
                  ? <div className="stat-tile-empty">No feedback yet</div>
                  : <><div className="n">⭐ {data.avgRating}</div><div className="l">{data.ratingSampleSize} rating{data.ratingSampleSize === 1 ? "" : "s"}</div></>}
              </div>
              <div className="stat-tile">
                <div className="stat-tile-icon good"><IconCard /></div>
                {data.paidBookingCount > 0
                  ? <><div className="n"><AnimatedNumber value={data.revenue} format={(n) => `₹${n.toLocaleString("en-IN")}`} /></div><div className="l">{data.paidBookingCount} paid booking{data.paidBookingCount === 1 ? "" : "s"}</div></>
                  : <div className="stat-tile-empty">No payments collected yet</div>}
              </div>
              <div className="stat-tile">
                <div className="stat-tile-icon"><IconClock /></div>
                {data.responseTime?.sampleSize
                  ? <><div className="n"><AnimatedNumber value={data.responseTime.p50} format={(n) => `${n}ms`} /></div><div className="l">p50 reply · {data.responseTime.sampleSize} since restart</div></>
                  : <div className="stat-tile-empty">No samples since last restart</div>}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 22, marginTop: 4 }}>
              <div>
                <div className="section-label">Most-booked slots</div>
                {data.popularSlots.length
                  ? data.popularSlots.map((s) => <BarRow key={s.time} label={s.time} count={s.count} max={Math.max(...data.popularSlots.map((x) => x.count), 1)} tone="spark" />)
                  : <div className="empty" style={{ padding: "12px 0" }}>No time-slot data (hotel stays don't use slots).</div>}
              </div>
              <div>
                <div className="section-label">Busiest weekdays</div>
                {data.weekdayCounts.map((c, i) => <BarRow key={i} label={WEEKDAY_NAMES[i]} count={c} max={Math.max(...data.weekdayCounts, 1)} tone="profile" />)}
              </div>
            </div>
          </>
        )}
      </div>

      {data.providers?.length > 1 && (
        <div className="card">
          <div className="card-header"><span className="card-title">Provider performance</span></div>
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
    </>
  );
}
