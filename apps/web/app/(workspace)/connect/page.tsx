"use client";

import { useRouter } from "next/navigation";
import { ServerOnboarding } from "../../../components/server-onboarding";
import { useWorkspace } from "../workspace";
import { WorkspaceNotices } from "../workspace-header";

function unauthorized() {
  window.dispatchEvent(new Event("opspilot-unauthorized"));
}

export default function ConnectPage() {
  const router = useRouter();
  const { fleet, fleetError, refreshFleet } = useWorkspace();
  return <>
    <WorkspaceNotices />
    <ServerOnboarding onBack={() => router.push("/hosts")} onUnauthorized={unauthorized} fleet={fleet} fleetError={fleetError} onRefresh={refreshFleet} />
  </>;
}
