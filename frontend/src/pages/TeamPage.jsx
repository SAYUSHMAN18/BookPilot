import { useOutletContext } from "react-router-dom";
import ManageTeamPanel from "../components/ManageTeamPanel";

export default function TeamPage() {
  const { providers, refreshKey, user } = useOutletContext();
  return <ManageTeamPanel refreshKey={refreshKey} providers={providers} currentUserEmail={user.email} />;
}
