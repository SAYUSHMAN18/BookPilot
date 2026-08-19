import { useState } from "react";
import { post, uploadFile } from "../lib/api";
import NumberStepperInput from "./NumberStepperInput";

// Requested directly: adding a provider to an existing business used to
// mean opening the full WorkflowEditorModal (AI-generate box, id/prefix
// fields, raw JSON, the works) just to add one person. This is the
// single-purpose version — name, fee, and the same optional photo/address
// details WorkflowEditorModal's provider card offers — that PATCHes just
// the providers[] array of one already-existing business. Only handles
// providers[]-shaped businesses (not hotels[]'s nested rooms — same scope
// line WorkflowEditorModal itself already draws).
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function dedupeId(base, existingIds) {
  const safeBase = base || "provider";
  if (!existingIds.includes(safeBase)) return safeBase;
  for (let n = 2; ; n++) {
    if (!existingIds.includes(`${safeBase}-${n}`)) return `${safeBase}-${n}`;
  }
}

export default function AddProviderModal({ workflow, onClose, onSaved }) {
  const [name, setName] = useState("");
  const [attribute, setAttribute] = useState("");
  const [fee, setFee] = useState(0);
  const [photo, setPhoto] = useState("");
  const [address, setAddress] = useState("");
  const [uploading, setUploading] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handlePhotoUpload(file) {
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await uploadFile("/api/dashboard/upload-image", file);
      setPhoto(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    setError("");
    if (!name.trim()) return setError("Provider name is required.");
    const existingIds = (workflow.providers || []).map((p) => p.id);
    const newProvider = {
      id: dedupeId(slugify(name), existingIds),
      name: name.trim(),
      attribute: attribute.trim(),
      fee: Number(fee) || 0,
      ...(photo.trim() ? { photo: photo.trim() } : {}),
      ...(address.trim() ? { address: address.trim(), mapQuery: address.trim() } : {}),
    };
    setSaving(true);
    try {
      await post("/api/dashboard/workflows", { ...workflow, providers: [...(workflow.providers || []), newProvider] });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <div className="card-header" style={{ marginBottom: 0 }}>
          <span className="card-title">＋ Add Provider to {workflow.label}</span>
          <button className="btn-link" style={{ fontSize: 20, fontWeight: "bold" }} onClick={onClose}>×</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
          <div>
            <label className="form-label">Name</label>
            <input className="form-input" placeholder="e.g. Dr. Meera Iyer" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="form-label">Role / specialty (shown next to their name)</label>
            <input className="form-input" placeholder="e.g. Dentist · Downtown Dental" value={attribute} onChange={(e) => setAttribute(e.target.value)} />
          </div>
          <div>
            <label className="form-label">Fee (₹)</label>
            <NumberStepperInput prefix="₹" step={50} min={0} value={fee} onChange={(next) => setFee(next === "" ? "" : next)} />
          </div>

          <button
            type="button"
            className={"details-toggle" + (detailsOpen ? " open" : "")}
            onClick={() => setDetailsOpen((o) => !o)}
          >
            <span className="details-toggle-arrow">▸</span>
            {detailsOpen ? "Hide photo & address" : "+ Add photo & address (optional)"}
          </button>

          {detailsOpen && (
            <div className="details-panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <label className="form-label">Photo</label>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <input
                    type="file" accept="image/jpeg,image/png,image/webp,image/gif"
                    disabled={uploading}
                    onChange={(e) => { handlePhotoUpload(e.target.files?.[0]); e.target.value = ""; }}
                  />
                  {uploading && <span style={{ fontSize: 12, color: "var(--muted)" }}>Uploading…</span>}
                </div>
                <input
                  className="form-input" style={{ marginTop: 6 }}
                  placeholder="…or paste an image URL"
                  value={photo} onChange={(e) => setPhoto(e.target.value)}
                />
              </div>
              <div>
                <label className="form-label">Address</label>
                <input className="form-input" placeholder="e.g. Sector 62, Noida" value={address} onChange={(e) => setAddress(e.target.value)} />
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Adding…" : "Add Provider"}</button>
        </div>
      </div>
    </div>
  );
}
