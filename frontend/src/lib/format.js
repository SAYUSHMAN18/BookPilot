export function formatIST(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function whenGeneric(b) {
  return b.checkInIso
    ? `${b.checkInIso} (${b.nights} night${b.nights === 1 ? "" : "s"})`
    : `${b.visitDateLabel || b.visitDate || "—"} ${b.visitTime || ""}`.trim();
}

export const STATUS_ICON = { booked: "🔵", arrived: "✅", cancelled: "❌", rescheduled: "📅", serving: "▶️", done: "🏁", no_show: "🚫", payment_pending: "⏳" };

export const PAYMENT_STATUS_META = {
  pending: { icon: "⏳", color: "#d97706" },
  paid: { icon: "✅", color: "#16a34a" },
  failed: { icon: "⚠️", color: "#dc2626" },
  refunded: { icon: "↩️", color: "#6366f1" },
  partially_refunded: { icon: "↩️", color: "#6366f1" },
};
