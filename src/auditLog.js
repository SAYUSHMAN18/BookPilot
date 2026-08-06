const { db } = require("./db");

const insertStmt = db.prepare(`
  INSERT INTO audit_log (actor_email, actor_role, action, detail, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const listStmt = db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?");

function rowToEntry(row) {
  return {
    id: row.id,
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    action: row.action,
    detail: row.detail ? JSON.parse(row.detail) : null,
    createdAt: row.created_at,
  };
}

function recordAudit(actor, action, detail) {
  insertStmt.run(actor.email, actor.role, action, detail ? JSON.stringify(detail) : null, Date.now());
}

function listAudit(limit = 200) {
  return listStmt.all(limit).map(rowToEntry);
}

module.exports = { recordAudit, listAudit };
