import { useEffect, useMemo, useState } from "react";
import { get } from "../lib/api";
import BookingsTable from "../components/BookingsTable";
import AnalyticsPanel from "../components/AnalyticsPanel";
import SupportRequestsPanel from "../components/SupportRequestsPanel";
import FeedbackPanel from "../components/FeedbackPanel";
import KnowledgeBasePanel from "../components/KnowledgeBasePanel";
import ManageTeamPanel from "../components/ManageTeamPanel";
import AuditLogPanel from "../components/AuditLogPanel";
import ManageBusinessesPanel from "../components/ManageBusinessesPanel";
import ApiKeysPanel from "../components/ApiKeysPanel";
import SetupChecklistPanel from "../components/SetupChecklistPanel";
import BillingPanel from "../components/BillingPanel";
import SessionsPanel from "../components/SessionsPanel";

export default function AdminView({ providers, refreshKey, bump, currentUserEmail }) {
  const [bookings, setBookings] = useState([]);
  const [search, setSearch] = useState("");
  const [biz, setBiz] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState("");

  const workflowLabel = useMemo(() => {
    const map = new Map();
    providers.forEach((p) => map.set(p.workflowId, p.workflowLabel));
    return (id) => map.get(id) || id;
  }, [providers]);

  async function load() {
    try { setBookings(await get("/api/dashboard/all-bookings")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [refreshKey]);

  const filtered = useMemo(() => bookings.filter((b) => {
    if (biz && b.workflowId !== biz) return false;
    if (status && b.status !== status) return false;
    if (date && (b.checkInIso || b.visitDate) !== date) return false;
    if (search) {
      const hay = `${b.customerName || ""} ${b.bookingId || ""}`.toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  }), [bookings, biz, status, date, search]);

  const businesses = useMemo(() => [...new Map(providers.map((p) => [p.workflowId, p.workflowLabel])).entries()], [providers]);

  return (
    <>
      <SetupChecklistPanel refreshKey={refreshKey} />

      <div className="card">
        <div className="card-header">
          <span className="card-title">📊 All Bookings</span>
          <span className="count-badge">{filtered.length === bookings.length ? `${bookings.length} total` : `${filtered.length} of ${bookings.length}`}</span>
        </div>
        <div className="filters-row">
          <input placeholder="Search customer or booking ID…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 220 }} />
          <select value={biz} onChange={(e) => setBiz(e.target.value)}>
            <option value="">All businesses</option>
            {businesses.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="booked">Booked</option>
            <option value="arrived">Arrived</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          {(search || biz || status || date) && <button className="btn-link" onClick={() => { setSearch(""); setBiz(""); setStatus(""); setDate(""); }}>× Clear all</button>}
        </div>
        {error && <div className="error-banner">{error}</div>}
        <BookingsTable bookings={filtered} onChanged={() => { load(); bump(); }} showBusinessColumn workflowLabel={workflowLabel} readOnly />
      </div>

      <AnalyticsPanel refreshKey={refreshKey} />
      <BillingPanel refreshKey={refreshKey} />
      <ManageBusinessesPanel refreshKey={refreshKey} bump={bump} />
      <ManageTeamPanel refreshKey={refreshKey} providers={providers} currentUserEmail={currentUserEmail} />
      <ApiKeysPanel refreshKey={refreshKey} />
      <SupportRequestsPanel refreshKey={refreshKey} workflowLabel={workflowLabel} />
      <FeedbackPanel refreshKey={refreshKey} workflowLabel={workflowLabel} />
      <KnowledgeBasePanel refreshKey={refreshKey} isAdmin workflowLabel={workflowLabel} />
      <AuditLogPanel refreshKey={refreshKey} />
      <SessionsPanel refreshKey={refreshKey} />
    </>
  );
}
