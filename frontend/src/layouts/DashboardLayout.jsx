import { useState, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { IconGrid, IconCalendar, IconClock, IconUsers, IconBuilding, IconTrendUp, IconMessage, IconCard, IconSliders, IconLogout, IconPlane, IconMenu, IconX } from "../components/Icons";
import ThemeToggle from "../components/ThemeToggle";

const NAV_ITEMS = [
  { to: "/", label: "Overview", Icon: IconGrid, end: true },
  { to: "/bookings", label: "Bookings", Icon: IconCalendar },
  { to: "/availability", label: "Availability", Icon: IconClock },
  { to: "/team", label: "Team", Icon: IconUsers, adminOnly: true },
  { to: "/businesses", label: "Businesses", Icon: IconBuilding, adminOnly: true },
  { to: "/analytics", label: "Analytics", Icon: IconTrendUp },
  { to: "/support", label: "Support", Icon: IconMessage },
  { to: "/billing", label: "Billing", Icon: IconCard, adminOnly: true },
  { to: "/settings", label: "Settings", Icon: IconSliders },
];

// New plan, Stream 4 — the sidebar+routed shell replacing App.jsx's old
// single stacked <main>. Every page below reads shared state (providers
// list, refreshKey/bump, connection status) via useOutletContext() rather
// than each needing its own copy of App.jsx's data-fetching — one source
// of truth for "what changed" (refreshKey) still drives every page's own
// re-fetch, same as the old single-page version.
export default function DashboardLayout({ user, providers, refreshKey, bump, connected, logout, isAdminAccount }) {
  // bump() itself is a synchronous counter increment — every page's own
  // useEffect(refreshKey) is what actually re-fetches, asynchronously and
  // invisibly to this button. Found live: clicking Refresh DID trigger real
  // network requests (confirmed in devtools) but looked completely dead —
  // no spinner, no confirmation, identical pixels before and after. This
  // local state is purely a felt-response layer on top of the already-
  // working bump(), so a click always visibly does something.
  const [refreshState, setRefreshState] = useState("idle"); // idle | spinning | done
  function handleRefresh() {
    if (refreshState === "spinning") return;
    setRefreshState("spinning");
    bump();
    setTimeout(() => {
      setRefreshState("done");
      setTimeout(() => setRefreshState("idle"), 1100);
    }, 550);
  }
  // Found live (mobile audit): below the sidebar's own collapse-to-column
  // breakpoint, the full sidebar (brand + all 9 nav links + footer) always
  // rendered inline, stacked ABOVE the actual page — on a phone that's
  // 400+ px of navigation a visitor has to scroll past before reaching any
  // real content, on every single page. mobileNavOpen turns the sidebar
  // into a real off-canvas drawer at that same breakpoint instead: closed
  // (out of the layout, not just visually hidden) by default, opened by
  // the hamburger button in mobileNavOpen's own top bar.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();
  // Closes the drawer automatically on navigation — without this, tapping
  // a nav link would navigate correctly but leave the drawer covering the
  // new page until the visitor found and tapped the close button separately.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  const initial = (user.name || user.email || "?").trim().slice(0, 1).toUpperCase();
  return (
    <div className="app-shell-sidebar">
      <div className="mobile-topbar">
        <span className="sidebar-brand">
          <span className="sidebar-brand-mark"><IconPlane /></span>
          <span>BookPilot<span className="sidebar-brand-ai">AI</span></span>
        </span>
        <button className="mobile-nav-toggle" aria-label={mobileNavOpen ? "Close menu" : "Open menu"} onClick={() => setMobileNavOpen((v) => !v)}>
          {mobileNavOpen ? <IconX /> : <IconMenu />}
        </button>
      </div>
      {mobileNavOpen && <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} />}
      <aside className={"sidebar" + (mobileNavOpen ? " mobile-open" : "")}>
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark"><IconPlane /></span>
          <span>BookPilot<span className="sidebar-brand-ai">AI</span></span>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.filter((item) => !item.adminOnly || isAdminAccount).map(({ to, label, Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => "sidebar-link" + (isActive ? " active" : "")}>
              <span className="sidebar-icon"><Icon /></span> {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="live-indicator" title="Live updates">
            <span className="live-dot" style={{ background: connected ? "var(--success)" : "var(--subtle)" }} /> Live
          </span>
          <button
            className={"btn-secondary btn-full btn-refresh" + (refreshState === "spinning" ? " is-spinning" : "")}
            onClick={handleRefresh}
            disabled={refreshState === "spinning"}
          >
            <span className="btn-refresh-icon">↻</span>
            {refreshState === "spinning" ? "Refreshing…" : refreshState === "done" ? "✓ Refreshed" : "Refresh"}
          </button>
          <div className="sidebar-user-row">
            <span className="sidebar-avatar">{initial}</span>
            <div className="sidebar-user">
              <div className="sidebar-user-name">{user.name || user.email}</div>
              <div className="sidebar-role">{user.role}</div>
            </div>
            <button className="sidebar-logout" title="Log out" onClick={logout}><IconLogout /></button>
          </div>
          <ThemeToggle />
        </div>
      </aside>
      <main className="app-main app-main-sidebar">
        <Outlet context={{ user, providers, refreshKey, bump, isAdminAccount }} />
      </main>
    </div>
  );
}
