import { useOutletContext } from "react-router-dom";
import AnalyticsPanel from "../components/AnalyticsPanel";

// GET /api/dashboard/analytics already scopes itself server-side by the
// caller's own role (admin sees the whole tenant, provider sees only
// themselves) — no client-side branching needed here, unlike Bookings.
export default function AnalyticsPage() {
  const { refreshKey } = useOutletContext();
  return <AnalyticsPanel refreshKey={refreshKey} />;
}
