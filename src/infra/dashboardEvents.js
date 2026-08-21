const { EventEmitter } = require("events");
const { Client } = require("pg");
const { log } = require("./logger");

// Section 11 — the pub/sub backing the dashboard's live-update stream
// (server.js's GET /api/dashboard/events, Server-Sent Events).
//
// Found live (self-audit): this used to be a bare in-process EventEmitter —
// correct on Render's current single instance, but silently wrong the
// moment a second instance runs. A booking made on the instance handling
// the WhatsApp webhook would never reach a dashboard tab whose SSE
// connection happens to be held open by a DIFFERENT instance — no error,
// just a live-update feature that quietly stops updating for roughly half
// of all events, depending on which instance a given request landed on.
// Postgres LISTEN/NOTIFY is the standard fix (same "no heavy deps, reuse
// Postgres" posture as rateLimitStore.js/dedupe.js): NOTIFY broadcasts to
// every session currently LISTENing on the channel, across every process
// connected to the same database, so publish() on any instance reaches a
// subscriber on any other. The local EventEmitter (`bus`) is still exactly
// how a subscriber on THIS instance receives events — it's now fed by the
// LISTEN connection's 'notification' events instead of directly by
// publish(), so delivery is uniform (every instance, including the one
// that published, hears it the same way) rather than "local subscribers
// get it synchronously, remote ones don't get it at all."
const bus = new EventEmitter();
bus.setMaxListeners(0); // unbounded — one listener per open dashboard SSE connection, not a fixed pool

const CHANNEL = "bookpilot_dashboard_events";
// Postgres hard-caps a NOTIFY payload at 8000 bytes; this leaves headroom
// for JSON overhead so a payload right at the edge never gets silently
// truncated mid-object by the server.
const MAX_NOTIFY_PAYLOAD_BYTES = 7800;

let listenClient = null;
let connectPromise = null;
let reconnectTimer = null;

// Lazily opens one dedicated LISTEN connection per process (LISTEN is tied
// to the specific session that issued it for its whole lifetime, so this
// can't share db.js's pool of recycled connections — same reason
// isolatedDb.js's own maintenance connections in tests are always a
// separate `Client`, not a pool checkout). Memoized so concurrent callers
// (multiple SSE connections opening at once) share one connection attempt
// rather than racing to open several. Reconnects on drop so a Postgres
// restart/network blip degrades live updates temporarily instead of
// permanently for the rest of the process's life — same posture as
// db.js's own pool.on('error') handler.
function ensureListening() {
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    client.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        bus.emit("dashboard-event", JSON.parse(msg.payload));
      } catch (err) {
        log("WARN", `dashboardEvents: malformed NOTIFY payload (${err.message}).`);
      }
    });
    client.on("error", (err) => {
      log("WARN", `dashboardEvents: LISTEN connection dropped (${err.message}) — reconnecting.`);
      listenClient = null;
      connectPromise = null;
      // Tracked so _resetForTests() (or a future graceful-shutdown hook)
      // can cancel a reconnect that's already scheduled — otherwise a
      // stale timer from a connection dropped right before shutdown fires
      // afterward anyway, reconnecting to a database that may no longer
      // exist (found live in this file's own test run: exactly this,
      // retrying against an already-DROPped test database after the test
      // file itself had finished).
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        ensureListening().catch((reconnectErr) => log("ERROR", `dashboardEvents: reconnect failed (${reconnectErr.message}).`));
      }, 1000);
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    listenClient = client;
    return client;
  })();
  connectPromise.catch((err) => {
    log("ERROR", `dashboardEvents: failed to establish LISTEN connection (${err.message}) — live dashboard updates unavailable until this recovers.`);
    connectPromise = null;
  });
  return connectPromise;
}

// Resolves once this process can actually hear NOTIFYs — tests await this
// before publishing, so a publish() can't race ahead of LISTEN being
// registered (which would otherwise deliver to nobody, silently, since
// Postgres only broadcasts to sessions already listening at NOTIFY time).
// Production doesn't need to await this itself: subscribe() below kicks it
// off, and a dashboard tab connecting in the same instant live updates
// start is an accepted, pre-existing gap (the original in-memory version
// had the identical property — an SSE connection not yet open when
// publish() fires was never going to receive that specific event either).
function whenReady() {
  return ensureListening();
}

// payload should be JSON-serializable and never include a raw secret
// (token, password hash, etc.) — it's written directly into an SSE frame
// sent to a browser tab. Fire-and-forget, same posture as before: never
// throws (every failure path below is caught and logged, not propagated),
// so every existing call site keeps calling this without awaiting it.
async function publish(tenantId, type, payload) {
  const evt = { tenantId, type, payload, at: Date.now() };
  const json = JSON.stringify(evt);
  if (Buffer.byteLength(json, "utf8") > MAX_NOTIFY_PAYLOAD_BYTES) {
    // Postgres would reject this NOTIFY outright — deliver it to this
    // process's own subscribers at least (a same-instance dashboard tab
    // still gets the update), rather than losing it everywhere.
    log("WARN", `dashboardEvents: "${type}" payload too large for NOTIFY (tenant ${tenantId}) — delivering to this instance's subscribers only.`);
    bus.emit("dashboard-event", evt);
    return;
  }
  try {
    const { pool } = require("../store/db");
    await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, json]);
  } catch (err) {
    log("WARN", `dashboardEvents: publish failed (${err.message}) — a dashboard tab may miss this update.`);
  }
}

// Registers a listener for every dashboard event across all tenants; the
// caller (the SSE route) is responsible for filtering to its own
// tenantId/workflowId/providerId before forwarding to the browser — this
// module has no concept of "who's allowed to see what," same separation
// as every other store/infra module leaving authorization to server.js.
function subscribe(listener) {
  ensureListening().catch(() => {}); // already logged inside ensureListening(); don't let this reject unhandled
  bus.on("dashboard-event", listener);
  return () => bus.off("dashboard-event", listener);
}

// Test-only — closes the LISTEN connection and clears local listeners so a
// test file doesn't leak an open Postgres connection (node:test flags
// those) or leave stale listeners from a previous isolated test database.
async function _resetForTests() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // Detach the 'error' handler before ending the connection — an
  // intentional end() still fires a 'terminating connection' style error
  // on some pg versions, which would otherwise schedule yet another
  // reconnect for a connection this function is deliberately closing.
  if (listenClient) {
    listenClient.removeAllListeners("error");
    await listenClient.end().catch(() => {});
  }
  listenClient = null;
  connectPromise = null;
  bus.removeAllListeners("dashboard-event");
}

module.exports = { publish, subscribe, whenReady, _resetForTests };
