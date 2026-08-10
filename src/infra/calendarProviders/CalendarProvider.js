// Section 10.1 — documentation-only module, same role as
// ../paymentProviders/PaymentProvider.js: the contract every calendar
// integration must implement, so a second provider (Outlook/Microsoft
// Graph — the `calendar_connections.calendar_type` column already allows
// for it) could be added later without touching any call site in
// src/engine/calendarSync.js or server.js's dashboard routes.
//
// getAuthUrl(state) -> string
//   Builds the provider's OAuth consent-screen URL. `state` is an
//   opaque, already-signed token (src/infra/oauthState.js) the provider
//   must echo back unmodified on the callback redirect — never generated
//   or interpreted by the provider module itself.
//
// exchangeCodeForTokens(code) -> Promise<{ accessToken, refreshToken, expiresAt }>
//   Trades a one-time authorization code (from the OAuth callback) for a
//   real access/refresh token pair. Must throw on any non-2xx response —
//   never return a partial/empty token set as if it succeeded.
//
// refreshAccessToken(refreshToken) -> Promise<{ accessToken, expiresAt }>
//   Mints a new access token from a stored refresh token. Must throw a
//   recognizable error (see calendarSync.js's isInvalidGrantError) when
//   the refresh token itself has been revoked — the caller uses that to
//   flip the connection to 'needs_reconnect' rather than retrying forever.
//
// createEvent(accessToken, { calendarId, summary, description, startIso, endIso }) -> Promise<{ externalEventId }>
// updateEvent(accessToken, { calendarId, externalEventId, summary, description, startIso, endIso }) -> Promise<void>
// deleteEvent(accessToken, { calendarId, externalEventId }) -> Promise<void>
//   All async, all fail-closed (throw on error, never return
//   success-shaped garbage) — same discipline as PaymentProvider.js.
//   deleteEvent must treat "already gone" (404) as success, not an error
//   — the event may have already been removed directly in Google
//   Calendar by the provider themselves.
//
// isConfigured() -> boolean
//   Whether this provider's own OAuth client credentials are present in
//   the environment at all (distinct from whether any individual
//   business has connected their calendar).
module.exports = {};
