"use client";

import { useState } from "react";
import { AsciiLoading } from "../../../components/ascii-card-reveal";
import { EndpointMonitors } from "../../../components/endpoint-monitors";
import { HostSystemd } from "../../../components/host-systemd";
import { ButtonLink, Field, Panel, Select } from "../../../components/ui";
import { WorkspaceIcon } from "../../../components/workspace-shell";
import { useWorkspace } from "../workspace";
import { WorkspaceHeader } from "../workspace-header";
import { useEndpointCheck } from "../use-endpoint-check";

export default function ServicesPage() {
  const { fleet, fleetError, endpoints, servicesError, hostRefresh } = useWorkspace();
  const { checkingEndpointId, checkEndpoint, actionError } = useEndpointCheck();
  const [serviceHostId, setServiceHostId] = useState("");
  const hosts = fleet?.hosts ?? [];
  const firstHost = hosts[0];
  if (!serviceHostId && firstHost) setServiceHostId(firstHost.id);
  const serviceHost = serviceHostId ? hosts.find(host => host.id === serviceHostId) : firstHost;

  return <>
    <WorkspaceHeader title="Services" summary="fleet" description="Workload state and endpoint reachability are measured separately from host health." actionError={actionError} actions={
      <ButtonLink href="/new-monitor" variant="primary"><WorkspaceIcon name="add" />Add service</ButtonLink>
    } />
    <div className="services-workspace">
      <Panel aria-labelledby="services-workloads-title">
        <div className="panel-head">
          <div>
            <h2 id="services-workloads-title">Host workloads</h2>
            <p className="muted">Only the systemd unit configured on the selected agent is monitored.</p>
          </div>
        </div>
        {hosts.length > 0 ? (
          <>
            <Field id="service-host" label="Host">
              <Select id="service-host" value={serviceHost?.id ?? ""} onChange={event => setServiceHostId(event.target.value)}>
                {!serviceHost && <option value="" disabled>Select another host</option>}
                {hosts.map(host => <option value={host.id} key={host.id}>{host.hostname}</option>)}
              </Select>
            </Field>
            {serviceHost ? <HostSystemd key={serviceHost.id} hostId={serviceHost.id} refreshKey={hostRefresh} />
              : <p className="muted" role="status">The selected host is no longer in the loaded inventory.</p>}
          </>
        ) : !fleet && !fleetError ? <AsciiLoading label="Loading host inventory…" />
          : <p className="muted" role="status">{fleetError ? "Host inventory is unavailable." : "Connect a host to view its service observations."}</p>}
      </Panel>
      <EndpointMonitors
        endpoints={endpoints}
        servicesError={servicesError}
        hosts={hosts}
        checkingEndpointId={checkingEndpointId}
        onCheckEndpoint={id => void checkEndpoint(id)}
      />
    </div>
  </>;
}
