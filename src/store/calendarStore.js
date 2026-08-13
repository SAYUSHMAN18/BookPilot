const { pool, query } = require("./db");
const { encryptSecret, decryptSecret } = require("../infra/secretsEncryption");

// Section 10 — one connection per (tenant, workflow, provider): a single
// doctor/stylist/room connects their own Google Calendar, not the whole
// tenant at once. `calendar_event_links` is the many-to-... actually
// one-to-one mapping (enforced by its own unique index on
// (booking_id, calendar_connection_id)) that lets a later sync pass know
// "this booking already has an event, update it" instead of creating a
// duplicate on every reschedule.

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
    accessTokenExpiresAt: row.access_token_expires_at === null ? null : Number(row.access_token_expires_at),
    status: row.status,
    lastSyncedAt: row.last_synced_at === null ? null : Number(row.last_synced_at),
    createdAt: Number(row.created_at),
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
  async create(tenantId, workflowId, providerId, { calendarType, refreshToken, accessToken, accessTokenExpiresAt }) {
    const now = Date.now();
    const rows = await query(
      `INSERT INTO calendar_connections (tenant_id, workflow_id, provider_id, calendar_type, refresh_token_encrypted, access_token_encrypted, access_token_expires_at, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'connected', $8) RETURNING *`,
      [tenantId, workflowId, providerId, calendarType, encryptSecret(refreshToken), encryptSecret(accessToken), accessTokenExpiresAt || null, now]
    );
    return rowToConnection(rows[0]);
  },

  // The one currently-active connection for a provider, if any — a
  // provider disconnecting and reconnecting leaves the old row as
  // 'disconnected' (an audit trail, not deleted) and this returns the
  // newest non-disconnected one.
  async getForProvider(tenantId, workflowId, providerId) {
    const rows = await query(
      "SELECT * FROM calendar_connections WHERE tenant_id = $1 AND workflow_id = $2 AND provider_id = $3 AND status != 'disconnected' ORDER BY id DESC LIMIT 1",
      [tenantId, workflowId, providerId]
    );
    return rowToConnection(rows[0]);
  },

  async getById(tenantId, id) {
    const rows = await query("SELECT * FROM calendar_connections WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
    return rowToConnection(rows[0]);
  },

  async updateTokens(id, { accessToken, accessTokenExpiresAt }) {
    await pool.query(
      "UPDATE calendar_connections SET access_token_encrypted = $1, access_token_expires_at = $2, last_synced_at = $3 WHERE id = $4",
      [encryptSecret(accessToken), accessTokenExpiresAt || null, Date.now(), id]
    );
  },

  async markNeedsReconnect(id) {
    await pool.query("UPDATE calendar_connections SET status = $1 WHERE id = $2", ["needs_reconnect", id]);
  },

  async disconnect(tenantId, id) {
    await pool.query("UPDATE calendar_connections SET status = 'disconnected' WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  },

  toPublicView,
};

const calendarEventLinks = {
  // INSERT OR REPLACE (SQLite) -> INSERT ... ON CONFLICT ... DO UPDATE
  // (Postgres), targeting the same unique (booking_id, calendar_connection_id)
  // index db.js already defines.
  async upsert(bookingId, calendarConnectionId, externalEventId) {
    await pool.query(
      `INSERT INTO calendar_event_links (booking_id, calendar_connection_id, external_event_id, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (booking_id, calendar_connection_id) DO UPDATE SET external_event_id = EXCLUDED.external_event_id, created_at = EXCLUDED.created_at`,
      [bookingId, calendarConnectionId, externalEventId, Date.now()]
    );
  },
  async get(bookingId, calendarConnectionId) {
    const rows = await query("SELECT * FROM calendar_event_links WHERE booking_id = $1 AND calendar_connection_id = $2", [bookingId, calendarConnectionId]);
    const row = rows[0];
    if (!row) return undefined;
    return { id: row.id, bookingId: row.booking_id, calendarConnectionId: row.calendar_connection_id, externalEventId: row.external_event_id, createdAt: Number(row.created_at) };
  },
  async delete(bookingId, calendarConnectionId) {
    await pool.query("DELETE FROM calendar_event_links WHERE booking_id = $1 AND calendar_connection_id = $2", [bookingId, calendarConnectionId]);
  },
};

module.exports = { calendarConnections, calendarEventLinks };
