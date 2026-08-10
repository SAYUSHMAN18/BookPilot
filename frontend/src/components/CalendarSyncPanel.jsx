import { useEffect, useState } from "react";
import { get, post } from "../lib/api";
import { formatIST } from "../lib/format";

export default function CalendarSyncPanel({ provider }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!provider?.supportsAvailability) return; // same scope boundary as Availability — see calendarSync.js
    try {
      setStatus(await get(`/api/dashboard/calendar/status?workflowId=${encodeURIComponent(provider.workflowId)}&providerId=${encodeURIComponent(provider.providerId)}`));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [provider?.workflowId, provider?.providerId]);

  // The OAuth callback (server.js) redirects the top-level browser back
  // to /app?calendar=connected|error — read once on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("calendar")) return;
    if (params.get("calendar") === "error") setError(`Google Calendar connection failed: ${params.get("message") || "unknown error"}`);
    const url = new URL(window.location.href);
    url.searchParams.delete("calendar");
    url.searchParams.delete("message");
    window.history.replaceState({}, "", url.toString());
  }, []);

  if (!provider || !provider.supportsAvailability) return null;

  const connectUrl = `/api/dashboard/calendar/connect?workflowId=${encodeURIComponent(provider.workflowId)}&providerId=${encodeURIComponent(provider.providerId)}`;

  async function disconnect() {
    if (!window.confirm("Disconnect Google Calendar? New/updated bookings will stop syncing until reconnected.")) return;
    setBusy(true);
    try {
      await post("/api/dashboard/calendar/disconnect", { workflowId: provider.workflowId, providerId: provider.providerId });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">📆 Calendar Sync</span></div>
      {error && <div className="error-banner">{error}</div>}
      {!status ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</div>
      ) : !status.configured ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Google Calendar isn't set up on this server yet — ask an admin to configure it.</div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {!status.connection || status.connection.status === "disconnected" ? (
            <>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>Not connected.</span>
              <a className="btn-primary" href={connectUrl} style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none" }}>Connect Google Calendar</a>
            </>
          ) : status.connection.status === "needs_reconnect" ? (
            <>
              <span style={{ fontSize: 13 }}><b style={{ color: "var(--danger)" }}>⚠️ Needs reconnecting</b> — access was revoked or expired.</span>
              <a className="btn-primary" href={connectUrl} style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none" }}>Reconnect</a>
            </>
          ) : (
            <>
              <span style={{ fontSize: 13 }}><b style={{ color: "var(--success)" }}>✅ Connected</b> since {formatIST(status.connection.createdAt)}</span>
              <button className="btn-danger" disabled={busy} onClick={disconnect} style={{ padding: "4px 10px", fontSize: 12 }}>Disconnect</button>
            </>
          )}
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>
        Connecting syncs every confirmed booking to this provider's own Google Calendar automatically — a cancellation removes the event, a reschedule moves it. One-way only.
      </div>
    </div>
  );
}
