import { useEffect, useState } from "react";
import { get, post, del, uploadFile } from "../lib/api";

export default function KnowledgeBasePanel({ refreshKey, provider, isAdmin, workflowLabel }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [extracting, setExtracting] = useState(false);

  // Pulls text out of an uploaded PDF/DOCX/TXT and drops it straight into
  // the same title/content fields a hand-typed entry would use — nothing
  // is saved until the provider hits Save below, since PDF text
  // extraction isn't always clean (tables, columns, scanned images) and
  // this gives them a chance to fix it up first, same "draft, then
  // explicitly confirm" pattern the AI business-generator already uses.
  async function handleDocumentUpload(file) {
    if (!file) return;
    setExtracting(true);
    setError("");
    try {
      const result = await uploadFile("/api/dashboard/knowledge/extract-document", file, "document");
      setTitle((t) => t || result.title);
      setContent(result.content);
      setAdding(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setExtracting(false);
    }
  }

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
        {!isAdmin && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <label className="btn-secondary" style={{ cursor: extracting ? "not-allowed" : "pointer", opacity: extracting ? 0.6 : 1, display: "inline-flex", alignItems: "center" }}>
              {extracting ? "Reading document…" : "📄 Upload a document"}
              <input
                type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                disabled={extracting} style={{ display: "none" }}
                onChange={(e) => { handleDocumentUpload(e.target.files?.[0]); e.target.value = ""; }}
              />
            </label>
            <button className="btn-primary" onClick={() => setAdding((a) => !a)}>＋ Add Entry</button>
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        FAQs, policies, and pricing the WhatsApp bot can answer customers from. The bot only answers from what's written here plus your business config — it won't invent anything.
        {!isAdmin && " Upload a PDF, Word doc, or text file and we'll pull the text out for you to review before saving."}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {adding && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14, background: "var(--bg)", padding: 12, borderRadius: "var(--radius-sm)" }}>
          <input className="form-input" placeholder="Title (e.g. 'Do you accept insurance?')" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="form-textarea" placeholder="Content — type it yourself, or upload a document above to fill this in" rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary" onClick={save}>Save</button>
            <button className="btn-secondary" onClick={() => { setAdding(false); setTitle(""); setContent(""); }}>Cancel</button>
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
