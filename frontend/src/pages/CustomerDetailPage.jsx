import { useEffect, useMemo, useState } from "react";
import { useParams, useOutletContext, Link } from "react-router-dom";
import { get, patch } from "../lib/api";
import { formatIST } from "../lib/format";
import BookingsTable from "../components/BookingsTable";

// Enterprise Hardening Phase 3, item 1 — one customer's full profile:
// contact info, lifetime stats (customerStore.summaryForCustomer, Phase
// 1), every booking they've ever made with this business (terminal
// statuses included, unlike every other bookings view in this app),
// their feedback history, and an editable internal note (Phase 3, item
// 2). Reached by tapping a customer's name in BookingsTable.
export default function CustomerDetailPage() {
  const { waId } = useParams();
  const { providers, refreshKey, bump, isAdminAccount } = useOutletContext();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSavedAt, setNoteSavedAt] = useState(0);

  const workflowLabel = useMemo(() => {
    const map = new Map();
    providers.forEach((p) => map.set(p.workflowId, p.workflowLabel));
    return (id) => map.get(id) || id;
  }, [providers]);

  async function load() {
    try {
      const result = await get(`/api/dashboard/customers/${encodeURIComponent(waId)}`);
      setData(result);
      setNoteDraft(result.note || "");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load();   }, [waId, refreshKey]);

  async function saveNote() {
    setNoteSaving(true);
    setError("");
    try {
      await patch(`/api/dashboard/customers/${encodeURIComponent(waId)}/note`, { note: noteDraft });
      setNoteSavedAt(Date.now());
    } catch (err) {
      setError(err.message);
    } finally {
      setNoteSaving(false);
    }
  }

  // Same hand-rolled, zero-dependency Blob/anchor pattern as
  // BookingsPage.jsx's exportCsv() — kept intentionally identical rather
  // than factored into a shared helper for a two-column-set difference,
  // since the column list is the entire interesting part of each.
  function exportCsv() {
    const cols = [
      ...(isAdminAccount ? [["Business", (b) => workflowLabel(b.workflowId)]] : []),
      ["Booking ID", (b) => b.bookingId || ""],
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
      ...data.bookings.map((b) => cols.map(([, get]) => escape(get(b))).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `customer-${waId}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (error && !data) {
    return (
      <div className="card">
        <Link to="/bookings" className="btn-link">&larr; Back to bookings</Link>
        <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>
      </div>
    );
  }
  if (!data) return null;

  const { summary, bookings, feedback } = data;
  const customerName = bookings.find((b) => b.customerName)?.customerName;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <Link to="/bookings" className="btn-link">&larr; Back to bookings</Link>
        <div className="card-header" style={{ marginTop: 8 }}>
          <span className="card-title">👤 {customerName || "Customer"}</span>
          <span className="count-badge">{waId}</span>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 8 }}>
          <Stat label="Visits" value={summary.visitCount} />
          <Stat label="Lifetime value" value={`₹${(summary.lifetimeValue / 100).toLocaleString("en-IN")}`} />
          <Stat label="First visit" value={formatIST(summary.firstVisitAt)} />
          <Stat label="Last visit" value={formatIST(summary.lastVisitAt)} />
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">📝 Internal note</span></div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
          Only visible to your team — never sent to the customer.
        </div>
        <textarea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          maxLength={2000}
          rows={3}
          style={{ width: "100%", resize: "vertical" }}
          placeholder="e.g. prefers evening slots, allergic to almond oil…"
        />
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn-secondary" disabled={noteSaving || noteDraft === (data.note || "")} onClick={saveNote}>
            {noteSaving ? "Saving…" : "Save note"}
          </button>
          {noteSavedAt > 0 && Date.now() - noteSavedAt < 4000 && <span style={{ fontSize: 12, color: "var(--muted)" }}>Saved</span>}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">📋 Booking history</span>
          <span className="count-badge">{bookings.length}</span>
          <button className="btn-secondary" style={{ marginLeft: "auto" }} disabled={!bookings.length} onClick={exportCsv}>⬇ Export CSV</button>
        </div>
        <BookingsTable
          bookings={bookings}
          onChanged={() => { load(); bump(); }}
          showBusinessColumn={isAdminAccount}
          workflowLabel={workflowLabel}
          readOnly={isAdminAccount}
          allowDelete={isAdminAccount}
        />
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">💬 Feedback</span>
          <span className="count-badge">{feedback.length}</span>
        </div>
        {feedback.length === 0 ? <div className="empty">No feedback from this customer yet.</div> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>When (IST)</th><th>Rating</th><th>Comment</th></tr></thead>
              <tbody>
                {feedback.map((f) => (
                  <tr key={f.id}>
                    <td>{formatIST(f.createdAt)}</td>
                    <td>{f.rating ? "⭐".repeat(f.rating) : "—"}</td>
                    <td style={{ whiteSpace: "normal", maxWidth: 420 }}>{f.comment || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
