"use client";

import { useState } from "react";
import { AsciiLoading } from "../../../components/ascii-card-reveal";
import { HostSystemd } from "../../../components/host-systemd";
import { Badge, Button, ButtonLink, Field, Panel, Select } from "../../../components/ui";
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
    <WorkspaceHeader title="Services" description="Workload state and endpoint reachability are measured separately from host health." actionError={actionError} actions={
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
      <Panel aria-labelledby="services-endpoints-title">
        <div className="panel-head">
          <div>
            <h2 id="services-endpoints-title">Endpoint checks</h2>
            <p className="muted">Independent HTTP probes from {endpoints?.[0]?.probe_location ?? "hub-local"}.</p>
          </div>
        </div>
        {servicesError ? <p className="muted" role="status">{servicesError}</p> : !endpoints ? <AsciiLoading label="Loading endpoint monitors…" lines={3} widths={["86%", "73%", "80%"]} /> : !endpoints.length && <p className="muted">No endpoint monitors configured.</p>}
        <ul className="overview-endpoint-list" role="list">
          {endpoints?.map(endpoint => (
            <li key={endpoint.id} className="overview-endpoint-item">
              <div className="overview-endpoint-main">
                <div>
                  <strong>{endpoint.name}</strong>
                  <span className="overview-meta">{endpoint.target_url} · Expected HTTP {endpoint.expected_status}</span>
                </div>
                <div className="overview-endpoint-actions">
                  <Badge tone={endpoint.last_status === "up" ? "success" : endpoint.last_status === "down" ? "danger" : "neutral"} dot>
                    {endpoint.last_status === "up"
                      ? `Up · HTTP ${endpoint.last_http_status ?? endpoint.expected_status}${endpoint.last_latency_ms !== null ? ` · ${endpoint.last_latency_ms} ms` : ""}`
                      : endpoint.last_status === "down"
                        ? `Down · ${endpoint.last_http_status !== null ? `HTTP ${endpoint.last_http_status}` : endpoint.last_error ?? "unreachable"}`
                        : "Pending"}
                  </Badge>
                  <Button size="sm" loading={checkingEndpointId === endpoint.id} onClick={() => void checkEndpoint(endpoint.id)}>Check now</Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  </>;
}
