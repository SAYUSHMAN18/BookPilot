import { useOutletContext } from "react-router-dom";
import BillingPanel from "../components/BillingPanel";

export default function BillingPage() {
  const { refreshKey } = useOutletContext();
  return <BillingPanel refreshKey={refreshKey} />;
}
