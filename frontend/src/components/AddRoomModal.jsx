import { useState } from "react";
import { post } from "../lib/api";
import NumberStepperInput from "./NumberStepperInput";

// The hotels[] counterpart to AddProviderModal — found live: a hotel-
// shaped business (workflow.hotels[], each with its own nested rooms[])
// had no "+ Add Provider" button at all in Manage Businesses (that button
// is gated on workflow.providers, which hotels don't have), so the only
// way to add a room type was opening Edit and hand-writing raw JSON. This
// gives hotels the same one-purpose "just add the thing" modal providers
// already have. Only adds a room to an EXISTING hotel location — adding a
// whole new hotel location (name/address/rating/map link) is a bigger,
// rarer action still reasonably left to raw JSON via Edit.
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function dedupeId(base, existingIds) {
  const safeBase = base || "room";
  if (!existingIds.includes(safeBase)) return safeBase;
  for (let n = 2; ; n++) {
    if (!existingIds.includes(`${safeBase}-${n}`)) return `${safeBase}-${n}`;
  }
}

export default function AddRoomModal({ workflow, onClose, onSaved }) {
  const hotels = workflow.hotels || [];
  const [hotelId, setHotelId] = useState(hotels[0]?.id || "");
  const [name, setName] = useState("");
  const [attribute, setAttribute] = useState("");
  const [fee, setFee] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setError("");
    if (!name.trim()) return setError("Room name is required.");
    const targetHotel = hotels.find((h) => h.id === hotelId);
    if (!targetHotel) return setError("Pick a hotel to add this room to.");

    const existingIds = (targetHotel.rooms || []).map((r) => r.id);
    const newRoom = {
      id: dedupeId(`${targetHotel.id}-${slugify(name)}`, existingIds),
      name: name.trim(),
      attribute: attribute.trim(),
      fee: Number(fee) || 0,
    };
    const updatedHotels = hotels.map((h) => (h.id === hotelId ? { ...h, rooms: [...(h.rooms || []), newRoom] } : h));

    setSaving(true);
    try {
      await post("/api/dashboard/workflows", { ...workflow, hotels: updatedHotels });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const activeHotel = hotels.find((h) => h.id === hotelId);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <div className="modal-icon-header">
          <div className="modal-icon-badge hotel">🏨</div>
          <div className="modal-title-group">
            <span className="modal-title-main">Add a room</span>
            <span className="modal-title-sub">A new room type for {workflow.label}</span>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {hotels.length > 1 ? (
          <div>
            <label className="form-label">Which hotel is this room at?</label>
            <select className="form-select" value={hotelId} onChange={(e) => setHotelId(e.target.value)}>
              {hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
        ) : hotels.length === 1 ? (
          <span className="modal-target-chip">📍 Adding to {hotels[0].name}</span>
        ) : (
          <div className="error-banner">This business has no hotel locations yet — add one via Edit first.</div>
        )}

        <div className="modal-preview-card">
          <div className="modal-preview-icon">🛏️</div>
          <div className="modal-preview-body">
            <div className="modal-preview-name">{name.trim() || "Room name"}</div>
            <div className="modal-preview-sub">{attribute.trim() || "Room details"} · ₹{fee || 0}/night{activeHotel ? ` · ${activeHotel.name}` : ""}</div>
          </div>
        </div>

        <div className="modal-section">
          <div>
            <label className="form-label">Room name</label>
            <input className="form-input" placeholder="e.g. Deluxe Room" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="form-label">Room details (shown next to the name)</label>
            <input className="form-input" placeholder="e.g. King Bed, Business Stay" value={attribute} onChange={(e) => setAttribute(e.target.value)} />
          </div>
          <div>
            <label className="form-label">Rate (₹/night)</label>
            <NumberStepperInput prefix="₹" step={100} min={0} value={fee} onChange={(next) => setFee(next === "" ? "" : next)} />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saving || !hotels.length} onClick={handleSave}>{saving ? "Adding…" : "Add Room"}</button>
        </div>
      </div>
    </div>
  );
}
