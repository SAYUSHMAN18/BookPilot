import { useEffect, useState } from "react";
import { get, post, del } from "../lib/api";

export default function KnowledgeBasePanel({ refreshKey, provider, isAdmin, workflowLabel }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  async function load() {
    try {
      const qs = !isAdmin && provider ? `?workflowId=${encodeURIComponent(provider.workflowId)}` : "";
      setRows(await get(`/api/dashboard/knowledge${qs}`));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [refreshKey, provider?.workflowId, isAdmin]);

  async function save() {
    if (!title.trim() || !content.trim()) return setError("Title and content are both required.");
    setError("");
    try {
      await post("/api/dashboard/knowledge", { title: title.trim(), content: content.trim(), workflowId: provider?.workflowId });
      setTitle(""); setContent(""); setAdding(false);
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">📚 Knowledge Base</span>
        <span className="count-badge">{rows.length}</span>
        {!isAdmin && <button className="btn-primary" onClick={() => setAdding((a) => !a)} style={{ marginLeft: "auto" }}>＋ Add Entry</button>}
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        FAQs, policies, and pricing the WhatsApp bot can answer customers from. The bot only answers from what's written here plus your business config — it won't invent anything.
      </div>
      {error && <div className="error-banner">{error}</div>}
      {adding && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14, background: "var(--bg)", padding: 12, borderRadius: "var(--radius-sm)" }}>
          <input placeholder="Title (e.g. 'Do you accept insurance?')" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea placeholder="Content" rows={3} value={content} onChange={(e) => setContent(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary" onClick={save}>Save</button>
            <button className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {rows.length === 0 ? <div className="empty">No knowledge base entries yet.</div> : (
        <div className="table-scroll">
          <table>
            <thead><tr>{isAdmin && <th>Business</th>}<th>Title</th><th>Content</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id}>
                  {isAdmin && <td>{workflowLabel ? workflowLabel(k.workflowId) : k.workflowId}</td>}
                  <td>{k.title}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 360 }}>{k.content}</td>
                  <td><button className="btn-danger" style={{ padding: "3px 8px", fontSize: 12 }} onClick={async () => { if (window.confirm("Delete this entry?")) { await del(`/api/dashboard/knowledge/${k.id}`); load(); } }}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
