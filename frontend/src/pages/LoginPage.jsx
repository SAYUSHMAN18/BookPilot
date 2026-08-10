import { useState } from "react";
import { useAuth } from "../lib/AuthContext";
import { api } from "../lib/api";

export default function LoginPage() {
  const { login, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotMsg, setForgotMsg] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    await login(email, password);
    setBusy(false);
  }

  async function handleForgot(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = await api("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
      setForgotMsg(body.message || "If an account exists for that email, a reset link has been sent.");
    } catch {
      setForgotMsg("Something went wrong. Please try again.");
    }
    setBusy(false);
  }

  if (forgotMode) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={handleForgot}>
          <h1>Reset your password</h1>
          <p>We'll send a reset link if this email has an account.</p>
          <div className="field">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          {forgotMsg && <div className="error-banner" style={{ background: "#eef2ff", color: "#3730a3", borderColor: "#c7d2fe" }}>{forgotMsg}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary" type="submit" disabled={busy}>Send reset link</button>
            <button className="btn-link" type="button" onClick={() => setForgotMode(false)}>Back to login</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>BookPilot AI</h1>
        <p>Sign in to your dashboard</p>
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <div className="error-banner">{error}</div>}
        <button className="btn-primary" type="submit" disabled={busy} style={{ width: "100%", padding: "9px 0", marginBottom: 10 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <button className="btn-link" type="button" onClick={() => setForgotMode(true)}>Forgot password?</button>
      </form>
    </div>
  );
}
