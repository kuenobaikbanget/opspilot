"use client";

import { useCallback } from "react";
import { HostWorkspace } from "../../../components/host-workspace";
import { ButtonLink } from "../../../components/ui";
import { WorkspaceIcon } from "../../../components/workspace-shell";
import { useWorkspace } from "../workspace";
import { WorkspaceHeader } from "../workspace-header";

export default function HostsPage() {
  const { fleet, fleetError, openIncidents, incidentsError, incidents, hostRefresh, openIncident, selection, consumeSelection } = useWorkspace();
  const inspectHost = selection?.href === "/hosts" ? selection : null;
  const onInspectionHandled = useCallback(() => {
    if (inspectHost) consumeSelection(inspectHost);
  }, [inspectHost, consumeSelection]);

  return <>
    <WorkspaceHeader title="Every host. One clear view." description="Monitor agent connectivity and resource usage across your Linux hosts." summary="fleet" actions={
      <ButtonLink href="/connect" variant="primary"><WorkspaceIcon name="terminal" />Connect server</ButtonLink>
    } />
    <HostWorkspace refreshKey={hostRefresh} fleet={fleet} failure={fleetError} openIncidents={openIncidents} incidentsStale={!!incidentsError} incidents={incidents} onOpenIncident={openIncident} inspectHost={inspectHost} onInspectionHandled={onInspectionHandled} />
  </>;
}
