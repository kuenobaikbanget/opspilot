"use client";

import { ThresholdOverview } from "../../components/threshold-overview";
import { ButtonLink } from "../../components/ui";
import { WorkspaceIcon } from "../../components/workspace-shell";
import { useWorkspace } from "./workspace";
import { WorkspaceHeader } from "./workspace-header";
import { useEndpointCheck } from "./use-endpoint-check";

export default function OverviewPage() {
  const { fleet, fleetError, openIncidents, incidentsError, incidents, endpoints, servicesError, hostRefresh, openIncident, inspectHost } = useWorkspace();
  const { checkingEndpointId, checkEndpoint, actionError } = useEndpointCheck();
  return <>
    <WorkspaceHeader title="Know what’s close to the edge." description="See which resources have reached their configured limits and how much headroom is left." summary="fleet" actionError={actionError} actions={<>
      <ButtonLink href="/connect"><WorkspaceIcon name="terminal" />Connect server</ButtonLink>
      <ButtonLink href="/new-monitor" variant="primary"><WorkspaceIcon name="add" />New monitor</ButtonLink>
    </>} />
    <ThresholdOverview
      fleet={fleet}
      fleetError={fleetError}
      openIncidents={openIncidents}
      incidentsStale={!!incidentsError}
      incidents={incidents}
      endpoints={endpoints}
      servicesError={servicesError}
      checkingEndpointId={checkingEndpointId}
      onCheckEndpoint={id => void checkEndpoint(id)}
      onOpenIncident={openIncident}
      onInspectHost={inspectHost}
      refreshKey={hostRefresh}
    />
  </>;
}
