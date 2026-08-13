import { useOutletContext } from "react-router-dom";
import ApiKeysPanel from "../components/ApiKeysPanel";
import AuditLogPanel from "../components/AuditLogPanel";
import SessionsPanel from "../components/SessionsPanel";
import KnowledgeBasePanel from "../components/KnowledgeBasePanel";

export default function SettingsPage() {
  const { refreshKey, providers, isAdminAccount } = useOutletContext();
  const ownProvider = providers[0];

  return (
    <>
      {isAdminAccount && <ApiKeysPanel refreshKey={refreshKey} />}
      {!isAdminAccount && ownProvider && <KnowledgeBasePanel refreshKey={refreshKey} provider={ownProvider} isAdmin={false} />}
      <SessionsPanel refreshKey={refreshKey} />
      {isAdminAccount && <AuditLogPanel refreshKey={refreshKey} />}
    </>
  );
}
