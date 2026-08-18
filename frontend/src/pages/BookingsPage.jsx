import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { get } from "../lib/api";
import BookingsTable from "../components/BookingsTable";

// Admin: every booking across every business (GET /api/dashboard/all-bookings),
// filterable/searchable — the same "All Bookings" card the old single-page
// AdminView had. Provider: just their own workflowId+providerId's bookings
// (GET /api/dashboard/bookings) — same as the old ProviderView.
export default function BookingsPage() {
  const { providers, refreshKey, bump, isAdminAccount } = useOutletContext();
  const [bookings, setBookings] = useState([]);
  const [search, setSearch] = useState("");
  const [biz, setBiz] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState("");
  const ownProvider = providers[0];

  const workflowLabel = useMemo(() => {
    const map = new Map();
    providers.forEach((p) => map.set(p.workflowId, p.workflowLabel));
    return (id) => map.get(id) || id;
  }, [providers]);

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
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [refreshKey, isAdminAccount, ownProvider?.workflowId, ownProvider?.providerId]);

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

  // CSV export — a real, recurring need for a small business (taxes,
  // bookkeeping, a monthly report to an owner who doesn't use this
  // dashboard themselves) that had no way out of the app at all before.
  // Exports exactly what's currently on screen (respects every active
  // filter/search), not a separate "export everything" endpoint — what
  // you're looking at is what you get.
  function exportCsv() {
    const cols = [
      ...(isAdminAccount ? [["Business", (b) => workflowLabel(b.workflowId)]] : []),
      ["Booking ID", (b) => b.bookingId || ""],
      ["Customer", (b) => b.customerName || ""],
      ["Phone", (b) => b.waId || ""],
      ["Provider", (b) => b.providerName || b.hotelName || ""],
      ["Date", (b) => b.checkInIso || b.visitDate || ""],
      ["Time", (b) => b.visitTime || ""],
      ["Status", (b) => b.status || ""],
      ["Payment", (b) => b.paymentStatus || ""],
      ["Booked At", (b) => (b.createdAt ? new Date(b.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "")],
    ];
    const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [
      cols.map(([label]) => escape(label)).join(","),
      ...filtered.map((b) => cols.map(([, get]) => escape(get(b))).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bookings-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">📋 Bookings</span>
        <span className="count-badge">{filtered.length === bookings.length ? `${bookings.length} total` : `${filtered.length} of ${bookings.length}`}</span>
        <button className="btn-secondary" style={{ marginLeft: "auto" }} disabled={!filtered.length} onClick={exportCsv}>⬇ Export CSV</button>
      </div>
      <div className="filters-row">
        <input placeholder="Search customer or booking ID…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 220 }} />
        {isAdminAccount && (
          <select value={biz} onChange={(e) => setBiz(e.target.value)}>
            <option value="">All businesses</option>
            {businesses.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        )}
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
      <BookingsTable
        bookings={filtered}
        onChanged={() => { load(); bump(); }}
        showBusinessColumn={isAdminAccount}
        workflowLabel={workflowLabel}
        readOnly={isAdminAccount}
        allowDelete={isAdminAccount}
      />
    </div>
  );
}
