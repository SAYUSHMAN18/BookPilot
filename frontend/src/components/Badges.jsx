import { STATUS_ICON, PAYMENT_STATUS_META } from "../lib/format";

export function StatusBadge({ status }) {
  return <span className={`status-badge status-${status}`}>{STATUS_ICON[status] || ""} {status}</span>;
}

export function PaymentStatusBadge({ status }) {
  if (!status || status === "not_required") return <span style={{ color: "var(--muted)" }}>—</span>;
  const meta = PAYMENT_STATUS_META[status] || { icon: "", color: "var(--muted)" };
  return <span style={{ fontSize: 12, fontWeight: 600, color: meta.color }}>{meta.icon} {status.replace(/_/g, " ")}</span>;
}
