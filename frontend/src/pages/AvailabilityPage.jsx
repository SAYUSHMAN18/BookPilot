import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import AvailabilityPanel from "../components/AvailabilityPanel";
import CalendarSyncPanel from "../components/CalendarSyncPanel";

// A provider-role account is pinned to exactly one business (same
// requireAuth("admin","provider") scoping every /api/dashboard/bookings-
// shaped route already enforces) — no picker needed. An admin manages
// every business, so this page adds the picker the old single-page
// AdminView never had for availability specifically (it only ever showed
// this per-provider inside ProviderView).
export default function AvailabilityPage() {
  const { providers, isAdminAccount } = useOutletContext();
  const [selectedKey, setSelectedKey] = useState("");

  useEffect(() => {
    if (!selectedKey && providers.length) {
      setSelectedKey(`${providers[0].workflowId}::${providers[0].providerId}`);
    }
  }, [providers, selectedKey]);

  const provider = providers.find((p) => `${p.workflowId}::${p.providerId}` === selectedKey);

  if (!providers.length) {
    return <div className="card"><div className="empty">No businesses set up yet — add one from Businesses first.</div></div>;
  }

  return (
    <>
      {isAdminAccount && providers.length > 1 && (
        <div className="card">
          <div className="card-header"><span className="card-title">Choose a business</span></div>
          <select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)} style={{ minWidth: 260 }}>
            {providers.map((p) => (
              <option key={`${p.workflowId}::${p.providerId}`} value={`${p.workflowId}::${p.providerId}`}>{p.workflowLabel} — {p.providerName}</option>
            ))}
          </select>
        </div>
      )}
      {provider && (
        <>
          <AvailabilityPanel provider={provider} />
          <CalendarSyncPanel provider={provider} />
        </>
      )}
    </>
  );
}
