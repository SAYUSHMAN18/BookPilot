import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = logged out
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setUser)
      .catch(() => setUser(null));
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
    setUser(body.user);
    return true;
  }, []);

  const logout = useCallback(async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, error, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
