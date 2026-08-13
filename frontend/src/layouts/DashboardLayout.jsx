import { NavLink, Outlet } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/", label: "Overview", icon: "📊", end: true },
  { to: "/bookings", label: "Bookings", icon: "📋" },
  { to: "/availability", label: "Availability", icon: "🗓️" },
  { to: "/team", label: "Team", icon: "👥", adminOnly: true },
  { to: "/businesses", label: "Businesses", icon: "🏢", adminOnly: true },
  { to: "/analytics", label: "Analytics", icon: "📈" },
  { to: "/support", label: "Support", icon: "💬" },
  { to: "/billing", label: "Billing", icon: "💳", adminOnly: true },
  { to: "/settings", label: "Settings", icon: "⚙️" },
];

// New plan, Stream 4 — the sidebar+routed shell replacing App.jsx's old
// single stacked <main>. Every page below reads shared state (providers
// list, refreshKey/bump, connection status) via useOutletContext() rather
// than each needing its own copy of App.jsx's data-fetching — one source
// of truth for "what changed" (refreshKey) still drives every page's own
// re-fetch, same as the old single-page version.
export default function DashboardLayout({ user, providers, refreshKey, bump, connected, logout, isAdminAccount }) {
  return (
    <div className="app-shell-sidebar">
      <aside className="sidebar">
        <div className="sidebar-brand">BookPilot AI</div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.filter((item) => !item.adminOnly || isAdminAccount).map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => "sidebar-link" + (isActive ? " active" : "")}>
              <span className="sidebar-icon">{item.icon}</span> {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="live-indicator" title="Live updates">
            <span className="live-dot" style={{ background: connected ? "var(--success)" : "var(--subtle)" }} /> Live
          </span>
          <button className="btn-secondary btn-full" onClick={bump}>↻ Refresh</button>
          <div className="sidebar-user">{user.name || user.email} <span className="sidebar-role">({user.role})</span></div>
          <button className="btn-link" onClick={logout}>Log out</button>
        </div>
      </aside>
      <main className="app-main app-main-sidebar">
        <Outlet context={{ user, providers, refreshKey, bump, isAdminAccount }} />
      </main>
    </div>
  );
}
