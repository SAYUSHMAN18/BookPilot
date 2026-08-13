const { pool, query } = require("./db");

function rowToTemplate(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    description: row.description,
    definition: JSON.parse(row.definition),
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
  };
}

const templates = {
  async getById(id) {
    const rows = await query("SELECT * FROM workflow_templates WHERE id = $1", [id]);
    return rowToTemplate(rows[0]);
  },
  async list() {
    const rows = await query("SELECT * FROM workflow_templates ORDER BY created_at DESC", []);
    return rows.map(rowToTemplate);
  },
  async create({ name, industry, description, definition, createdBy }) {
    const rows = await query(
      "INSERT INTO workflow_templates (name, industry, description, definition, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [name, industry ?? null, description ?? null, JSON.stringify(definition), createdBy ?? null, Date.now()]
    );
    return rowToTemplate(rows[0]);
  },
  async remove(id) {
    await pool.query("DELETE FROM workflow_templates WHERE id = $1", [id]);
  },
};

module.exports = templates;
