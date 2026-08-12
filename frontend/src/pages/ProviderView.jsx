import { useEffect, useMemo, useState } from "react";
import { get } from "../lib/api";
import BookingsTable from "../components/BookingsTable";
import AnalyticsPanel from "../components/AnalyticsPanel";
import AvailabilityPanel from "../components/AvailabilityPanel";
import CalendarSyncPanel from "../components/CalendarSyncPanel";
import SupportRequestsPanel from "../components/SupportRequestsPanel";
import FeedbackPanel from "../components/FeedbackPanel";
import KnowledgeBasePanel from "../components/KnowledgeBasePanel";

export default function ProviderView({ provider, providers, refreshKey, bump }) {
  const [bookings, setBookings] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [error, setError] = useState("");

  // An admin ACCOUNT browsing this Provider view still gets every
  // business's feedback/support requests from the backend (Section 4's
  // scoping is by account role, not by whichever provider happens to be
  // selected here) — so the label lookup has to cover every workflow,
  // not just the currently-selected one. A real "provider" role account
  // only ever gets its own workflow's rows anyway, so this is a no-op
  // narrowing for that case.
  const workflowLabel = useMemo(() => {
    const map = new Map();
    (providers || []).forEach((p) => map.set(p.workflowId, p.workflowLabel));
    return (id) => map.get(id) || id;
  }, [providers]);

  async function load() {
    if (!provider) return;
    try {
      setBookings(await get(`/api/dashboard/bookings?workflowId=${encodeURIComponent(provider.workflowId)}&providerId=${encodeURIComponent(provider.providerId)}`));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [provider?.workflowId, provider?.providerId, refreshKey]);

  const filtered = useMemo(() => bookings.filter((b) => {
    if (statusFilter && b.status !== statusFilter) return false;
    if (dateFilter && (b.checkInIso || b.visitDate) !== dateFilter) return false;
    return true;
  }), [bookings, statusFilter, dateFilter]);

  const today = new Date().toISOString().slice(0, 10);
  const stats = useMemo(() => ({
    total: bookings.length,
    today: bookings.filter((b) => (b.checkInIso || b.visitDate) === today).length,
    arrived: bookings.filter((b) => b.status === "arrived").length,
    cancelled: bookings.filter((b) => b.status === "cancelled").length,
  }), [bookings, today]);

  if (!provider) {
    // Reached only very briefly while the initial GET /api/dashboard/
    // providers is still in flight (App.jsx switches an admin account
    // straight to Admin mode once it resolves to zero providers, so this
    // empty-list case doesn't linger here) — genuinely no providers to
    // pick from is not the same as "still loading", but there's no way to
    // tell them apart from this component's own props alone.
    return <div className="card"><div className="empty">{providers.length === 0 ? "No businesses set up yet — add one from Admin → Manage Businesses." : "Loading…"}</div></div>;
  }

  return (
    <>
      <div className="stat-bar">
        <div className="stat-tile"><div className="n">{stats.total}</div><div className="l">Total bookings</div></div>
        <div className="stat-tile"><div className="n">{stats.today}</div><div className="l">Today</div></div>
        <div className="stat-tile"><div className="n">{stats.arrived}</div><div className="l">Arrived</div></div>
        <div className="stat-tile"><div className="n">{stats.cancelled}</div><div className="l">Cancelled</div></div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">📋 Bookings</span></div>
        <div className="filters-row">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="booked">Booked</option>
            <option value="arrived">Arrived</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} />
          {(statusFilter || dateFilter) && <button className="btn-link" onClick={() => { setStatusFilter(""); setDateFilter(""); }}>× Clear filters</button>}
        </div>
        {error && <div className="error-banner">{error}</div>}
        <BookingsTable bookings={filtered} onChanged={() => { load(); bump(); }} />
      </div>

      <AnalyticsPanel refreshKey={refreshKey} />
      <AvailabilityPanel provider={provider} />
      <CalendarSyncPanel provider={provider} />
      <SupportRequestsPanel refreshKey={refreshKey} workflowLabel={workflowLabel} />
      <FeedbackPanel refreshKey={refreshKey} workflowLabel={workflowLabel} />
      <KnowledgeBasePanel refreshKey={refreshKey} provider={provider} isAdmin={false} />
    </>
  );
}
