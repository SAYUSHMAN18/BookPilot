import { useEffect, useState, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./lib/AuthContext";
import { get } from "./lib/api";
import { useLiveEvents } from "./lib/useLiveEvents";
import LoginPage from "./pages/LoginPage";
import PlatformAdminView from "./pages/PlatformAdminView";
import DashboardLayout from "./layouts/DashboardLayout";
import OverviewPage from "./pages/OverviewPage";
import BookingsPage from "./pages/BookingsPage";
import CustomerDetailPage from "./pages/CustomerDetailPage";
import AvailabilityPage from "./pages/AvailabilityPage";
import TeamPage from "./pages/TeamPage";
import BusinessesPage from "./pages/BusinessesPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import SupportPage from "./pages/SupportPage";
import BillingPage from "./pages/BillingPage";
import SettingsPage from "./pages/SettingsPage";

// New plan, Stream 2 — a needsPlanSelection session has nothing to do in
// this app at all; checkout lives on the marketing site's own origin
// (public/marketing/plan-selection.html). window.MARKETING_URL comes from
// /app-config.js (see server.js) — same runtime-config pattern the
// marketing site already uses in reverse for its own "Log in" links.
function redirectToPlanSelection() {
  const marketingUrl = window.MARKETING_URL || "http://localhost:8082";
  window.location.href = `${marketingUrl}/plan-selection`;
}

export default function App() {
  const { user, pending, needsPlanSelection, logout } = useAuth();
  const [providers, setProviders] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  const isPlatformAdmin = user?.role === "platform_admin";

  useEffect(() => {
    // A platform_admin has no tenantId — /api/dashboard/* routes aren't
    // theirs to call at all (requireAuth("admin", "provider") 403s them),
    // they get PlatformAdminView instead, below.
    if (user === undefined || user === null || pending || isPlatformAdmin) return;
    get("/api/dashboard/providers").then(setProviders);
  }, [user, pending, isPlatformAdmin]);

  const connected = useLiveEvents((type) => {
    // Any booking/support/feedback event is relevant to at least one
    // visible page — a single shared refreshKey bump keeps this simple;
    // each page's own useEffect dependency on refreshKey re-fetches only
    // itself, not a full-page reload.
    if (type) bump();
  });

  if (user === undefined) return null; // still checking session
  if (needsPlanSelection) {
    redirectToPlanSelection();
    return null;
  }
  if (pending) {
    return (
      <div className="login-wrap">
        <div className="login-card-wrap">
          <div className="login-card">
            <h1>Almost there 👋</h1>
            <p>
              {user ? `Thanks, ${user.name || user.email} — your` : "Your"} account is pending activation. Our team
              reviews every new business and will be in touch shortly to get you fully set up. You'll get an email
              once you're activated and ready to log in.
            </p>
            <button className="btn-link" onClick={logout} style={{ marginTop: 14 }}>Log out</button>
          </div>
        </div>
      </div>
    );
  }
  if (!user) return <LoginPage />;
  if (isPlatformAdmin) return <PlatformAdminView currentUserEmail={user.email} logout={logout} />;

  const isAdminAccount = user.role === "admin";
  // A brand new tenant starts with zero businesses (nothing is auto-seeded
  // any more) — Overview has nothing bookings-shaped to show for an admin
  // until at least one exists, so it leads with the setup checklist either
  // way; Bookings/Availability/Analytics for a zero-provider admin just
  // render their own empty states rather than needing a special case here.

  return (
    <BrowserRouter basename="/app">
      <Routes>
        <Route
          element={
            <DashboardLayout
              user={user}
              providers={providers}
              refreshKey={refreshKey}
              bump={bump}
              connected={connected}
              logout={logout}
              isAdminAccount={isAdminAccount}
            />
          }
        >
          <Route index element={<OverviewPage />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="customers/:waId" element={<CustomerDetailPage />} />
          <Route path="availability" element={<AvailabilityPage />} />
          {isAdminAccount && <Route path="team" element={<TeamPage />} />}
          {isAdminAccount && <Route path="businesses" element={<BusinessesPage />} />}
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="support" element={<SupportPage />} />
          {isAdminAccount && <Route path="billing" element={<BillingPage />} />}
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
