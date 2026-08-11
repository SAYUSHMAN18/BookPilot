const { db } = require("./db");
const { encryptSecret, decryptSecret } = require("../infra/secretsEncryption");

const insertStmt = db.prepare(`
  INSERT INTO tenants (name, slug, plan, status, billing_email, branding_json, feature_flags_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const getByIdStmt = db.prepare("SELECT * FROM tenants WHERE id = ?");
const getBySlugStmt = db.prepare("SELECT * FROM tenants WHERE slug = ? COLLATE NOCASE");
const getByPhoneNumberIdStmt = db.prepare("SELECT * FROM tenants WHERE whatsapp_phone_number_id = ?");
const listStmt = db.prepare("SELECT * FROM tenants ORDER BY created_at DESC");
const setStatusStmt = db.prepare("UPDATE tenants SET status = ? WHERE id = ?");
const setPlanStmt = db.prepare("UPDATE tenants SET plan = ? WHERE id = ?");
const updateConfigStmt = db.prepare(`
  UPDATE tenants
  SET branding_json = ?, feature_flags_json = ?, groq_api_key_encrypted = ?
  WHERE id = ?
`);
const setWhatsAppCredsStmt = db.prepare(`
  UPDATE tenants
  SET whatsapp_phone_number_id = ?, whatsapp_business_account_id = ?, whatsapp_access_token_encrypted = ?
  WHERE id = ?
`);

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
    createdAt: row.created_at,
  };
}

const tenants = {
  getById(id) {
    return rowToTenant(getByIdStmt.get(id));
  },

  getBySlug(slug) {
    return rowToTenant(getBySlugStmt.get(slug));
  },

  // Webhook routes have no session — this is how an incoming WhatsApp
  // message gets attributed to a tenant at all (Section 8.3): Meta's
  // payload carries the receiving number's phone_number_id, matched
  // against what each tenant registered here.
  getByPhoneNumberId(phoneNumberId) {
    if (!phoneNumberId) return undefined;
    return rowToTenant(getByPhoneNumberIdStmt.get(phoneNumberId));
  },

  list() {
    return listStmt.all().map(rowToTenant);
  },

  create({ name, slug, plan, billingEmail, branding, featureFlags }) {
    const normalizedSlug = slug.trim().toLowerCase();
    try {
      const result = insertStmt.run(
        name,
        normalizedSlug,
        plan || "free",
        "pending", // Section 8.6 — every tenant starts pending, not active
        billingEmail || null,
        branding ? JSON.stringify(branding) : null,
        featureFlags ? JSON.stringify(featureFlags) : null,
        Date.now()
      );
      return this.getById(result.lastInsertRowid);
    } catch (err) {
      if (String(err.message).includes("UNIQUE constraint failed")) {
        throw new DuplicateSlugError(normalizedSlug);
      }
      throw err;
    }
  },

  setStatus(id, status) {
    setStatusStmt.run(status, id);
    return this.getById(id);
  },

  // New plan, Block 12 — until now there was no way to change a tenant's
  // plan at all after creation; every signup path hardcodes "free" and
  // nothing ever updated it. Platform-admin only, same as setStatus.
  setPlan(id, plan) {
    setPlanStmt.run(plan, id);
    return this.getById(id);
  },

  updateConfig(id, { branding, featureFlags, groqApiKey }) {
    const existing = getByIdStmt.get(id);
    updateConfigStmt.run(
      branding !== undefined ? JSON.stringify(branding) : existing.branding_json,
      featureFlags !== undefined ? JSON.stringify(featureFlags) : existing.feature_flags_json,
      groqApiKey !== undefined ? encryptSecret(groqApiKey) : existing.groq_api_key_encrypted,
      id
    );
    return this.getById(id);
  },

  setWhatsAppCredentials(id, { phoneNumberId, businessAccountId, accessToken }) {
    setWhatsAppCredsStmt.run(phoneNumberId || null, businessAccountId || null, encryptSecret(accessToken), id);
    return this.getById(id);
  },

  // Not exposed through rowToTenant()'s general shape — a Groq override is
  // only ever needed at the one call site that picks which API key to use
  // for a request, not anywhere a tenant's general info is displayed.
  getGroqKeyOverride(id) {
    const row = getByIdStmt.get(id);
    return row ? decryptSecret(row.groq_api_key_encrypted) : null;
  },
};

module.exports = tenants;
module.exports.DuplicateSlugError = DuplicateSlugError;
