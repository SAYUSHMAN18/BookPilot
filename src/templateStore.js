const { db } = require("./db");

const insertStmt = db.prepare(
  "INSERT INTO workflow_templates (name, industry, description, definition, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
);
const deleteStmt = db.prepare("DELETE FROM workflow_templates WHERE id = ?");
const getByIdStmt = db.prepare("SELECT * FROM workflow_templates WHERE id = ?");
const listStmt = db.prepare("SELECT * FROM workflow_templates ORDER BY created_at DESC");

function rowToTemplate(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    description: row.description,
    definition: JSON.parse(row.definition),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const templates = {
  getById(id) {
    return rowToTemplate(getByIdStmt.get(id));
  },
  list() {
    return listStmt.all().map(rowToTemplate);
  },
  create({ name, industry, description, definition, createdBy }) {
    const result = insertStmt.run(
      name,
      industry ?? null,
      description ?? null,
      JSON.stringify(definition),
      createdBy ?? null,
      Date.now()
    );
    return templates.getById(result.lastInsertRowid);
  },
  remove(id) {
    deleteStmt.run(id);
  },
};

module.exports = templates;
