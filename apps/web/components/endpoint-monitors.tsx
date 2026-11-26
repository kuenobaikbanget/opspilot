"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { EndpointMonitor, Host } from "@opspilot/contracts";
import {
  endpointBadgeText,
  endpointBadgeTone,
  endpointCounts,
  endpointExpiry,
  endpointOutcome,
  endpointRows as buildEndpointRows,
  formatTimestamp,
  type EndpointRow,
} from "../lib/endpoint-status";
import { AsciiLoading } from "./ascii-card-reveal";
import { Badge, Button, Field, Panel, Select } from "./ui";

type Props = {
  endpoints: EndpointMonitor[] | null;
  servicesError: string;
  hosts: Host[];
  checkingEndpointId: string | null;
  onCheckEndpoint: (id: string) => void;
};

function hostLabel(endpoint: EndpointMonitor, hosts: Host[]): string {
  if (!endpoint.agent_id) return "No associated host";
  const host = hosts.find(item => item.id === endpoint.agent_id);
  if (!host) return "Associated host is not in the loaded inventory";
  return `${host.hostname} · Agent ${host.status === "online" ? "online" : "offline"}`;
}

export function EndpointMonitors({ endpoints, servicesError, hosts, checkingEndpointId, onCheckEndpoint }: Props) {
  const [clock, setClock] = useState(() => Date.now());
  const [scope, setScope] = useState<"all" | string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inspectorId = useId();
  const inspector = useRef<HTMLElement>(null);

  // Rows age against a ticking clock, independent of page refreshes or fleet polls.
  const rows = useMemo(() => (endpoints ? buildEndpointRows(endpoints, clock) : undefined), [endpoints, clock]);

  let nextExpiry = Infinity;
  for (const { endpoint, status } of rows ?? []) {
    if (status === "up" || status === "down") nextExpiry = Math.min(nextExpiry, endpointExpiry(endpoint));
  }
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(1, nextExpiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);

  const scopeHost = scope === "all" ? null : hosts.find(host => host.id === scope) ?? null;
  const effectiveScope = scope === "all" || scopeHost ? scope : "all";
  const scopedRows = effectiveScope === "all" ? rows : rows?.filter(row => row.endpoint.agent_id === effectiveScope);
  const counts = endpointCounts(scopedRows ?? []);
  const selectedRow = rows?.find(row => row.endpoint.id === selectedId);
  const selectedHost = selectedRow?.endpoint.agent_id
    ? hosts.find(host => host.id === selectedRow.endpoint.agent_id)
    : undefined;

  function select(id: string) {
    setSelectedId(id);
    inspector.current?.focus();
  }

  const loading = !endpoints && !servicesError;

  return (
    <Panel aria-labelledby="services-endpoints-title">
      <div className="panel-head">
        <div>
          <h2 id="services-endpoints-title">Endpoint checks</h2>
          <p className="muted">
            Independent HTTP probes, measured separately from host metrics and process state.
            A result is fresh for 60 seconds after its last check; older results are stale and keep their original check time.
          </p>
        </div>
      </div>

      {servicesError && !endpoints && <p className="muted" role="status">Endpoint monitors are unavailable. {servicesError}</p>}
      {servicesError && endpoints && (
        <p className="muted" role="status">
          Endpoint list refresh failed: {servicesError}. Showing the last successfully loaded list; each row shows how fresh its own check still is.
        </p>
      )}
      {loading && <AsciiLoading label="Loading endpoint monitors…" lines={3} widths={["86%", "73%", "80%"]} />}

      {endpoints && (
        <div className="services-endpoint-workspace">
          <div className="services-endpoint-list-pane">
            {hosts.length > 0 && (
              <Field id="services-endpoint-scope" label="Scope" hint="Filter endpoints by their associated host.">
                <Select id="services-endpoint-scope" value={effectiveScope} onChange={event => setScope(event.target.value)}>
                  <option value="all">All endpoints ({endpoints.length})</option>
                  {hosts.map(host => <option key={host.id} value={host.id}>Endpoints on {host.hostname}</option>)}
                </Select>
              </Field>
            )}
            {!endpoints.length ? (
              <p className="muted" role="status">No endpoint monitors configured. Use Add service to create one.</p>
            ) : !scopedRows?.length ? (
              <p className="muted" role="status">
                {scopeHost
                  ? `No endpoint monitors are configured for ${scopeHost.hostname}. Process state on this host is not endpoint reachability.`
                  : "No endpoints in this scope."}
              </p>
            ) : (
              <>
                <p role="status">
                  {scopeHost ? `${scopeHost.hostname}: ` : ""}{counts.up} up · {counts.down} down · {counts.pending} pending · {counts.stale} stale of {counts.configured} configured
                </p>
                <ul className="overview-endpoint-list" role="list">
                  {scopedRows.map((row) => {
                    const { endpoint, status } = row;
                    return (
                      <li key={endpoint.id} className="overview-endpoint-item" data-selected={selectedId === endpoint.id}>
                        <div className="overview-endpoint-main">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="overview-endpoint-select"
                            aria-controls={inspectorId}
                            aria-pressed={selectedId === endpoint.id}
                            onClick={() => select(endpoint.id)}
                          >
                            <span className="overview-endpoint-name">{endpoint.name}</span>
                            <Badge tone={endpointBadgeTone(status)} dot>{endpointBadgeText(endpoint, status)}</Badge>
                          </Button>
                          <div className="overview-endpoint-actions">
                            <Button
                              size="sm"
                              aria-label={`Check now: ${endpoint.name}`}
                              loading={checkingEndpointId === endpoint.id}
                              onClick={() => onCheckEndpoint(endpoint.id)}
                            >
                              Check now
                            </Button>
                          </div>
                        </div>
                        <div className="services-endpoint-meta">
                          <span>{endpoint.target_url} · Expected HTTP {endpoint.expected_status} · Probe {endpoint.probe_location}</span>
                          <span>
                            Last checked {formatTimestamp(endpoint.last_checked_at)}
                            {status === "stale" ? ` · Stale, last result ${endpointOutcome(endpoint)}` : ""}
                          </span>
                          <span>
                            {hostLabel(endpoint, hosts)}
                            {endpoint.service_name ? ` · Service ${endpoint.service_name}` : ""}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>

          <aside
            id={inspectorId}
            ref={inspector}
            tabIndex={-1}
            className="services-endpoint-inspector"
            aria-labelledby={`${inspectorId}-heading`}
          >
            {selectedRow ? (
              <EndpointInvestigation row={selectedRow} host={selectedHost} checking={checkingEndpointId === selectedRow.endpoint.id} onCheck={() => onCheckEndpoint(selectedRow.endpoint.id)} headingId={`${inspectorId}-heading`} />
            ) : (
              <>
                <div className="overview-inspector-head"><h3 id={`${inspectorId}-heading`}>Endpoint investigation</h3></div>
                <div className="overview-inspector-body">
                  <p className="muted" role="status">
                    {selectedId ? "This endpoint is no longer in the loaded list." : "Select an endpoint to inspect its target, probe location, expected and observed responses, and check time."}
                  </p>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </Panel>
  );
}

function EndpointInvestigation({ row, host, checking, onCheck, headingId }: { row: EndpointRow; host: Host | undefined; checking: boolean; onCheck: () => void; headingId: string }) {
  const { endpoint, status } = row;
  return (
    <>
      <div className="overview-inspector-head">
        <h3 id={headingId} className="overview-endpoint-name">{endpoint.name}</h3>
        <Badge tone={endpointBadgeTone(status)} dot>{endpointBadgeText(endpoint, status)}</Badge>
      </div>
      <div className="overview-inspector-body">
        <dl className="overview-evidence">
          <div><dt>Target URL</dt><dd>{endpoint.target_url}</dd></div>
          <div><dt>Probe location</dt><dd>{endpoint.probe_location}</dd></div>
          <div><dt>Expected response</dt><dd>HTTP {endpoint.expected_status}</dd></div>
          <div><dt>Observed response</dt><dd>{status === "pending" ? "No check result yet" : endpointOutcome(endpoint)}</dd></div>
          {endpoint.last_latency_ms !== null && status !== "pending" && <div><dt>Latency</dt><dd>{endpoint.last_latency_ms} ms</dd></div>}
          {endpoint.last_error && status !== "pending" && <div><dt>Check error</dt><dd>{endpoint.last_error}</dd></div>}
          <div>
            <dt>Last checked</dt>
            <dd>
              {endpoint.last_checked_at
                ? <time dateTime={endpoint.last_checked_at}>{formatTimestamp(endpoint.last_checked_at)}</time>
                : "Not observed"}
              {status === "stale" ? " · stale" : status === "pending" ? " · no usable result" : " · fresh"}
            </dd>
          </div>
          <div><dt>Associated host</dt><dd>{host ? `${host.hostname} · Agent ${host.status === "online" ? "online" : "offline"}` : hostLabel(endpoint, host ? [host] : [])}</dd></div>
          {endpoint.service_name && <div><dt>Service</dt><dd>{endpoint.service_name}</dd></div>}
        </dl>
        <p className="tiny">
          Probed independently at {endpoint.probe_location}; this result is not derived from host metrics or process state.
          {host && host.status !== "online" && ` The agent for ${host.hostname} is offline — this check still comes from the independent probe, not from the agent.`}
        </p>
        <p className="tiny" role="status">
          No root cause inferred. Temporal overlap between a process state, a host sample and a failed check is not causality;
          recorded AI hypotheses and human-confirmed resolutions are listed separately on Incidents.
        </p>
        <Button size="sm" loading={checking} onClick={onCheck}>Check now</Button>
      </div>
    </>
  );
}
