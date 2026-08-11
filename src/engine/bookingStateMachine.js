// Item 6 — a real, live-caught bug pattern, twice already: an action that
// changes a booking's status only excluded the ONE terminal status it was
// written to guard against, not every terminal one. "cancel" originally
// only excluded "cancelled" itself (a done/no_show booking could be
// silently un-completed back to cancelled, even triggering a refund for
// service already rendered — see server.js's cancel-action comment for the
// full story). "reschedule" had the exact same bug shape (a done booking
// could be silently un-completed back to "booked" with a new date/time).
// Both were found and fixed independently, by hand, in server.js — twice
// writing the same fix because there was no single place that knew what
// "terminal" meant. This module is that single place, so a THIRD call
// site (src/engine/workflowEngine.js's handleHereCommand, which had NO
// guard at all — see its own comment) doesn't have to rediscover the bug
// a third time, and no future one does either.
//
// Deliberately not a full transition graph (payment_pending -> serving
// directly, re-clicking "serve" on an already-serving booking, etc. all
// stay exactly as permissive as they are today) — this only formalizes
// the one rule that's already been proven, twice, to matter: once a
// booking reaches a terminal state, nothing should move it out of one.
// Widening this into a strict full graph is real, separate design work
// (deciding which of today's loosely-permitted edge transitions are
// intentional vs. accidental), not something to bundle into fixing an
// already-evidenced bug class.
const TERMINAL_STATUSES = new Set(["done", "cancelled", "no_show"]);

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

module.exports = { TERMINAL_STATUSES, isTerminal };
