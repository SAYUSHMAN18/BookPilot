import { useState } from "react";
import { useAuth } from "../lib/AuthContext";
import { api } from "../lib/api";
import { IconMessage, IconCalendar, IconBell, IconGrid } from "../components/Icons";

const SHOWCASE_FEATURES = [
  { Icon: IconMessage, text: "Customers book by just chatting on WhatsApp" },
  { Icon: IconCalendar, text: "Live calendar sync — no double-bookings, ever" },
  { Icon: IconBell, text: "Automatic reminders that actually cut no-shows" },
  { Icon: IconGrid, text: "One dashboard for every business you run" },
];

function LoginShowcase() {
  return (
    <div className="login-showcase">
      <span className="showcase-eyebrow">✨ AI-powered booking, on WhatsApp</span>
      <h2 className="showcase-headline">Never miss a booking again.</h2>
      <p className="showcase-sub">
        BookPilot AI turns your WhatsApp number into a 24/7 booking assistant —
        real conversations, real slots, zero missed customers.
      </p>
      <div className="showcase-features">
        {SHOWCASE_FEATURES.map(({ Icon, text }) => (
          <div className="showcase-feature" key={text}>
            <span className="showcase-feature-icon"><Icon /></span>
            {text}
          </div>
        ))}
      </div>
      <div className="chat-mock">
        <div className="chat-mock-header">
          <span className="chat-mock-avatar" />
          <div>
            <div className="chat-mock-name">Zen Massage &amp; Spa</div>
            <div className="chat-mock-status">● online</div>
          </div>
        </div>
        <div className="chat-bubble in">Hi! Do you have anything free tomorrow evening?</div>
        <div className="chat-bubble out">Yes — 6:30 PM with Asha is open. Want me to book it?</div>
        <div className="chat-bubble in">Yes please 🙏</div>
        <div className="chat-bubble out">✅ Booked! I'll remind you an hour before.</div>
      </div>
    </div>
  );
}

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
        <LoginShowcase />
        <div className="login-card-wrap">
          <form className="login-card" onSubmit={handleForgot}>
            <h1>Reset your password</h1>
            <p>We'll send a reset link if this email has an account.</p>
            <div className="field">
              <label htmlFor="forgot-email">Email</label>
              <input id="forgot-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            {forgotMsg && <div className="error-banner" style={{ background: "#eef2ff", color: "#3730a3", borderColor: "#c7d2fe" }}>{forgotMsg}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-primary" type="submit" disabled={busy}>Send reset link</button>
              <button className="btn-link" type="button" onClick={() => setForgotMode(false)}>Back to login</button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <LoginShowcase />
      <div className="login-card-wrap">
        <form className="login-card" onSubmit={handleSubmit}>
          <h1>BookPilot AI</h1>
          <p>Sign in to your dashboard</p>
          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="error-banner">{error}</div>}
          <button className="btn-primary" type="submit" disabled={busy} style={{ width: "100%", padding: "9px 0", marginBottom: 10 }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <button className="btn-link" type="button" onClick={() => setForgotMode(true)}>Forgot password?</button>
        </form>
      </div>
    </div>
  );
}
