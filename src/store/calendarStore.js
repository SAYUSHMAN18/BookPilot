const { db } = require("./db");
const { encryptSecret, decryptSecret } = require("../infra/secretsEncryption");

// Section 10 — one connection per (tenant, workflow, provider): a single
// doctor/stylist/room connects their own Google Calendar, not the whole
// tenant at once. `calendar_event_links` is the many-to-... actually
// one-to-one mapping (enforced by its own unique index on
// (booking_id, calendar_connection_id)) that lets a later sync pass know
// "this booking already has an event, update it" instead of creating a
// duplicate on every reschedule.
const insertConnectionStmt = db.prepare(`
  INSERT INTO calendar_connections (tenant_id, workflow_id, provider_id, calendar_type, refresh_token_encrypted, access_token_encrypted, access_token_expires_at, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?)
`);
const getConnectionStmt = db.prepare(
  "SELECT * FROM calendar_connections WHERE tenant_id = ? AND workflow_id = ? AND provider_id = ? AND status != 'disconnected' ORDER BY id DESC LIMIT 1"
);
const getConnectionByIdStmt = db.prepare("SELECT * FROM calendar_connections WHERE id = ? AND tenant_id = ?");
const updateTokensStmt = db.prepare(
  "UPDATE calendar_connections SET access_token_encrypted = ?, access_token_expires_at = ?, last_synced_at = ? WHERE id = ?"
);
const markStatusStmt = db.prepare("UPDATE calendar_connections SET status = ? WHERE id = ?");
const disconnectStmt = db.prepare("UPDATE calendar_connections SET status = 'disconnected' WHERE id = ? AND tenant_id = ?");

function rowToConnection(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    providerId: row.provider_id,
    calendarType: row.calendar_type,
    externalCalendarId: row.external_calendar_id,
    // Decrypted lazily by the caller (calendarSync.js), never exposed
    // to the dashboard — these two getters are the only place plaintext
    // tokens exist outside the provider API call itself.
    refreshToken: decryptSecret(row.refresh_token_encrypted),
    accessToken: decryptSecret(row.access_token_encrypted),
    accessTokenExpiresAt: row.access_token_expires_at,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}

// A public-safe view for the dashboard's connection-status panel — never
// includes the token fields, encrypted or not.
function toPublicView(connection) {
  if (!connection) return null;
  return {
    id: connection.id,
    calendarType: connection.calendarType,
    status: connection.status,
    lastSyncedAt: connection.lastSyncedAt,
    createdAt: connection.createdAt,
  };
}

const calendarConnections = {
  create(tenantId, workflowId, providerId, { calendarType, refreshToken, accessToken, accessTokenExpiresAt }) {
    const now = Date.now();
    const result = insertConnectionStmt.run(
      tenantId, workflowId, providerId, calendarType,
      encryptSecret(refreshToken), encryptSecret(accessToken), accessTokenExpiresAt || null, now
    );
    return this.getById(tenantId, result.lastInsertRowid);
  },

  // The one currently-active connection for a provider, if any — a
  // provider disconnecting and reconnecting leaves the old row as
  // 'disconnected' (an audit trail, not deleted) and this returns the
  // newest non-disconnected one.
  getForProvider(tenantId, workflowId, providerId) {
    return rowToConnection(getConnectionStmt.get(tenantId, workflowId, providerId));
  },

  getById(tenantId, id) {
    return rowToConnection(getConnectionByIdStmt.get(id, tenantId));
  },

  updateTokens(id, { accessToken, accessTokenExpiresAt }) {
    updateTokensStmt.run(encryptSecret(accessToken), accessTokenExpiresAt || null, Date.now(), id);
  },

  markNeedsReconnect(id) {
    markStatusStmt.run("needs_reconnect", id);
  },

  disconnect(tenantId, id) {
    disconnectStmt.run(id, tenantId);
  },

  toPublicView,
};

const insertLinkStmt = db.prepare(
  "INSERT OR REPLACE INTO calendar_event_links (booking_id, calendar_connection_id, external_event_id, created_at) VALUES (?, ?, ?, ?)"
);
const getLinkStmt = db.prepare("SELECT * FROM calendar_event_links WHERE booking_id = ? AND calendar_connection_id = ?");
const deleteLinkStmt = db.prepare("DELETE FROM calendar_event_links WHERE booking_id = ? AND calendar_connection_id = ?");

function rowToLink(row) {
  if (!row) return undefined;
  return { id: row.id, bookingId: row.booking_id, calendarConnectionId: row.calendar_connection_id, externalEventId: row.external_event_id, createdAt: row.created_at };
}

const calendarEventLinks = {
  upsert(bookingId, calendarConnectionId, externalEventId) {
    insertLinkStmt.run(bookingId, calendarConnectionId, externalEventId, Date.now());
  },
  get(bookingId, calendarConnectionId) {
    return rowToLink(getLinkStmt.get(bookingId, calendarConnectionId));
  },
  delete(bookingId, calendarConnectionId) {
    deleteLinkStmt.run(bookingId, calendarConnectionId);
  },
};

module.exports = { calendarConnections, calendarEventLinks };
