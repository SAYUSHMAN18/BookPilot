import { useEffect, useState } from "react";
import { get, del } from "../lib/api";
import WorkflowEditorModal from "./WorkflowEditorModal";
import AddProviderModal from "./AddProviderModal";
import AddRoomModal from "./AddRoomModal";
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
  // Separate from editorState — adding a provider to an already-existing
  // business is common enough (per direct feedback) that it shouldn't
  // require opening the full add/edit-business modal just to add one
  // person. Only offered for providers[]-shaped businesses; hotels[]'s
  // nested rooms are a different shape WorkflowEditorModal itself doesn't
  // have a structured editor for either — Edit -> raw JSON still covers it.
  const [addProviderTarget, setAddProviderTarget] = useState(null);
  // hotels[]-shaped businesses have their own nested rooms[] per hotel
  // location — a different shape from providers[] that AddProviderModal
  // doesn't handle (see its own comment). Found live: this meant a hotel
  // business had NO quick-add at all, only "Edit" -> raw JSON, while every
  // other business type got a one-click "+ Add Provider".
  const [addRoomTarget, setAddRoomTarget] = useState(null);
  // Found live: shown open by default, this competed for attention with
  // the actual "Add Business" button right above it and its own
  // "＋ Publish a Business"-style button read as a second, confusing way
  // to add a business — most tenants never touch it (starts at 0
  // templates and stays there). Collapsed by default, one explicit click
  // away, so the primary Add Business flow is the only thing anyone sees
  // unless they deliberately go looking for template reuse.
  const [templatesOpen, setTemplatesOpen] = useState(false);

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
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 14, marginTop: -8 }}>
          Add any kind of business here — restaurant, gym, clinic, whatever you run. You're never limited to what's already listed below.
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="table-scroll">
          <table>
            <thead><tr><th>Business</th><th>Description</th><th>Providers</th><th>Actions</th></tr></thead>
            <tbody>
              {list.map((w) => {
                const isHotel = !!w.hotels?.length;
                const count = (w.providers?.length || 0) + (w.hotels?.reduce((n, h) => n + (h.rooms?.length || 0), 0) || 0);
                return (
                  <tr key={w.id}>
                    <td>
                      <div className="business-row-id">
                        <span className="business-row-icon">{isHotel ? "🏨" : "🏢"}</span>
                        <div>
                          <div className="business-row-label">{w.label}</div>
                          <div className="business-row-slug">{w.id}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ whiteSpace: "normal", maxWidth: 320, color: "var(--muted)" }}>{w.description}</td>
                    <td><span className="count-badge">{count}</span></td>
                    <td>
                      <div className="business-row-actions">
                        {w.providers && (
                          <button className="btn-secondary" onClick={() => setAddProviderTarget(w)}>＋ Provider</button>
                        )}
                        {isHotel && (
                          <button className="btn-secondary" onClick={() => setAddRoomTarget(w)}>＋ Room</button>
                        )}
                        <button className="btn-secondary" onClick={() => setEditorState(w)}>Edit</button>
                        <button className="btn-danger" onClick={() => handleDelete(w.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <button
          type="button"
          className={"details-toggle" + (templatesOpen ? " open" : "")}
          onClick={() => setTemplatesOpen((o) => !o)}
        >
          <span className="details-toggle-arrow">▸</span>
          {templatesOpen ? "Hide reusable templates" : "Advanced: reuse a business as a template for new ones"}
        </button>
      </div>
      {templatesOpen && <MarketplacePanel workflows={workflows} refreshKey={refreshKey} onInstalled={handleSaved} />}

      {editorState !== null && (
        <WorkflowEditorModal
          workflow={Object.keys(editorState).length ? editorState : null}
          existingIds={Object.keys(workflows)}
          existingBusinesses={list.map((w) => w.label)}
          onClose={() => setEditorState(null)}
          onSaved={handleSaved}
        />
      )}

      {addProviderTarget && (
        <AddProviderModal
          workflow={addProviderTarget}
          onClose={() => setAddProviderTarget(null)}
          onSaved={() => { setAddProviderTarget(null); load(); bump?.(); }}
        />
      )}

      {addRoomTarget && (
        <AddRoomModal
          workflow={addRoomTarget}
          onClose={() => setAddRoomTarget(null)}
          onSaved={() => { setAddRoomTarget(null); load(); bump?.(); }}
        />
      )}
    </>
  );
}
