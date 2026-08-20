import { useOutletContext } from "react-router-dom";
import AuditLogPanel from "../components/AuditLogPanel";
import SessionsPanel from "../components/SessionsPanel";
import KnowledgeBasePanel from "../components/KnowledgeBasePanel";
import WhatsAppNumberPanel from "../components/WhatsAppNumberPanel";

// Public API key management (ApiKeysPanel) is intentionally not shown here
// — it's a developer/integration feature (a tenant's own website calling
// GET /api/v1/availability or /bookings/:id directly) that doesn't match
// this product's actual small-local-business customers. The backend
// (src/routes/publicApi.js, src/store/apiKeyStore.js) is untouched and
// still works — this is a UI decision, not a feature removal, so it can
// come back for a tenant that actually needs it (e.g. a future Enterprise
// tier) without any backend work.
export default function SettingsPage() {
  const { refreshKey, providers, isAdminAccount } = useOutletContext();
  const ownProvider = providers[0];

  return (
    <>
      {!isAdminAccount && ownProvider && <KnowledgeBasePanel refreshKey={refreshKey} provider={ownProvider} isAdmin={false} />}
      {isAdminAccount && <WhatsAppNumberPanel />}
      <SessionsPanel refreshKey={refreshKey} />
      {isAdminAccount && <AuditLogPanel refreshKey={refreshKey} />}
    </>
  );
}
