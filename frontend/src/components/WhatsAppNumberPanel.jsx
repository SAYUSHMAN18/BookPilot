import { useEffect, useState } from "react";
import { get, post } from "../lib/api";

// Requested directly: Starter tenants book through the shared platform
// WhatsApp number; Growth/Enterprise can connect their own instead, so
// only their business's own customers ever reach it. Unlike Calendar Sync
// (an OAuth "Connect" button), a business gets phoneNumberId/
// businessAccountId/accessToken from their own Meta Business Manager
// setup — a real external prerequisite this app can't provision for
// them — so this is a plain form for pasting those in, not a redirect.
export default function WhatsAppNumberPanel() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [accessToken, setAccessToken] = useState("");

  async function load() {
    try {
      setStatus(await get("/api/dashboard/whatsapp-number/status"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function connect() {
    setError("");
    if (!phoneNumberId.trim() || !accessToken.trim()) return setError("Phone Number ID and Access Token are required.");
    setBusy(true);
    try {
      await post("/api/dashboard/whatsapp-number/connect", {
        phoneNumberId: phoneNumberId.trim(),
        businessAccountId: businessAccountId.trim() || undefined,
        accessToken: accessToken.trim(),
      });
      setPhoneNumberId(""); setBusinessAccountId(""); setAccessToken("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect your WhatsApp number? Your business will go back to using the shared platform number.")) return;
    setBusy(true);
    try {
      await post("/api/dashboard/whatsapp-number/disconnect", {});
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">📱 Your Own WhatsApp Number</span></div>
      {error && <div className="error-banner">{error}</div>}

      {!status.eligible ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          Connecting your own WhatsApp number is a Growth-plan feature — upgrade from the{" "}
          <a href="/app/billing" style={{ color: "var(--profile)", fontWeight: 600 }}>Billing page</a> to enable this.
          Until then, your business books through BookPilot's shared platform number.
        </div>
      ) : status.connected ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>
            <b style={{ color: "var(--success)" }}>✅ Connected</b> — {status.phoneNumberId}
          </span>
          <button className="btn-danger" disabled={busy} onClick={disconnect} style={{ padding: "4px 10px", fontSize: 12 }}>Disconnect</button>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 14 }}>
            Not connected — your business currently books through BookPilot's shared platform number.
            Find these values in your Meta Business Manager's WhatsApp Cloud API setup.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label className="form-label">Phone Number ID</label>
              <input className="form-input" placeholder="e.g. 109876543210987" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} />
            </div>
            <div>
              <label className="form-label">WhatsApp Business Account ID (optional)</label>
              <input className="form-input" placeholder="e.g. 123456789012345" value={businessAccountId} onChange={(e) => setBusinessAccountId(e.target.value)} />
            </div>
            <div>
              <label className="form-label">Access Token</label>
              <input className="form-input" type="password" placeholder="A permanent System User token, not a 24h test token" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button className="btn-primary" disabled={busy} onClick={connect}>{busy ? "Connecting…" : "Connect number"}</button>
          </div>
        </>
      )}
    </div>
  );
}
