import { useEffect, useState } from "react";
import { get, post, del } from "../lib/api";

// Item 4 — ports the classic dashboard's "🧩 Marketplace" section
// (public/dashboard.html's #installTemplateModal + publish flow): save a
// working business as a reusable template, then install a copy of it as
// a brand-new workflow. Installing deep-copies the definition server-side
// (server.js's POST /templates/:id/install) — editing the new business
// never touches the template it came from.
export default function MarketplacePanel({ workflows, refreshKey, onInstalled }) {
  const [templates, setTemplates] = useState([]);
  const [error, setError] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [installTarget, setInstallTarget] = useState(null); // template being installed, or null

  async function load() {
    try {
      setTemplates(await get("/api/dashboard/templates"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [refreshKey]);

  async function handleDelete(id) {
    if (!confirm("Delete this template? Businesses already installed from it are unaffected.")) return;
    await del(`/api/dashboard/templates/${id}`);
    load();
  }

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-header">
        <span className="card-title">🧩 Marketplace <span className="count-badge">{templates.length}</span></span>
        <button className="btn-primary" onClick={() => setPublishOpen(true)}>＋ Publish a Business</button>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
        Save a working business as a reusable template, then install it to spin up a new one. Installing copies the config — editing the new business never touches the template.
      </div>
      {error && <div className="error-banner">{error}</div>}
      {templates.length === 0 ? (
        <div className="empty">No templates published yet.</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Template</th><th>Industry</th><th>Description</th><th>Size</th><th>Published By</th><th>Actions</th></tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.industry || "—"}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 300 }}>{t.description}</td>
                  <td>{t.stepCount} steps, {t.providerCount} provider(s)</td>
                  <td>{t.createdBy}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <button className="btn-secondary" onClick={() => setInstallTarget(t)}>Install</button>
                    <button className="btn-danger" onClick={() => handleDelete(t.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {publishOpen && (
        <PublishModal
          workflows={workflows}
          onClose={() => setPublishOpen(false)}
          onPublished={() => { setPublishOpen(false); load(); }}
        />
      )}
      {installTarget && (
        <InstallModal
          template={installTarget}
          existingIds={Object.keys(workflows)}
          onClose={() => setInstallTarget(null)}
          onInstalled={() => { setInstallTarget(null); onInstalled(); }}
        />
      )}
    </div>
  );
}

function PublishModal({ workflows, onClose, onPublished }) {
  const ids = Object.keys(workflows);
  const [workflowId, setWorkflowId] = useState(ids[0] || "");
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handlePublish() {
    setError("");
    if (!workflowId) return setError("Choose an existing business to publish from.");
    if (!name.trim()) return setError("A template name is required.");
    setBusy(true);
    try {
      await post("/api/dashboard/templates", { workflowId, name: name.trim(), industry: industry.trim(), description: description.trim() });
      onPublished();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card" style={{ maxWidth: 460 }}>
        <div className="card-header" style={{ marginBottom: 0 }}>
          <span className="card-title">Publish a Business as a Template</span>
          <button className="btn-link" style={{ fontSize: 20, fontWeight: "bold" }} onClick={onClose}>×</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div>
          <label className="form-label">Business to publish</label>
          <select className="form-select" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            {ids.map((id) => <option key={id} value={id}>{workflows[id].label} ({id})</option>)}
          </select>
        </div>
        <div>
          <label className="form-label">Template Name</label>
          <input className="form-input" placeholder="e.g. General Salon Starter" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="form-label">Industry (optional)</label>
          <input className="form-input" placeholder="e.g. Salon" value={industry} onChange={(e) => setIndustry(e.target.value)} />
        </div>
        <div>
          <label className="form-label">Description (optional)</label>
          <textarea className="form-textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy} onClick={handlePublish}>{busy ? "Publishing…" : "Publish"}</button>
        </div>
      </div>
    </div>
  );
}

// Slugify+de-dupe kept in sync with WorkflowEditorModal.jsx's own copy —
// same reasoning (auto-derive the technical ID from a plain name instead
// of making someone type a lowercase-dashes-only value by hand).
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function dedupeId(base, existingIds) {
  const safeBase = base || "business";
  if (!existingIds.includes(safeBase)) return safeBase;
  for (let n = 2; ; n++) {
    if (!existingIds.includes(`${safeBase}-${n}`)) return `${safeBase}-${n}`;
  }
}

function InstallModal({ template, existingIds, onClose, onInstalled }) {
  const [newLabel, setNewLabel] = useState(template.name || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleInstall() {
    setError("");
    if (!newLabel.trim()) return setError("A name for the new business is required.");
    setBusy(true);
    try {
      const newId = dedupeId(slugify(newLabel), existingIds);
      await post(`/api/dashboard/templates/${template.id}/install`, { newId, newLabel: newLabel.trim() });
      onInstalled();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card" style={{ maxWidth: 420 }}>
        <div className="card-header" style={{ marginBottom: 0 }}>
          <span className="card-title">Install "{template.name}"</span>
          <button className="btn-link" style={{ fontSize: 20, fontWeight: "bold" }} onClick={onClose}>×</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div>
          <label className="form-label">Name for your new business</label>
          <input className="form-input" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy} onClick={handleInstall}>{busy ? "Installing…" : "Install"}</button>
        </div>
      </div>
    </div>
  );
}
