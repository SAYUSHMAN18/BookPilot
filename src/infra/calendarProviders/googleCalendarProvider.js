// Section 10.1 — Google Calendar (the plan's own pick, and the more
// common ask for a small clinic/salon than Outlook). Implements the
// contract documented in ./CalendarProvider.js. Uses Node's built-in
// fetch, no `googleapis` dependency — same "no heavy deps" stance as
// razorpayProvider.js's plain-fetch Razorpay integration.
//
// IMPORTANT, stated as plainly as razorpayProvider.js says it about
// itself: this implements Google's real, documented OAuth 2.0 + Calendar
// API v3 shapes correctly as far as they can be verified from
// documentation alone, but has NOT been verified live against a real
// Google account, because no Google Cloud OAuth client (CLIENT_ID/
// CLIENT_SECRET) exists for this project — creating one requires a human
// with a Google Cloud Console account to register an OAuth consent
// screen and redirect URI, which only the project owner can do. Treat
// this as "ready to test against a real Google Cloud project," not
// "proven working." src/infra/oauthState.js (pure HMAC signing, no
// external calls) and src/store/calendarStore.js are both fully tested;
// this file's HTTP calls are not, for the same reason
// razorpayProvider.js's createOrder()/createRefund() aren't.

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

function credentials() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
  };
}

function isConfigured() {
  const { clientId, clientSecret, redirectUri } = credentials();
  return !!(clientId && clientSecret && redirectUri);
}

// access_type=offline + prompt=consent is what actually gets a refresh
// token back — without both, a user who has ever authorized this app
// before only gets an access token on repeat consent, which silently
// breaks background sync the next time it expires (~1h). Verified
// against Google's own OAuth docs, not a live account.
function getAuthUrl(state) {
  const { clientId, redirectUri } = credentials();
  if (!clientId || !redirectUri) {
    throw new Error("GOOGLE_CLIENT_ID/GOOGLE_REDIRECT_URI are not set — cannot start a real Google OAuth flow.");
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret, redirectUri } = credentials();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI are not set — cannot exchange a real authorization code.");
  }
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Google token exchange failed: ${resp.status} ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  if (!data.refresh_token) {
    // Happens when the user has already granted this app consent before
    // and Google skips issuing a new refresh token — access_type=offline
    // + prompt=consent above is specifically meant to prevent this, but
    // it's a real Google-side edge case worth failing loudly on rather
    // than silently storing a connection that can never refresh itself.
    throw new Error("Google did not return a refresh_token — the account may need to revoke this app's access at https://myaccount.google.com/permissions and reconnect.");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set — cannot refresh a real access token.");
  }
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    const err = new Error(`Google token refresh failed: ${resp.status} ${errText.slice(0, 300)}`);
    // Google returns 400 {"error":"invalid_grant"} when the refresh token
    // itself has been revoked (user removed access, or it simply expired
    // from disuse) — this is the one failure mode calendarSync.js needs
    // to distinguish from a transient network/API problem, since only
    // this one means "stop retrying, ask the provider to reconnect."
    err.isInvalidGrant = /invalid_grant/i.test(errText);
    throw err;
  }
  const data = await resp.json();
  return { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
}

function toGoogleEvent({ summary, description, startIso, endIso }) {
  return {
    summary,
    description,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
  };
}

async function createEvent(accessToken, { calendarId = "primary", summary, description, startIso, endIso }) {
  const resp = await fetch(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(toGoogleEvent({ summary, description, startIso, endIso })),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Google Calendar event creation failed: ${resp.status} ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  return { externalEventId: data.id };
}

async function updateEvent(accessToken, { calendarId = "primary", externalEventId, summary, description, startIso, endIso }) {
  const resp = await fetch(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalEventId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(toGoogleEvent({ summary, description, startIso, endIso })),
  });
  // A 404 here means the event was already removed directly in Google
  // Calendar by the provider — nothing left to update, not a failure of
  // this sync attempt.
  if (!resp.ok && resp.status !== 404) {
    const errText = await resp.text();
    throw new Error(`Google Calendar event update failed: ${resp.status} ${errText.slice(0, 300)}`);
  }
}

async function deleteEvent(accessToken, { calendarId = "primary", externalEventId }) {
  const resp = await fetch(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalEventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // 404/410 both mean "already gone" — success, not an error (see
  // CalendarProvider.js's contract note on this).
  if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
    const errText = await resp.text();
    throw new Error(`Google Calendar event deletion failed: ${resp.status} ${errText.slice(0, 300)}`);
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  createEvent,
  updateEvent,
  deleteEvent,
};
