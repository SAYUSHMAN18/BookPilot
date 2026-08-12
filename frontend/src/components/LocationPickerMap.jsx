import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, useMapEvents } from "react-leaflet";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";

// Leaflet's default marker icon references image paths that break once a
// bundler (Vite here) hashes/moves the actual files — the standard fix is
// to point it at the same images re-imported as bundled asset URLs, so
// everything stays self-hosted (no CDN dependency, no CSP exception needed
// for anything other than the map tiles themselves).
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

const DEFAULT_CENTER = [20.5937, 78.9629]; // India, roughly centered — just a reasonable starting view

function ClickToPlace({ onPick }) {
  useMapEvents({ click(e) { onPick(e.latlng.lat, e.latlng.lng); } });
  return null;
}

// Recenters the map imperatively when `center` changes from outside (e.g.
// switching which provider row is being edited) — MapContainer only reads
// its `center` prop once, on mount.
function Recenter({ center }) {
  const map = useMapEvents({});
  useEffect(() => { if (center) map.setView(center); }, [center, map]);
  return null;
}

// A click-to-drop-a-pin map. Tiles come from OpenStreetMap's public tile
// server (free, no API key) — the one external network dependency this
// needs; everything else (marker icons, Leaflet CSS/JS) is bundled locally.
export default function LocationPickerMap({ lat, lng, onChange }) {
  const hasPin = typeof lat === "number" && typeof lng === "number";
  const center = hasPin ? [lat, lng] : DEFAULT_CENTER;

  return (
    <div style={{ borderRadius: "var(--radius-sm)", overflow: "hidden", border: "1px solid var(--border)" }}>
      <MapContainer center={center} zoom={hasPin ? 14 : 5} style={{ height: 220, width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClickToPlace onPick={onChange} />
        <Recenter center={hasPin ? center : null} />
        {hasPin && <Marker position={center} />}
      </MapContainer>
    </div>
  );
}
