import { useEffect, useState } from "react";
import { get, del } from "../lib/api";
import WorkflowEditorModal from "./WorkflowEditorModal";
import MarketplacePanel from "./MarketplacePanel";

// Item 4 — was deliberately read-only ("add/edit a business's steps and
// providers from the classic dashboard for now" — see git history on this
// file). Now has real parity with public/dashboard.html's Manage
// Businesses + Marketplace sections: add/edit (with AI-generate) via
// WorkflowEditorModal, delete here, and the template publish/install flow
// via MarketplacePanel — the two features that panel's own comment named
// as the actual gap.
export default function ManageBusinessesPanel({ refreshKey, bump }) {
  const [workflows, setWorkflows] = useState({});
  const [error, setError] = useState("");
  const [editorState, setEditorState] = useState(null); // null closed, {} = add, {...workflow} = edit

  async function load() {
    try {
      setWorkflows(await get("/api/dashboard/workflows"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [refreshKey]);

  const list = Object.values(workflows);

  async function handleDelete(id) {
    if (!confirm(`Delete business "${id}"? This cannot be undone — existing bookings for it are kept, but it can no longer be booked.`)) return;
    try {
      await del(`/api/dashboard/workflows/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function handleSaved() {
    setEditorState(null);
    load();
    bump?.(); // other panels (e.g. Bookings' provider dropdown) may reference workflows too
  }

  return (
    <>
      <div className="card">
        <div className="card-header">
          <span className="card-title">🏪 Manage Businesses <span className="count-badge">{list.length}</span></span>
          <button className="btn-primary" onClick={() => setEditorState({})}>＋ Add Business</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="table-scroll">
          <table>
            <thead><tr><th>Business ID</th><th>Label</th><th>Description</th><th>Type/Providers</th><th>Actions</th></tr></thead>
            <tbody>
              {list.map((w) => (
                <tr key={w.id}>
                  <td>{w.id}</td>
                  <td>{w.label}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 320 }}>{w.description}</td>
                  <td>{(w.providers?.length || 0) + (w.hotels?.reduce((n, h) => n + (h.rooms?.length || 0), 0) || 0)}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <button className="btn-secondary" onClick={() => setEditorState(w)}>Edit</button>
                    <button className="btn-danger" onClick={() => handleDelete(w.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <MarketplacePanel workflows={workflows} refreshKey={refreshKey} onInstalled={handleSaved} />

      {editorState !== null && (
        <WorkflowEditorModal
          workflow={Object.keys(editorState).length ? editorState : null}
          existingIds={Object.keys(workflows)}
          onClose={() => setEditorState(null)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
