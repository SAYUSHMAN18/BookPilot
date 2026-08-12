import { useState } from "react";
import { post, uploadFile } from "../lib/api";
import LocationPickerMap from "./LocationPickerMap";

// Item 4 — the piece ManageBusinessesPanel's original read-only view
// explicitly flagged as "not yet duplicated here." Ports the classic
// dashboard's actual pattern (public/dashboard.html's #workflowModal):
// metadata fields (id/label/prefix/description) stay in sync with a raw
// JSON textarea in both directions, an optional AI-generate call
// (POST /api/dashboard/workflows/generate) can draft the JSON from a
// plain-language description, and Save POSTs the final object to
// POST /api/dashboard/workflows — the same endpoint handles both create
// and update (server.js keys off whether the id already exists).
// Found live: the old 2-step version of this (select_provider, select_date,
// nothing else) let someone save a business that LOOKED complete in this
// form but produced a broken conversation — the booking auto-finalizes the
// instant the last defined step is answered (there's no review_confirm
// step to pause on), with no name ever collected and no
// confirmationTemplate to send, so the customer got total silence right
// after picking a date. This is now a genuinely complete, working flow out
// of the box: provider -> date -> time -> name -> review & confirm, with a
// real confirmationTemplate — someone can fill in just the structured
// fields above (name/fee/photo/location per provider) and save, without
// ever opening the JSON textarea, and get a working bot.
const BLANK_TEMPLATE = {
  id: "new-business",
  label: "New Business",
  description: "A customized booking service",
  matchLabel: "our services",
  bookingIdPrefix: "NEW",
  providers: [{ id: "p1", name: "Provider 1", attribute: "Staff", fee: 100 }],
  steps: [
    { type: "select_provider", prompt: "Please choose who you'd like to see:" },
    { type: "select_date", field: "visitDate", prompt: "Please select your preferred date." },
    { type: "select_time_slot", field: "visitTime", dateField: "visitDate", prompt: "Please choose a time slot." },
    { type: "text_input", field: "customerName", prompt: "What's your name?", validate: "required", editTarget: true },
    {
      type: "review_confirm",
      prompt: "Please review your booking.",
      template: "With: {provider.name}\nDate: {visitDateLabel}\nTime: {visitTime}\nFor: {customerName}\nFee: ₹{provider.fee}",
    },
  ],
  confirmationTemplate:
    "✅ Booking confirmed!\n\nID: {bookingId}\nWith: {provider.name}\nDate: {visitDateLabel}\nTime: {visitTime}\nFor: {customerName}\nFee: ₹{provider.fee}\nBooking Code: {bookingCode}\n\nReply STATUS anytime to check your booking.",
};

// A provider's map pin is stored in the SAME `mapQuery` field the existing
// confirmationTemplate already reads (`{provider.mapQuery}`, rendered into
// a Google Maps link once a booking is confirmed) — Maps accepts a raw
// "lat,lng" string just as well as an address search string, so the map
// picker below can write directly into it without any backend/template
// change. This just recovers a pin's lat/lng back out of that same string
// for re-editing; anything that isn't in "lat,lng" form (e.g. an
// address-search mapQuery on an existing provider) simply shows no pin yet.
function parseLatLngFromMapQuery(mapQuery) {
  const m = typeof mapQuery === "string" && mapQuery.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  return m ? { lat: parseFloat(m[1]), lng: parseFloat(m[2]) } : null;
}

// The manual alternative to clicking the map: typing raw "lat,lng"
// coordinates directly, or pasting a Google Maps link that has them
// embedded (either a "/@lat,lng,15z" view URL or a "?q=lat,lng" /
// "&query=lat,lng" search URL). Anything else — a plain address, or a
// shortened maps.app.goo.gl link with no coordinates in the URL itself —
// is passed through unchanged: mapQuery already accepts a free-text
// address query just as well as coordinates (see the confirmationTemplate
// comment above), it just won't show a pin on the map until re-entered as
// coordinates.
function normalizeLocationInput(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed.replace(/\s+/g, "");
  const coordMatch = trimmed.match(/[@=](-?\d+\.\d+),(-?\d+\.\d+)/);
  if (coordMatch) return `${coordMatch[1]},${coordMatch[2]}`;
  return trimmed;
}

// The old form made someone type a technical, URL-safe "Workflow ID"
// (lowercase-dashes-only) and a "Booking ID Prefix" by hand before they
// could even get to the parts that actually matter (name, providers,
// photo, location) — real friction for a non-technical business owner.
// Both are now auto-derived from the Label instead, same slugify-and-
// de-duplicate pattern POST /api/signup already uses for a tenant's own
// slug, and only need manual attention (via the Advanced section below)
// for the rare case someone actually wants a specific one.
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
function derivePrefix(label) {
  return slugify(label).replace(/-/g, "").slice(0, 4).toUpperCase() || "BIZ";
}

export default function WorkflowEditorModal({ workflow, existingIds = [], onClose, onSaved }) {
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
  const [openMapIndex, setOpenMapIndex] = useState(null);
  const [uploadingIndex, setUploadingIndex] = useState(null);
  const [uploadErrors, setUploadErrors] = useState({});
  const [mapsLinkInputs, setMapsLinkInputs] = useState({});
  const [mapsLinkStatus, setMapsLinkStatus] = useState({});
  const [resolvingIndex, setResolvingIndex] = useState(null);
  // Advanced (ID/prefix/raw JSON) starts collapsed for a new business —
  // the common case never needs it — but open for an existing one, since
  // anyone reaching for raw JSON editing on a business that already works
  // is already in "I know what I'm doing" mode.
  const [advancedOpen, setAdvancedOpen] = useState(isEdit);
  // Once someone types into the ID or Prefix field directly (only reachable
  // via Advanced), stop overwriting it as they keep typing the Label —
  // otherwise a deliberate manual choice would keep getting clobbered.
  const [idTouched, setIdTouched] = useState(isEdit);
  const [prefixTouched, setPrefixTouched] = useState(isEdit);

  function handleLabelChange(value) {
    setLabel(value);
    restampJson({ label: value.trim() });
    if (!idTouched) {
      const nextId = dedupeId(slugify(value), existingIds);
      setId(nextId);
      restampJson({ id: nextId });
    }
    if (!prefixTouched) {
      const nextPrefix = derivePrefix(value);
      setPrefix(nextPrefix);
      restampJson({ bookingIdPrefix: nextPrefix });
    }
  }

  // Structured editor for providers[] — name/fee/image/location, synced
  // into the same JSON textarea the id/label/description fields already
  // restamp. Only handles providers[] (not hotels[]'s nested rooms — that
  // shape is different enough it's left to the raw JSON editor, same as
  // before this change). Reads providers fresh from the current JSON on
  // every call rather than keeping separate state, so hand-edits to the
  // textarea and structured-field edits never fight each other.
  let providers = null;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed.providers)) providers = parsed.providers;
  } catch {
    // JSON currently invalid — providers editor just hides until it's valid again.
  }

  function updateProviders(nextProviders) {
    try {
      const obj = JSON.parse(json);
      obj.providers = nextProviders;
      setJson(JSON.stringify(obj, null, 2));
    } catch {
      // Shouldn't happen (providers is only editable when JSON already parsed OK above).
    }
  }

  function updateProvider(index, patch) {
    updateProviders(providers.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function addProvider() {
    const nextId = `p${(providers?.length || 0) + 1}`;
    updateProviders([...(providers || []), { id: nextId, name: "New Provider", attribute: "Staff", fee: 0 }]);
  }

  function removeProvider(index) {
    if (!confirm("Remove this provider from the business?")) return;
    updateProviders(providers.filter((_, i) => i !== index));
    if (openMapIndex === index) setOpenMapIndex(null);
  }

  // Device-upload alternative to typing a photo URL: uploads the file to
  // POST /api/dashboard/upload-image, then writes the URL it returns into
  // the SAME p.photo field the URL text input below already writes to —
  // there's no separate "uploaded vs. linked" concept, just one field.
  async function handlePhotoUpload(index, file) {
    if (!file) return;
    setUploadingIndex(index);
    setUploadErrors((prev) => ({ ...prev, [index]: "" }));
    try {
      const { url } = await uploadFile("/api/dashboard/upload-image", file);
      updateProvider(index, { photo: url });
    } catch (err) {
      setUploadErrors((prev) => ({ ...prev, [index]: err.message }));
    } finally {
      setUploadingIndex(null);
    }
  }

  // A Google Maps / share.google link reliably yields a business NAME
  // (verified live against real share.google links — they redirect to a
  // Google Search results page carrying the place name in its own `q=`
  // param) but NOT a photo or exact coordinates — that page is entirely
  // JS-rendered, nothing else is present in what a server can fetch. So
  // this only ever auto-fills the name; photo/location stay exactly the
  // manual upload-or-URL / map-pin-or-coordinates fields already above.
  async function handleResolveMapsLink(index) {
    const url = (mapsLinkInputs[index] || "").trim();
    if (!url) return;
    setResolvingIndex(index);
    setMapsLinkStatus((prev) => ({ ...prev, [index]: "" }));
    try {
      const { name, coordinates } = await post("/api/dashboard/resolve-maps-link", { url });
      const patch = {};
      if (name) patch.name = name;
      if (coordinates) patch.mapQuery = coordinates;
      if (Object.keys(patch).length) updateProvider(index, patch);
      setMapsLinkStatus((prev) => ({
        ...prev,
        [index]: coordinates
          ? `Filled in name and location from the link.`
          : name
          ? `Filled in the name (as "${name}") — this type of link doesn't carry a photo or exact coordinates, so add those below.`
          : "Couldn't find a name in that link.",
      }));
    } catch (err) {
      setMapsLinkStatus((prev) => ({ ...prev, [index]: err.message }));
    } finally {
      setResolvingIndex(null);
    }
  }

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
      const generatedId = dedupeId(slugify(w.id || w.label || ""), existingIds);
      setId(generatedId);
      setIdTouched(true); // AI already chose one — don't let a later Label edit silently overwrite it
      setLabel(w.label || "");
      setPrefix(w.bookingIdPrefix || "");
      setPrefixTouched(true);
      setDescription(w.description || "");
      setJson(JSON.stringify({ ...w, id: generatedId }, null, 2));
      setAiStatus(result.validationWarning ? `Drafted, but check it over: ${result.validationWarning}` : "Drafted below — review before saving.");
    } catch (err) {
      setAiStatus(err.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function handleSave() {
    setError("");
    if (!label.trim()) return setError("Business Name is required.");
    if (!id.trim()) return setError("Business ID is required — open Advanced settings to set one.");
    if (!/^[a-z0-9_-]+$/i.test(id.trim())) return setError("Business ID must contain only letters, numbers, dashes, and underscores — open Advanced settings to fix it.");

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
          <span className="card-title">{isEdit ? `Edit Business: ${label || id}` : "Add Business"}</span>
          <button className="btn-link" style={{ fontSize: 20, fontWeight: "bold" }} onClick={onClose}>×</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {!isEdit && (
          <div style={{ background: "rgba(79,70,229,0.06)", border: "1px solid rgba(79,70,229,0.2)", borderRadius: "var(--radius-sm)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="form-label" style={{ margin: 0 }}>✨ Describe your business — fastest way to set this up</label>
            <textarea
              className="form-textarea" rows={2}
              placeholder='e.g. "A car wash and detailing shop, two bays, appointments by the hour"'
              value={aiDescription} onChange={(e) => setAiDescription(e.target.value)}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="btn-primary" type="button" disabled={aiBusy} onClick={handleGenerate}>✨ Generate</button>
              <span style={{ fontSize: 12, color: aiStatus.startsWith("Drafted, but") ? "var(--danger)" : "var(--muted)" }}>{aiStatus || "Fills in everything below — you can still tweak it after."}</span>
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label className="form-label">Business Name</label>
            <input className="form-input" placeholder="e.g. Zen Massage & Spa" value={label} onChange={(e) => handleLabelChange(e.target.value)} />
          </div>
          <div>
            <label className="form-label">What it's for (helps the bot recognize customer requests for it)</label>
            <input className="form-input" placeholder="e.g. massage, therapy, relaxation, wellness" value={description} onChange={(e) => { setDescription(e.target.value); restampJson({ description: e.target.value.trim() }); }} />
          </div>
          {providers && (
            <div>
              <label className="form-label">Providers — image &amp; location</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {providers.map((p, i) => {
                  const pin = parseLatLngFromMapQuery(p.mapQuery);
                  return (
                  <div key={p.id ?? i} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div>
                      <label className="form-label">Paste a Google Maps / share.google link (optional — fills in the name below)</label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input
                          className="form-input"
                          placeholder="https://share.google/…"
                          value={mapsLinkInputs[i] || ""}
                          onChange={(e) => setMapsLinkInputs((prev) => ({ ...prev, [i]: e.target.value }))}
                        />
                        <button
                          type="button" className="btn-secondary" disabled={resolvingIndex === i}
                          onClick={() => handleResolveMapsLink(i)}
                        >
                          {resolvingIndex === i ? "Looking up…" : "Fetch"}
                        </button>
                      </div>
                      {mapsLinkStatus[i] && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{mapsLinkStatus[i]}</div>}
                    </div>
                    <div className="form-group-row">
                      <div>
                        <label className="form-label">Name</label>
                        <input className="form-input" value={p.name || ""} onChange={(e) => updateProvider(i, { name: e.target.value })} />
                      </div>
                      <div>
                        <label className="form-label">Fee (₹)</label>
                        <input className="form-input" type="number" value={p.fee ?? ""} onChange={(e) => updateProvider(i, { fee: Number(e.target.value) || 0 })} />
                      </div>
                    </div>
                    <div>
                      <label className="form-label">Photo (shown to customers on WhatsApp at booking confirmation)</label>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          disabled={uploadingIndex === i}
                          onChange={(e) => { handlePhotoUpload(i, e.target.files?.[0]); e.target.value = ""; }}
                        />
                        {uploadingIndex === i && <span style={{ fontSize: 12, color: "var(--muted)" }}>Uploading…</span>}
                        {p.photo && <img src={p.photo} alt="" style={{ height: 40, width: 40, borderRadius: 6, objectFit: "cover", border: "1px solid var(--border)" }} />}
                      </div>
                      {uploadErrors[i] && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>{uploadErrors[i]}</div>}
                      <input
                        className="form-input" style={{ marginTop: 6 }}
                        placeholder="…or paste an image URL, e.g. https://…"
                        value={p.photo || ""}
                        onChange={(e) => updateProvider(i, { photo: e.target.value.trim() })}
                      />
                    </div>
                    <div>
                      <label className="form-label">Address (shown on the WhatsApp confirmation message)</label>
                      <input className="form-input" placeholder="e.g. 12 MG Road, Bengaluru" value={p.address || ""} onChange={(e) => updateProvider(i, { address: e.target.value })} />
                    </div>
                    <div>
                      <label className="form-label">Location</label>
                      <div>
                        <button type="button" className="btn-secondary" onClick={() => setOpenMapIndex(openMapIndex === i ? null : i)}>
                          {openMapIndex === i ? "Hide map" : pin ? "📍 Change pin on map" : "📍 Set pin on map"}
                        </button>
                        {pin && (
                          <span style={{ marginLeft: 8, fontSize: 12, color: "var(--muted)" }}>{pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}</span>
                        )}
                      </div>
                      {openMapIndex === i && (
                        <LocationPickerMap
                          lat={pin?.lat}
                          lng={pin?.lng}
                          onChange={(lat, lng) => updateProvider(i, { mapQuery: `${lat},${lng}` })}
                        />
                      )}
                      <input
                        className="form-input" style={{ marginTop: 6 }}
                        placeholder="…or type coordinates (12.9716,77.5946) or paste a Google Maps link"
                        value={p.mapQuery || ""}
                        onChange={(e) => updateProvider(i, { mapQuery: normalizeLocationInput(e.target.value) })}
                      />
                    </div>
                    <div>
                      <button type="button" className="btn-danger" style={{ padding: "3px 8px", fontSize: 12 }} onClick={() => removeProvider(i)}>Remove Provider</button>
                    </div>
                  </div>
                  );
                })}
                <button type="button" className="btn-secondary" onClick={addProvider}>＋ Add Provider</button>
              </div>
            </div>
          )}
          <div>
            <button type="button" className="btn-link" onClick={() => setAdvancedOpen((o) => !o)}>
              {advancedOpen ? "▾ Hide advanced settings" : "▸ Advanced settings (business ID, booking prefix, raw conversation JSON)"}
            </button>
          </div>
          {advancedOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, background: "var(--bg)", padding: 12, borderRadius: "var(--radius-sm)" }}>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                Auto-filled from the business name above — only change these if you specifically need to.
              </div>
              <div className="form-group-row">
                <div>
                  <label className="form-label">Business ID</label>
                  <input
                    className="form-input" disabled={isEdit} placeholder="e.g. spa (lowercase, no spaces)"
                    value={id}
                    onChange={(e) => { setId(e.target.value); setIdTouched(true); restampJson({ id: e.target.value.trim() }); }}
                  />
                </div>
                <div>
                  <label className="form-label">Booking ID Prefix</label>
                  <input
                    className="form-input" placeholder="e.g. SPA"
                    value={prefix}
                    onChange={(e) => { setPrefix(e.target.value); setPrefixTouched(true); restampJson({ bookingIdPrefix: e.target.value.trim() }); }}
                  />
                </div>
              </div>
              <div>
                <label className="form-label">Full Workflow JSON Config</label>
                <textarea className="form-textarea" rows={12} style={{ fontFamily: "monospace", fontSize: 12 }} value={json} onChange={(e) => setJson(e.target.value)} />
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>The fields above automatically update these keys on save. Use standard syntax matching existing workflows — this is where the actual WhatsApp conversation steps live.</div>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Saving…" : "Save Business"}</button>
        </div>
      </div>
    </div>
  );
}
