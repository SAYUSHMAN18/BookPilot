const { pool, query } = require("./db");
const { encryptSecret, decryptSecret } = require("../infra/secretsEncryption");

class DuplicateSlugError extends Error {
  constructor(slug) {
    super(`A tenant with slug "${slug}" already exists.`);
    this.code = "DUPLICATE_SLUG";
  }
}

// Never exposes the encrypted columns raw — decrypts the WhatsApp token
// (needed by callers that actually send messages) but the Groq key
// override stays available via a dedicated getter (getGroqKeyOverride)
// only, since most callers of this row never need it and shouldn't have
// it sitting in memory unnecessarily.
function rowToTenant(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    status: row.status,
    billingEmail: row.billing_email,
    branding: row.branding_json ? JSON.parse(row.branding_json) : {},
    featureFlags: row.feature_flags_json ? JSON.parse(row.feature_flags_json) : {},
    whatsappPhoneNumberId: row.whatsapp_phone_number_id,
    whatsappBusinessAccountId: row.whatsapp_business_account_id,
    whatsappAccessToken: decryptSecret(row.whatsapp_access_token_encrypted),
    createdAt: Number(row.created_at),
  };
}

const tenants = {
  async getById(id) {
    const rows = await query("SELECT * FROM tenants WHERE id = $1", [id]);
    return rowToTenant(rows[0]);
  },

  // SQLite's `COLLATE NOCASE` has no direct Postgres equivalent —
  // LOWER(x) = LOWER($1) is the standard, extension-free way to do a
  // case-insensitive exact match.
  async getBySlug(slug) {
    const rows = await query("SELECT * FROM tenants WHERE LOWER(slug) = LOWER($1)", [slug]);
    return rowToTenant(rows[0]);
  },

  // Webhook routes have no session — this is how an incoming WhatsApp
  // message gets attributed to a tenant at all (Section 8.3): Meta's
  // payload carries the receiving number's phone_number_id, matched
  // against what each tenant registered here.
  async getByPhoneNumberId(phoneNumberId) {
    if (!phoneNumberId) return undefined;
    const rows = await query("SELECT * FROM tenants WHERE whatsapp_phone_number_id = $1", [phoneNumberId]);
    return rowToTenant(rows[0]);
  },

  async list() {
    const rows = await query("SELECT * FROM tenants ORDER BY created_at DESC", []);
    return rows.map(rowToTenant);
  },

  async create({ name, slug, plan, billingEmail, branding, featureFlags }) {
    const normalizedSlug = slug.trim().toLowerCase();
    try {
      const rows = await query(
        `INSERT INTO tenants (name, slug, plan, status, billing_email, branding_json, feature_flags_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          name,
          normalizedSlug,
          plan || "free",
          "pending", // Section 8.6 — every tenant starts pending, not active
          billingEmail || null,
          branding ? JSON.stringify(branding) : null,
          featureFlags ? JSON.stringify(featureFlags) : null,
          Date.now(),
        ]
      );
      return rowToTenant(rows[0]);
    } catch (err) {
      if (err.code === "23505") {
        throw new DuplicateSlugError(normalizedSlug);
      }
      throw err;
    }
  },

  async setStatus(id, status) {
    await pool.query("UPDATE tenants SET status = $1 WHERE id = $2", [status, id]);
    return this.getById(id);
  },

  // New plan, Block 12 — until now there was no way to change a tenant's
  // plan at all after creation; every signup path hardcodes "free" and
  // nothing ever updated it. Platform-admin only, same as setStatus.
  async setPlan(id, plan) {
    await pool.query("UPDATE tenants SET plan = $1 WHERE id = $2", [plan, id]);
    return this.getById(id);
  },

  async updateConfig(id, { branding, featureFlags, groqApiKey }) {
    const existingRows = await query("SELECT * FROM tenants WHERE id = $1", [id]);
    const existing = existingRows[0];
    await pool.query(
      `UPDATE tenants SET branding_json = $1, feature_flags_json = $2, groq_api_key_encrypted = $3 WHERE id = $4`,
      [
        branding !== undefined ? JSON.stringify(branding) : existing.branding_json,
        featureFlags !== undefined ? JSON.stringify(featureFlags) : existing.feature_flags_json,
        groqApiKey !== undefined ? encryptSecret(groqApiKey) : existing.groq_api_key_encrypted,
        id,
      ]
    );
    return this.getById(id);
  },

  async setWhatsAppCredentials(id, { phoneNumberId, businessAccountId, accessToken }) {
    await pool.query(
      `UPDATE tenants SET whatsapp_phone_number_id = $1, whatsapp_business_account_id = $2, whatsapp_access_token_encrypted = $3 WHERE id = $4`,
      [phoneNumberId || null, businessAccountId || null, encryptSecret(accessToken), id]
    );
    return this.getById(id);
  },

  // Not exposed through rowToTenant()'s general shape — a Groq override is
  // only ever needed at the one call site that picks which API key to use
  // for a request, not anywhere a tenant's general info is displayed.
  async getGroqKeyOverride(id) {
    const rows = await query("SELECT * FROM tenants WHERE id = $1", [id]);
    return rows[0] ? decryptSecret(rows[0].groq_api_key_encrypted) : null;
  },
};

module.exports = tenants;
module.exports.DuplicateSlugError = DuplicateSlugError;
