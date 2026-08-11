import { useEffect, useState } from "react";
import { get } from "../lib/api";

// New plan, Block 12 — the tenant-facing half of the billing skeleton.
// Deliberately just plan + usage-this-month + a soft-limit warning, no
// invoices or payment method UI — see README for why real recurring
// billing collection is separate, larger work from this pass.
export default function BillingPanel({ refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    try { setData(await get("/api/dashboard/billing")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [refreshKey]);

  if (error) return <div className="card"><div className="error-banner">{error}</div></div>;
  if (!data) return null;

  const isUnlimited = data.limit === null;

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">💳 Billing &amp; Usage</span>
        <span className="count-badge">{data.planLabel} plan</span>
      </div>
      {data.softLimitExceeded && (
        <div style={{ background: "#fef3c7", border: "1px solid #fde68a", color: "#92400e", padding: "10px 14px", borderRadius: "var(--radius-sm)", fontSize: 13, marginBottom: 14 }}>
          ⚠️ You've reached your {data.planLabel} plan's limit of {data.limit} bookings this month. Your WhatsApp bot keeps working normally — this is just a heads up that it might be time to upgrade.
        </div>
      )}
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>
        {data.bookingsThisMonth} booking{data.bookingsThisMonth === 1 ? "" : "s"} this month
        {isUnlimited ? " — unlimited on this plan" : ` of ${data.limit} included`}
      </div>
      {!isUnlimited && (
        <div style={{ background: "var(--bg)", borderRadius: 999, height: 8, overflow: "hidden" }}>
          <div
            style={{
              width: `${data.percentUsed}%`, height: "100%", borderRadius: 999,
              background: data.softLimitExceeded ? "var(--danger)" : data.percentUsed >= 80 ? "#f59e0b" : "var(--profile)",
              transition: "width .3s ease",
            }}
          />
        </div>
      )}
    </div>
  );
}
