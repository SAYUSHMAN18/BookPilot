import { useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import SupportRequestsPanel from "../components/SupportRequestsPanel";
import FeedbackPanel from "../components/FeedbackPanel";

export default function SupportPage() {
  const { providers, refreshKey } = useOutletContext();
  const workflowLabel = useMemo(() => {
    const map = new Map();
    providers.forEach((p) => map.set(p.workflowId, p.workflowLabel));
    return (id) => map.get(id) || id;
  }, [providers]);

  return (
    <>
      <SupportRequestsPanel refreshKey={refreshKey} workflowLabel={workflowLabel} />
      <FeedbackPanel refreshKey={refreshKey} workflowLabel={workflowLabel} />
    </>
  );
}
