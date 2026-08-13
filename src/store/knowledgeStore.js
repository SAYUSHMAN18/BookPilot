const { pool, query } = require("./db");

// Section 8 — every query filters by tenant_id; getById/update/remove
// filter by (id, tenant_id) together so a provider from one tenant can
// never read, edit, or delete another tenant's knowledge-base entry just
// by guessing a numeric id.

function rowToDoc(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    title: row.title,
    content: row.content,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const knowledge = {
  async getById(tenantId, id) {
    const rows = await query("SELECT * FROM knowledge_documents WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
    return rowToDoc(rows[0]);
  },
  async listForWorkflow(tenantId, workflowId) {
    const rows = await query("SELECT * FROM knowledge_documents WHERE tenant_id = $1 AND workflow_id = $2 ORDER BY created_at DESC", [tenantId, workflowId]);
    return rows.map(rowToDoc);
  },
  async listAll(tenantId) {
    const rows = await query("SELECT * FROM knowledge_documents WHERE tenant_id = $1 ORDER BY workflow_id, created_at DESC", [tenantId]);
    return rows.map(rowToDoc);
  },
  async create(tenantId, workflowId, title, content) {
    const now = Date.now();
    const rows = await query(
      "INSERT INTO knowledge_documents (tenant_id, workflow_id, title, content, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [tenantId, workflowId, title, content, now, now]
    );
    return rowToDoc(rows[0]);
  },
  async update(tenantId, id, title, content) {
    await pool.query("UPDATE knowledge_documents SET title = $1, content = $2, updated_at = $3 WHERE id = $4 AND tenant_id = $5", [title, content, Date.now(), id, tenantId]);
    return knowledge.getById(tenantId, id);
  },
  async remove(tenantId, id) {
    await pool.query("DELETE FROM knowledge_documents WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  },
};

module.exports = knowledge;
