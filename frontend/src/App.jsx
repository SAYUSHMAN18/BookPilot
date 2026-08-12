import { useEffect, useState, useCallback } from "react";
import { useAuth } from "./lib/AuthContext";
import { get } from "./lib/api";
import { useLiveEvents } from "./lib/useLiveEvents";
import LoginPage from "./pages/LoginPage";
import ProviderView from "./pages/ProviderView";
import AdminView from "./pages/AdminView";
import PlatformAdminView from "./pages/PlatformAdminView";

export default function App() {
  const { user, pending, logout } = useAuth();
  const [providers, setProviders] = useState([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [mode, setMode] = useState("provider"); // view toggle — an admin ACCOUNT can still browse a single provider's own view, same as the vanilla dashboard
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  const isPlatformAdmin = user?.role === "platform_admin";

  useEffect(() => {
    // A platform_admin has no tenantId — /api/dashboard/* routes aren't
    // theirs to call at all (requireAuth("admin", "provider") 403s them),
    // they get PlatformAdminView instead, below.
    if (user === undefined || user === null || pending || isPlatformAdmin) return;
    get("/api/dashboard/providers").then((list) => {
      setProviders(list);
      if (list.length) {
        setSelectedKey(`${list[0].workflowId}::${list[0].providerId}`);
      } else if (user.role === "admin") {
        // A brand new tenant starts with zero businesses (nothing is
        // auto-seeded any more) — the Provider view has nothing to show
        // for an admin until at least one exists, so land them on Admin
        // (Manage Businesses) instead of a dead-end "Loading providers…"
        // screen. A real provider-role account can never hit this: it's
        // always pinned to one already-existing workflowId+providerId.
        setMode("admin");
      }
    });
  }, [user, pending, isPlatformAdmin]);

  const connected = useLiveEvents((type) => {
    // Any booking/support/feedback event is relevant to at least one
    // visible panel — a single shared refreshKey bump keeps this simple;
    // each panel's own useEffect dependency on refreshKey re-fetches only
    // itself, not a full-page reload.
    if (type) bump();
  });

  if (user === undefined) return null; // still checking session
  if (pending) {
    return (
      <div className="login-wrap">
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
    );
  }
  if (!user) return <LoginPage />;
  if (isPlatformAdmin) return <PlatformAdminView currentUserEmail={user.email} logout={logout} />;

  const isAdminAccount = user.role === "admin";
  const provider = providers.find((p) => `${p.workflowId}::${p.providerId}` === selectedKey);

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand">BookPilot AI</span>

        {isAdminAccount && (
          <div className="role-toggle">
            <button className={mode === "provider" ? "active" : ""} onClick={() => setMode("provider")}>🏢 Provider</button>
            <button className={mode === "admin" ? "active" : ""} onClick={() => setMode("admin")}>👑 Admin</button>
          </div>
        )}

        {mode === "provider" && (
          <select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)} style={{ minWidth: 220 }}>
            {providers.map((p) => (
              <option key={`${p.workflowId}::${p.providerId}`} value={`${p.workflowId}::${p.providerId}`}>{p.workflowLabel} — {p.providerName}</option>
            ))}
          </select>
        )}

        <button className="btn-secondary" onClick={bump}>↻ Refresh</button>
        <span className="live-indicator" title="Live updates">
          <span className="live-dot" style={{ background: connected ? "var(--success)" : "var(--subtle)" }} /> Live
        </span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{user.name || user.email} ({user.role})</span>
        <button className="btn-link" onClick={logout}>Log out</button>
      </header>

      <main className="app-main">
        {mode === "admin" && isAdminAccount ? (
          <AdminView providers={providers} refreshKey={refreshKey} bump={bump} currentUserEmail={user.email} />
        ) : (
          <ProviderView provider={provider} providers={providers} refreshKey={refreshKey} bump={bump} />
        )}
      </main>
    </div>
  );
}
