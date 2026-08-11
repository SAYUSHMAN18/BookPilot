import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "./api";

const AuthContext = createContext(null);

// New plan, Section 2 — a session can be genuinely "logged in" (real
// credentials, real cookie) while still being blocked from every
// /api/dashboard/* route because the tenant hasn't been activated yet
// (requireAuth()'s own pendingActivation flag on a 403). That's a
// distinct state from "not logged in at all" — checkSession() below is
// the one place that tells the two apart, used both on first load and
// right after a fresh login, so the app can show one clear "pending
// activation" screen instead of a dashboard full of repeated 403s.
async function checkSession() {
  const resp = await fetch("/api/auth/me", { credentials: "include" });
  if (resp.ok) return { user: await resp.json(), pending: false };
  const body = await resp.json().catch(() => ({}));
  if (resp.status === 403 && body.pendingActivation) return { user: null, pending: true };
  return { user: null, pending: false };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = logged out
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    checkSession().then(({ user, pending }) => {
      setUser(user);
      setPending(pending);
    });
  }, []);

  const login = useCallback(async (email, password) => {
    setError("");
    const resp = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      setError(body.error || "Login failed.");
      return false;
    }
    // A successful login proves the credentials are real, but says
    // nothing about tenant status — /api/auth/login doesn't check it.
    // The very next request (this one) is what actually reveals whether
    // the dashboard is reachable yet.
    const session = await checkSession();
    setUser(session.user ?? body.user);
    setPending(session.pending);
    return true;
  }, []);

  const logout = useCallback(async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    setUser(null);
    setPending(false);
  }, []);

  return <AuthContext.Provider value={{ user, pending, error, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
