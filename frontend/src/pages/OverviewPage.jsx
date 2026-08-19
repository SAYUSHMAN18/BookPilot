import { useEffect, useMemo, useState } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { get } from "../lib/api";
import SetupChecklistPanel from "../components/SetupChecklistPanel";
import { IconCalendar, IconClock, IconTrendUp, IconMessage, IconCheckCircle, IconXCircle, IconBuilding, IconUsers } from "../components/Icons";
import AnimatedNumber from "../components/AnimatedNumber";

const QUICK_LINKS = [
  { to: "/bookings", Icon: IconCalendar, label: "Bookings", hint: "Every booking, filterable and searchable" },
  { to: "/availability", Icon: IconClock, label: "Availability", hint: "Blocked slots and calendar sync" },
  { to: "/analytics", Icon: IconTrendUp, label: "Analytics", hint: "Popular slots, no-show rate, revenue" },
  { to: "/support", Icon: IconMessage, label: "Support", hint: "Callback requests and customer feedback" },
];

// New plan, Stream 4 — the "high level, more interactable" landing view
// that didn't exist before (the old single page just opened straight into
// the bookings table). Deliberately built from endpoints that already
// exist rather than a new backend surface: GET /api/dashboard/all-bookings
// (admin) or /bookings (provider, scoped to their own workflowId+providerId)
// for the stat tiles, GET /api/dashboard/setup-checklist for the go-live
// checklist (admin-only — a provider account doesn't own the tenant's
// setup).
export default function OverviewPage() {
  const { providers, refreshKey, isAdminAccount } = useOutletContext();
  const [bookings, setBookings] = useState([]);
  const [error, setError] = useState("");
  const ownProvider = providers[0];

  useEffect(() => {
    async function load() {
      try {
        if (isAdminAccount) {
          setBookings(await get("/api/dashboard/all-bookings"));
        } else if (ownProvider) {
          setBookings(await get(`/api/dashboard/bookings?workflowId=${encodeURIComponent(ownProvider.workflowId)}&providerId=${encodeURIComponent(ownProvider.providerId)}`));
        }
      } catch (err) {
        setError(err.message);
      }
    }
    load();
  }, [refreshKey, isAdminAccount, ownProvider?.workflowId, ownProvider?.providerId]);

  const today = new Date().toISOString().slice(0, 10);
  const stats = useMemo(() => ({
    total: bookings.length,
    today: bookings.filter((b) => (b.checkInIso || b.visitDate) === today).length,
    arrived: bookings.filter((b) => b.status === "arrived").length,
    cancelled: bookings.filter((b) => b.status === "cancelled").length,
    // Found live: this tile was labeled "Businesses" but used
    // providers.length directly — that's every individual provider/room
    // across every business (e.g. one hotel alone can have 6 rooms), not
    // the number of businesses. A tenant with 6 businesses and 19
    // providers/rooms between them saw "19 Businesses" here, then only 6
    // rows on Manage Businesses — reads as businesses silently missing.
    // workflowId is the actual business identity each provider/room entry
    // carries; counting distinct ones is what "Businesses" should mean.
    businessCount: new Set(providers.map((p) => p.workflowId)).size,
  }), [bookings, today, providers]);

  return (
    <>
      {isAdminAccount && <SetupChecklistPanel refreshKey={refreshKey} />}

      {error && <div className="error-banner">{error}</div>}

      <div className="stat-bar">
        <div className="stat-tile"><div className="stat-tile-icon"><IconCalendar /></div><div className="n"><AnimatedNumber value={stats.total} /></div><div className="l">Total bookings</div></div>
        <div className="stat-tile"><div className="stat-tile-icon"><IconClock /></div><div className="n"><AnimatedNumber value={stats.today} /></div><div className="l">Today</div></div>
        <div className="stat-tile"><div className="stat-tile-icon good"><IconCheckCircle /></div><div className="n"><AnimatedNumber value={stats.arrived} /></div><div className="l">Arrived</div></div>
        <div className="stat-tile"><div className="stat-tile-icon bad"><IconXCircle /></div><div className="n"><AnimatedNumber value={stats.cancelled} /></div><div className="l">Cancelled</div></div>
        {isAdminAccount && <div className="stat-tile"><div className="stat-tile-icon"><IconBuilding /></div><div className="n"><AnimatedNumber value={stats.businessCount} /></div><div className="l">Businesses</div></div>}
        {isAdminAccount && <div className="stat-tile"><div className="stat-tile-icon"><IconUsers /></div><div className="n"><AnimatedNumber value={providers.length} /></div><div className="l">Providers & rooms</div></div>}
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Quick links</span></div>
        <div className="quick-link-grid">
          {QUICK_LINKS.map(({ to, Icon, label, hint }) => (
            <Link key={to} to={to} className="quick-link-tile">
              <span className="quick-link-icon"><Icon /></span>
              <div>
                <div className="quick-link-label">{label}</div>
                <div className="quick-link-hint">{hint}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
