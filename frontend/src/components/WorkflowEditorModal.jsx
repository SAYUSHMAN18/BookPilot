import { useEffect, useState } from "react";
import { post } from "../lib/api";

// Item 4 — the piece ManageBusinessesPanel's original read-only view
// explicitly flagged as "not yet duplicated here." Ports the classic
// dashboard's actual pattern (public/dashboard.html's #workflowModal):
// metadata fields (id/label/prefix/description) stay in sync with a raw
// JSON textarea in both directions, an optional AI-generate call
// (POST /api/dashboard/workflows/generate) can draft the JSON from a
// plain-language description, and Save POSTs the final object to
// POST /api/dashboard/workflows — the same endpoint handles both create
// and update (server.js keys off whether the id already exists).
const BLANK_TEMPLATE = {
  id: "new-business",
  label: "New Business",
  description: "A customized booking service",
  matchLabel: "our services",
  bookingIdPrefix: "NEW",
  providers: [{ id: "p1", name: "Provider 1", attribute: "Staff", fee: 100 }],
  steps: [
    { type: "select_provider", prompt: "Choose options:" },
    { type: "select_date", field: "visitDate", prompt: "Choose date:" },
  ],
};

export default function WorkflowEditorModal({ workflow, onClose, onSaved }) {
  const isEdit = !!workflow;
  const [id, setId] = useState(workflow?.id || "");
  const [label, setLabel] = useState(workflow?.label || "");
  const [prefix, setPrefix] = useState(workflow?.bookingIdPrefix || "");
  const [description, setDescription] = useState(workflow?.description || "");
  const [json, setJson] = useState(JSON.stringify(workflow || BLANK_TEMPLATE, null, 2));
  const [aiDescription, setAiDescription] = useState("");
  const [aiStatus, setAiStatus] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Metadata fields are the source of truth for these 4 keys; typing in
  // one re-stamps the JSON textarea, same two-way sync the classic
  // dashboard's updateJsonFromInputs() did — lets someone fix just the
  // label without hand-editing JSON, without fighting a full form UI for
  // the parts (steps, providers) that genuinely need raw JSON.
  function restampJson(next) {
    try {
      const obj = JSON.parse(json);
      Object.assign(obj, next);
      setJson(JSON.stringify(obj, null, 2));
    } catch {
      // JSON currently invalid (mid-edit) — don't clobber what they're typing.
    }
  }

  async function handleGenerate() {
    if (!aiDescription.trim()) {
      setAiStatus("Describe the business first.");
      return;
    }
    setAiBusy(true);
    setAiStatus("Generating…");
    try {
      const result = await post("/api/dashboard/workflows/generate", { description: aiDescription.trim() });
      const w = result.workflow;
      setId(w.id || "");
      setLabel(w.label || "");
      setPrefix(w.bookingIdPrefix || "");
      setDescription(w.description || "");
      setJson(JSON.stringify(w, null, 2));
      setAiStatus(result.validationWarning ? `Drafted, but check it over: ${result.validationWarning}` : "Drafted below — review before saving.");
    } catch (err) {
      setAiStatus(err.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function handleSave() {
    setError("");
    if (!id.trim()) return setError("Workflow / Business ID is required.");
    if (!/^[a-z0-9_-]+$/i.test(id.trim())) return setError("Workflow ID must contain only letters, numbers, dashes, and underscores.");
    if (!label.trim()) return setError("Business Label (Name) is required.");

    let workflowObj;
    try {
      workflowObj = JSON.parse(json);
    } catch (err) {
      return setError(`Invalid JSON syntax: ${err.message}`);
    }
    workflowObj.id = id.trim();
    workflowObj.label = label.trim();
    if (prefix.trim()) workflowObj.bookingIdPrefix = prefix.trim();
    if (description.trim()) workflowObj.description = description.trim();

    setSaving(true);
    try {
      await post("/api/dashboard/workflows", workflowObj);
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
          <span className="card-title">{isEdit ? `Edit Business: ${id}` : "Add Business Workflow"}</span>
          <button className="btn-link" style={{ fontSize: 20, fontWeight: "bold" }} onClick={onClose}>×</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {!isEdit && (
          <div style={{ background: "rgba(79,70,229,0.06)", border: "1px solid rgba(79,70,229,0.2)", borderRadius: "var(--radius-sm)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="form-label" style={{ margin: 0 }}>✨ Generate with AI (optional)</label>
            <textarea
              className="form-textarea" rows={2}
              placeholder='Describe the business in plain language, e.g. "A car wash and detailing shop, two bays, appointments by the hour"'
              value={aiDescription} onChange={(e) => setAiDescription(e.target.value)}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="btn-primary" type="button" disabled={aiBusy} onClick={handleGenerate}>✨ Generate</button>
              <span style={{ fontSize: 12, color: aiStatus.startsWith("Drafted, but") ? "var(--danger)" : "var(--muted)" }}>{aiStatus}</span>
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="form-group-row">
            <div>
              <label className="form-label">Workflow / Business ID</label>
              <input className="form-input" disabled={isEdit} placeholder="e.g. spa (lowercase, no spaces)" value={id} onChange={(e) => { setId(e.target.value); restampJson({ id: e.target.value.trim() }); }} />
            </div>
            <div>
              <label className="form-label">Booking ID Prefix</label>
              <input className="form-input" placeholder="e.g. SPA" value={prefix} onChange={(e) => { setPrefix(e.target.value); restampJson({ bookingIdPrefix: e.target.value.trim() }); }} />
            </div>
          </div>
          <div>
            <label className="form-label">Label (Name)</label>
            <input className="form-input" placeholder="e.g. Zen Massage & Spa" value={label} onChange={(e) => { setLabel(e.target.value); restampJson({ label: e.target.value.trim() }); }} />
          </div>
          <div>
            <label className="form-label">Description</label>
            <input className="form-input" placeholder="e.g. massage, therapy, relaxation, wellness" value={description} onChange={(e) => { setDescription(e.target.value); restampJson({ description: e.target.value.trim() }); }} />
          </div>
          <div>
            <label className="form-label">Full Workflow JSON Config</label>
            <textarea className="form-textarea" rows={12} style={{ fontFamily: "monospace", fontSize: 12 }} value={json} onChange={(e) => setJson(e.target.value)} />
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>The metadata fields above automatically update these keys on save. Use standard syntax matching existing workflows.</div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Saving…" : "Save Business"}</button>
        </div>
      </div>
    </div>
  );
}
