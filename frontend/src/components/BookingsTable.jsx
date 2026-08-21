import { useState } from "react";
import { Link } from "react-router-dom";
import { StatusBadge, PaymentStatusBadge } from "./Badges";
import { formatIST, whenGeneric } from "../lib/format";
import { patch, del } from "../lib/api";

// Section 13 — one generic table for every workflow type rather than the
// vanilla dashboard's per-workflow column config (PROFILES in
// dashboard.html): a booking's shape already varies by workflow (medical
// has age/gender/reason, hotel has nights, a salon has neither), so a
// single "Details" column summarizing whichever fields are actually
// present covers every workflow without hand-maintaining one column set
// per industry. A deliberate simplification, not a missing feature —
// the information is all still shown, just not in per-industry columns.
function bookingDetails(b) {
  const parts = [];
  if (b.reason) parts.push(b.reason);
  if (b.age) parts.push(`${b.age}y`);
  if (b.gender) parts.push(b.gender);
  if (b.nights) parts.push(`${b.nights} night${b.nights === 1 ? "" : "s"}`);
  return parts.join(" · ") || "—";
}

export default function BookingsTable({ bookings, onChanged, showBusinessColumn, workflowLabel, readOnly, allowDelete }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");

  // Admin-only, permanent — separate from every action above (all soft
  // status transitions). Used to actually clear test/demo bookings, not a
  // normal booking-lifecycle action, so it's gated by its own prop rather
  // than tied to `readOnly` (the admin cross-business table passes
  // readOnly=true for the existing per-booking actions, but still wants
  // this one).
  async function handleDelete(booking) {
    if (!confirm(`Permanently delete booking ${booking.bookingId}? This cannot be undone.`)) return;
    setBusyId(booking.id);
    setError("");
    try {
      await del(`/api/dashboard/bookings/${booking.id}`);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function runAction(id, action, extra) {
    setBusyId(id);
    setError("");
    try {
      await patch(`/api/dashboard/bookings/${id}`, { action, ...extra });
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleRefund(booking) {
    // Resolves the booking's paid payment on demand — same approach as
    // the vanilla dashboard's manualRefundBooking(), since payments
    // aren't preloaded into every booking row.
    try {
      const payments = await (await fetch("/api/dashboard/payments", { credentials: "include" })).json();
      const paid = payments.find((p) => p.bookingId === booking.id && p.status === "paid");
      if (!paid) return setError("No paid payment found for this booking — it may have already been refunded.");
      const rupees = paid.amount / 100;
      const input = window.prompt(`Refund amount in ₹ (up to ₹${rupees}). Leave blank for a full refund.`, "");
      if (input === null) return;
      const amount = input.trim() === "" ? undefined : Number(input.trim());
      if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0 || amount > rupees)) {
        return setError(`Refund amount must be a number between 0 and ₹${rupees}.`);
      }
      if (!window.confirm(`Refund ₹${amount ?? rupees} to the customer?`)) return;
      setBusyId(booking.id);
      await fetch(`/api/dashboard/payments/${paid.id}/refund`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(amount !== undefined ? { amount } : {}),
      });
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  if (bookings.length === 0) return <div className="empty">No bookings match the current filters.</div>;

  return (
    <div className="table-scroll">
      {error && <div className="error-banner">{error}</div>}
      <table>
        <thead>
          <tr>
            {showBusinessColumn && <th>Business</th>}
            <th>Booking ID</th>
            <th>Customer</th>
            <th>Provider</th>
            <th>When</th>
            <th>Details</th>
            <th>Payment</th>
            <th>Status</th>
            <th>Booked At (IST)</th>
            {(!readOnly || allowDelete) && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {bookings.map((b) => {
            const actionable = b.status !== "cancelled" && b.status !== "done";
            const busy = busyId === b.id;
            return (
              <tr key={b.id}>
                {showBusinessColumn && <td>{workflowLabel?.(b.workflowId) || b.workflowId}</td>}
                <td>{b.bookingId}</td>
                <td>{b.waId ? <Link to={`/customers/${encodeURIComponent(b.waId)}`}>{b.customerName || b.waId}</Link> : (b.customerName || "—")}</td>
                <td>{b.providerName || "—"}</td>
                <td>{whenGeneric(b)}</td>
                <td style={{ whiteSpace: "normal", maxWidth: 220 }}>{bookingDetails(b)}</td>
                <td><PaymentStatusBadge status={b.paymentStatus} /></td>
                <td><StatusBadge status={b.status} /></td>
                <td>{formatIST(b.createdAt)}</td>
                {(!readOnly || allowDelete) && (
                  <td style={{ whiteSpace: "nowrap" }}>
                    {!readOnly && b.paymentStatus === "paid" && (
                      <button className="btn-secondary" disabled={busy} onClick={() => handleRefund(b)} style={{ padding: "3px 8px", fontSize: 12, marginRight: 4 }}>💰 Refund</button>
                    )}
                    {!readOnly && actionable && b.visitTime && (
                      b.status === "serving"
                        ? <button className="btn-secondary" disabled={busy} onClick={() => runAction(b.id, "complete")} style={{ padding: "3px 8px", fontSize: 12, marginRight: 4 }}>✅ Complete</button>
                        : <button className="btn-secondary" disabled={busy} onClick={() => runAction(b.id, "serve")} style={{ padding: "3px 8px", fontSize: 12, marginRight: 4 }}>▶️ Serve</button>
                    )}
                    {!readOnly && actionable && (
                      <button className="btn-danger" disabled={busy} onClick={() => {
                        const note = window.prompt("Optional: reason for cancellation (sent to customer)") ?? "";
                        if (note === null) return;
                        runAction(b.id, "cancel", { note: note.trim() || undefined });
                      }} style={{ padding: "3px 8px", fontSize: 12, marginRight: 4 }}>❌ Cancel</button>
                    )}
                    {!readOnly && actionable && b.visitTime && (
                      <button className="btn-secondary" disabled={busy} onClick={() => {
                        const date = window.prompt("New date (YYYY-MM-DD):", b.visitDate || "");
                        if (!date) return;
                        const time = window.prompt("New time (e.g. 14:00), optional:", "") || undefined;
                        const note = window.prompt("Optional note for the customer:", "") || undefined;
                        runAction(b.id, "reschedule", { rescheduleDate: date, rescheduleTime: time, note });
                      }} style={{ padding: "3px 8px", fontSize: 12, marginRight: 4 }}>📅 Reschedule</button>
                    )}
                    {!readOnly && actionable && b.visitTime && b.status !== "no_show" && (
                      <button className="btn-secondary" disabled={busy} onClick={() => {
                        if (!window.confirm("Mark this booking as a no-show?")) return;
                        runAction(b.id, "no_show");
                      }} style={{ padding: "3px 8px", fontSize: 12 }}>🚫 No-show</button>
                    )}
                    {allowDelete && (
                      <button className="btn-danger" disabled={busy} onClick={() => handleDelete(b)} style={{ padding: "3px 8px", fontSize: 12 }}>🗑️ Delete</button>
                    )}
                    {!readOnly && !actionable && !(b.paymentStatus === "paid") && <span style={{ fontSize: 12, color: "var(--muted)" }}>—</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
