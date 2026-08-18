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
      {/* Found live, audit pass: there was no way at all to move off the
          Starter plan from inside the dashboard — the checkout endpoint
          (POST /api/billing/checkout) only ever works pre-activation
          ("awaiting_payment"), it explicitly rejects an already-active
          tenant. A real self-serve upgrade/downgrade flow is real,
          separate work (proration, an active Razorpay subscription
          change, not a one-time order) — not something to improvise here.
          Sales-assisted contact, the same pattern Enterprise already uses
          on the marketing site, is the safe version of this that ships
          today without touching payment logic at all. */}
      {!isUnlimited && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Need more room, or Growth/Enterprise features?</span>
          <div style={{ display: "flex", gap: 8 }}>
            <a className="btn-secondary" href="mailto:er.sayushman@gmail.com?subject=Upgrade%20my%20BookPilot%20plan" style={{ textDecoration: "none" }}>✉️ Email us to upgrade</a>
            <a className="btn-secondary" href="https://wa.me/917838881412?text=Hi%2C%20I%27d%20like%20to%20upgrade%20my%20BookPilot%20plan" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>💬 WhatsApp us</a>
          </div>
        </div>
      )}
    </div>
  );
}
