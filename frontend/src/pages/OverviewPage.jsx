import { useEffect, useMemo, useState } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { get } from "../lib/api";
import SetupChecklistPanel from "../components/SetupChecklistPanel";

const QUICK_LINKS = [
  { to: "/bookings", icon: "📋", label: "Bookings", hint: "Every booking, filterable and searchable" },
  { to: "/availability", icon: "🗓️", label: "Availability", hint: "Blocked slots and calendar sync" },
  { to: "/analytics", icon: "📈", label: "Analytics", hint: "Popular slots, no-show rate, revenue" },
  { to: "/support", icon: "💬", label: "Support", hint: "Callback requests and customer feedback" },
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
  }), [bookings, today]);

  return (
    <>
      {isAdminAccount && <SetupChecklistPanel refreshKey={refreshKey} />}

      {error && <div className="error-banner">{error}</div>}

      <div className="stat-bar">
        <div className="stat-tile"><div className="n">{stats.total}</div><div className="l">Total bookings</div></div>
        <div className="stat-tile"><div className="n">{stats.today}</div><div className="l">Today</div></div>
        <div className="stat-tile"><div className="n">{stats.arrived}</div><div className="l">Arrived</div></div>
        <div className="stat-tile"><div className="n">{stats.cancelled}</div><div className="l">Cancelled</div></div>
        {isAdminAccount && <div className="stat-tile"><div className="n">{providers.length}</div><div className="l">Businesses</div></div>}
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Quick links</span></div>
        <div className="quick-link-grid">
          {QUICK_LINKS.map((link) => (
            <Link key={link.to} to={link.to} className="quick-link-tile">
              <span className="quick-link-icon">{link.icon}</span>
              <div>
                <div className="quick-link-label">{link.label}</div>
                <div className="quick-link-hint">{link.hint}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
