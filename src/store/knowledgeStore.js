const { db } = require("./db");

// Section 8 — every query filters by tenant_id; getById/update/remove
// filter by (id, tenant_id) together so a provider from one tenant can
// never read, edit, or delete another tenant's knowledge-base entry just
// by guessing a numeric id.
const insertStmt = db.prepare(
  "INSERT INTO knowledge_documents (tenant_id, workflow_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
);
const updateStmt = db.prepare("UPDATE knowledge_documents SET title = ?, content = ?, updated_at = ? WHERE id = ? AND tenant_id = ?");
const deleteStmt = db.prepare("DELETE FROM knowledge_documents WHERE id = ? AND tenant_id = ?");
const getByIdStmt = db.prepare("SELECT * FROM knowledge_documents WHERE id = ? AND tenant_id = ?");
const listForWorkflowStmt = db.prepare("SELECT * FROM knowledge_documents WHERE tenant_id = ? AND workflow_id = ? ORDER BY created_at DESC");
const listAllStmt = db.prepare("SELECT * FROM knowledge_documents WHERE tenant_id = ? ORDER BY workflow_id, created_at DESC");

function rowToDoc(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const knowledge = {
  getById(tenantId, id) {
    return rowToDoc(getByIdStmt.get(id, tenantId));
  },
  listForWorkflow(tenantId, workflowId) {
    return listForWorkflowStmt.all(tenantId, workflowId).map(rowToDoc);
  },
  listAll(tenantId) {
    return listAllStmt.all(tenantId).map(rowToDoc);
  },
  create(tenantId, workflowId, title, content) {
    const now = Date.now();
    const result = insertStmt.run(tenantId, workflowId, title, content, now, now);
    return knowledge.getById(tenantId, result.lastInsertRowid);
  },
  update(tenantId, id, title, content) {
    updateStmt.run(title, content, Date.now(), id, tenantId);
    return knowledge.getById(tenantId, id);
  },
  remove(tenantId, id) {
    deleteStmt.run(id, tenantId);
  },
};

module.exports = knowledge;
