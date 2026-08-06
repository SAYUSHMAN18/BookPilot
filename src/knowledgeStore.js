const { db } = require("./db");

const insertStmt = db.prepare(
  "INSERT INTO knowledge_documents (workflow_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
);
const updateStmt = db.prepare("UPDATE knowledge_documents SET title = ?, content = ?, updated_at = ? WHERE id = ?");
const deleteStmt = db.prepare("DELETE FROM knowledge_documents WHERE id = ?");
const getByIdStmt = db.prepare("SELECT * FROM knowledge_documents WHERE id = ?");
const listForWorkflowStmt = db.prepare("SELECT * FROM knowledge_documents WHERE workflow_id = ? ORDER BY created_at DESC");
const listAllStmt = db.prepare("SELECT * FROM knowledge_documents ORDER BY workflow_id, created_at DESC");

function rowToDoc(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    workflowId: row.workflow_id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const knowledge = {
  getById(id) {
    return rowToDoc(getByIdStmt.get(id));
  },
  listForWorkflow(workflowId) {
    return listForWorkflowStmt.all(workflowId).map(rowToDoc);
  },
  listAll() {
    return listAllStmt.all().map(rowToDoc);
  },
  create(workflowId, title, content) {
    const now = Date.now();
    const result = insertStmt.run(workflowId, title, content, now, now);
    return knowledge.getById(result.lastInsertRowid);
  },
  update(id, title, content) {
    updateStmt.run(title, content, Date.now(), id);
    return knowledge.getById(id);
  },
  remove(id) {
    deleteStmt.run(id);
  },
};

module.exports = knowledge;
