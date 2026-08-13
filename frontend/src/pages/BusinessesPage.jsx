import { useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import ManageBusinessesPanel from "../components/ManageBusinessesPanel";
import KnowledgeBasePanel from "../components/KnowledgeBasePanel";

export default function BusinessesPage() {
  const { providers, refreshKey, bump } = useOutletContext();
  const workflowLabel = useMemo(() => {
    const map = new Map();
    providers.forEach((p) => map.set(p.workflowId, p.workflowLabel));
    return (id) => map.get(id) || id;
  }, [providers]);

  return (
    <>
      <ManageBusinessesPanel refreshKey={refreshKey} bump={bump} />
      <KnowledgeBasePanel refreshKey={refreshKey} isAdmin workflowLabel={workflowLabel} />
    </>
  );
}
