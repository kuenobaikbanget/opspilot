"use client";

import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Host, HostList, HostMetric } from "@opspilot/contracts";
import { AsciiLoading } from "./ascii-card-reveal";
import { Badge, Button, Input, Notice, Panel } from "./ui";
import { hasFreshSample, percent, pressure, resourcePressure, resources, type Resource } from "../lib/host-pressure";
import { WorkspaceIcon } from "./workspace-shell";
import { HostSystemd } from "./host-systemd";
import { deriveNetworkRates } from "../lib/host-network";

type FleetIncident = {
  id: string;
  agent_id: string;
  hostname: string;
  title: string;
  category: string;
  status: string;
  created_at: string;
};

type Props = {
  refreshKey: number;
  isVisible: boolean;
  onFleet: (fleet: HostList) => void;
  onFleetError: (message: string) => void;
  onUnauthorized: () => void;
  openIncidents: number | null;
  incidentsStale: boolean;
  incidents: FleetIncident[];
  onOpenIncident: (id: string) => void;
  inspectHost: { id: string; resource?: Resource } | null;
  onConnect: () => void;
};

const stamp = (s: string | null) => (s ? new Date(s).toLocaleString() : "Not observed");

const age = (s: string | null, now: number) => {
  if (!s) return "Not observed";
  const seconds = Math.max(0, Math.floor((now - Date.parse(s)) / 1000));
  return seconds < 60
    ? `${seconds}s ago`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`;
};

const pressureLabel = { within: "Within limit", near: "Near limit", exceeded: "Limit reached" };
const pressureClass = (state?: keyof typeof pressureLabel) =>
  state === "exceeded" ? "measurement--danger" : state === "near" ? "measurement--warning" : "";

function selectWithTransition(update: () => void) {
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce), (max-width: 700px)").matches) {
    update();
    return;
  }
  void document.startViewTransition(() => flushSync(update)).finished.catch(() => {});
}

async function request(path: string, signal?: AbortSignal, method = "GET") {
  const r = await fetch(`/api${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    method,
  });
  if (r.status === 401) throw new Error("Unauthorized");
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || `HTTP ${r.status}`);
  return value;
}

function ResourceHistory({ samples, resource }: { samples: HostMetric[]; resource: Resource }) {
  const sliderId = useId();
  const [cursorTime, setCursorTime] = useState<string | null>(null);
  const label = resources.find(r => r.key === resource)!.label;
  const rows = [...samples].sort((a, b) => Date.parse(a.sampled_at) - Date.parse(b.sampled_at));
  const valid = rows.filter(r => r[resource] != null && Number.isFinite(r[resource]));
  if (!rows.length) {
    return <p className="empty">No {label} samples received yet. History is unavailable.</p>;
  }

  const start = Date.parse(rows[0].sampled_at);
  const end = Date.parse(rows[rows.length - 1].sampled_at);
  const duration = end - start;
  const width = 480;
  const height = 180;
  const x = (t: number) => 48 + ((t - start) / (duration || 1)) * width;
  const y = (n: number) => 16 + height * (1 - n / 100);
  const cursorIndex = rows.findIndex(r => r.sampled_at === cursorTime);
  const index = cursorIndex < 0 ? rows.length - 1 : cursorIndex;
  const observation = rows[index];
  const cursorX = x(Date.parse(observation.sampled_at));
  const measured = observation[resource] != null && Number.isFinite(observation[resource]);

  let interval = 15000;
  for (let i = 1; i < rows.length; i++) {
    const gap = Date.parse(rows[i].sampled_at) - Date.parse(rows[i - 1].sampled_at);
    if (gap > 0) interval = Math.min(interval, gap);
  }
  const barWidth = Math.max(1, Math.min(24, duration ? (width * interval) / duration * 0.72 : 24));
  const time = (s: string) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <figure className="resource-history">
      <figcaption>
        <h3>{label} utilization</h3>
        <span>{duration ? `${Math.round(duration / 60000)} min` : "Single sample"} · Raw samples</span>
      </figcaption>
      <div className="history-observation">
        <strong>{percent(observation[resource])}</strong>
        <time dateTime={observation.sampled_at}>{stamp(observation.sampled_at)}</time>
      </div>
      <div className="history-chart resource-chart">
        <div className="history-scale" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
        <svg
          viewBox="0 0 548 212"
          role="img"
          aria-label={`${label} usage, 0 to 100 percent. ${valid.length} measured samples from ${stamp(rows[0].sampled_at)} to ${stamp(rows[rows.length - 1].sampled_at)}. Each bar is one observation; missing intervals remain empty.`}
          onPointerMove={event => {
            if (event.pointerType !== "mouse") return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const position = (event.clientX - bounds.left) / bounds.width * 548;
            const timestamp = start + Math.max(0, Math.min(1, (position - 48) / width)) * duration;
            let nearest = 0;
            for (let i = 1; i < rows.length; i++) {
              if (Math.abs(Date.parse(rows[i].sampled_at) - timestamp) < Math.abs(Date.parse(rows[nearest].sampled_at) - timestamp)) nearest = i;
            }
            setCursorTime(rows[nearest].sampled_at);
          }}
        >
          {[0, 50, 100].map(value => (
            <g key={value}>
              <line x1="48" x2="544" y1={y(value)} y2={y(value)} className="chart-grid" />
            </g>
          ))}
          {valid.map(r => (
            <rect
              key={r.sampled_at}
              x={x(Date.parse(r.sampled_at)) - barWidth / 2}
              y={y(r[resource])}
              width={barWidth}
              height={(height * r[resource]) / 100}
              rx="1.5"
              className="chart-bar"
              data-active={r.sampled_at === observation.sampled_at}
            >
              <title>{stamp(r.sampled_at)} · {percent(r[resource])}</title>
            </rect>
          ))}
          <line x1={cursorX} x2={cursorX} y1="16" y2="196" className="chart-cursor" />
          {measured && <circle cx={cursorX} cy={y(observation[resource])} r="4" className="chart-cursor-point" />}
        </svg>
      </div>
      <div className="history-time-labels" aria-hidden="true">
        <span>{time(rows[0].sampled_at)}</span>
        {duration > 0 && <span>{time(rows[rows.length - 1].sampled_at)}</span>}
      </div>
      <div className="history-scrubber">
        <label htmlFor={sliderId}>Inspect observation</label>
        <span>{index + 1} / {rows.length}</span>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={rows.length - 1}
          value={index}
          disabled={rows.length === 1}
          onChange={event => setCursorTime(rows[Number(event.target.value)].sampled_at)}
          aria-valuetext={`${stamp(observation.sampled_at)}: ${measured ? percent(observation[resource]) : "No measurement"}`}
        />
      </div>
      <p className="tiny">
        {valid.length} measurements · No aggregation · {Intl.DateTimeFormat().resolvedOptions().timeZone}
        <br />
        <time dateTime={rows[0].sampled_at}>{stamp(rows[0].sampled_at)}</time> –{" "}
        <time dateTime={rows[rows.length - 1].sampled_at}>{stamp(rows[rows.length - 1].sampled_at)}</time>
      </p>
      {!valid.length && <p>{label} measurements unavailable for this range.</p>}
    </figure>
  );
}

function NetworkHistory({
  samples,
  maxInterval,
  current,
  cached,
}: {
  samples: HostMetric[];
  maxInterval: number;
  current: boolean;
  cached: boolean;
}) {
  const sliderId = useId();
  const [cursorTime, setCursorTime] = useState<string | null>(null);
  const rows = deriveNetworkRates(samples, maxInterval);
  const valid = rows.filter(row => row.rxMbps !== null && row.txMbps !== null);
  if (!valid.length) return <p className="empty">Network rates unavailable — two usable samples are required.</p>;

  const cursorIndex = rows.findIndex(row => row.sampledAt === cursorTime);
  const selectedIndex = cursorIndex < 0 ? rows.length - 1 : cursorIndex;
  const observation = rows[selectedIndex];
  const usable = observation.rxMbps !== null && observation.txMbps !== null;
  const latest = selectedIndex === rows.length - 1;
  const label = !usable
    ? latest ? "Latest interval unavailable" : "Unavailable"
    : !latest ? "Historical"
      : cached ? "Cached"
        : current && Date.now() - observation.timestampMs <= maxInterval * 1000 ? "Latest interval" : "Historical";
  const format = (n: number | null) =>
    n === null ? "Unavailable" : n > 0 && n < 0.001 ? "<0.001" : String(Number(n.toFixed(3)));
  const start = rows[0].timestampMs;
  const end = rows[rows.length - 1].timestampMs;
  const x = (t: number) => 48 + (t - start) / (end - start || 1) * 464;
  const top = Math.max(...valid.flatMap(row => [row.rxMbps!, row.txMbps!])) || 1;
  const time = (s: string) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const valueText = usable
    ? `${observation.intervalSeconds} seconds, RX ${format(observation.rxMbps)} Mb/s, TX ${format(observation.txMbps)} Mb/s`
    : "Unavailable";

  return (
    <figure className="resource-history network-history">
      <figcaption>
        <h3>Network traffic</h3>
        <span>Estimated aggregate traffic · excludes loopback</span>
      </figcaption>
      <div className="history-observation">
        <span>{label}</span>
        <time dateTime={observation.sampledAt}>{stamp(observation.sampledAt)}</time>
      </div>
      <p>RX (download): <strong>{format(observation.rxMbps)}</strong> Mb/s · TX (upload): <strong>{format(observation.txMbps)}</strong> Mb/s</p>
      <div className="history-chart network-chart">
        <div className="network-scale" aria-hidden="true">
          <span>RX <span>{format(top)} Mb/s</span></span>
          <span>TX <span>{format(top)} Mb/s</span></span>
        </div>
        <svg viewBox="0 0 548 190" role="img" aria-label="Estimated RX and TX rates over Hub receipt intervals. Unavailable intervals have no dots.">
          {(["rxMbps", "txMbps"] as const).map((key, track) => (
            <g key={key}>
              <line x1="48" x2="512" y1={track * 90 + 92} y2={track * 90 + 92} className="chart-grid" />
              {valid.map(row => (
                <circle key={row.sampledAt} cx={x(row.timestampMs)} cy={track * 90 + 92 - row[key]! / top * 62} r="4" className="chart-cursor-point">
                  <title>{stamp(row.sampledAt)} · {format(row[key])} Mb/s</title>
                </circle>
              ))}
            </g>
          ))}
          <line x1={x(observation.timestampMs)} x2={x(observation.timestampMs)} y1="30" y2="182" className="chart-cursor" />
        </svg>
      </div>
      <div className="history-time-labels" aria-hidden="true">
        <span>{time(rows[0].sampledAt)}</span>
        <span>{time(rows[rows.length - 1].sampledAt)}</span>
      </div>
      <div className="history-scrubber">
        <label htmlFor={sliderId}>Inspect network interval</label>
        <span>{selectedIndex + 1} / {rows.length}</span>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={rows.length - 1}
          value={selectedIndex}
          onChange={event => setCursorTime(rows[Number(event.target.value)].sampledAt)}
          aria-valuetext={`${stamp(observation.sampledAt)}: ${valueText}`}
        />
      </div>
      <p className="tiny">Rates estimated from cumulative counters over Hub receipt intervals; gaps and ambiguous reads are unavailable.</p>
    </figure>
  );
}

export function HostWorkspace({
  refreshKey,
  isVisible,
  onFleet,
  onFleetError,
  onUnauthorized,
  openIncidents,
  incidentsStale,
  incidents,
  onOpenIncident,
  inspectHost,
  onConnect,
}: Props) {
  const [fleet, setFleet] = useState<HostList | null>(null);
  const [failure, setFailure] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [appliedInspection, setAppliedInspection] = useState<Props["inspectHost"]>(null);
  const selectedRef = useRef(selected);
  const loadedOnce = useRef(false);
  selectedRef.current = selected;
  const [history, setHistory] = useState<{ id: string; samples: HostMetric[] } | null>(null);
  const [historyRequest, setHistoryRequest] = useState<{ id: string; pending: boolean; error: string | null } | null>(null);
  const [historyMode, setHistoryMode] = useState<"resource" | "network">("resource");
  const [resource, setResource] = useState<Resource>("cpu_percent");
  const [now, setNow] = useState(Date.now());
  const inspectorHeading = useRef<HTMLHeadingElement>(null);

  if (inspectHost && inspectHost !== appliedInspection) {
    setAppliedInspection(inspectHost);
    setSelected(inspectHost.id);
    setSelectionNotice("");
    setResource(inspectHost.resource ?? "cpu_percent");
    setHistoryMode("resource");
  }

  useEffect(() => {
    let active = true;
    let pending = false;
    const controller = new AbortController();

    async function load() {
      if (pending) return;
      pending = true;
      try {
        const next: HostList = await request("/hosts", controller.signal);
        if (!active) return;
        setFleet(next);
        setFailure("");
        onFleet(next);
        onFleetError("");
        if (!loadedOnce.current && next.hosts.length) {
          loadedOnce.current = true;
          const loadTime = Date.now();
          const ordered = next.hosts
            .map(host => ({ host, risk: pressure(host, next, loadTime) }))
            .sort((a, b) => (a.risk?.headroom ?? Infinity) - (b.risk?.headroom ?? Infinity));
          setSelected(current => current ?? ordered[0].host.id);
        }
        if (selectedRef.current && !next.hosts.some(h => h.id === selectedRef.current)) {
          setSelected(null);
          setSelectionNotice("The selected host is no longer in the loaded host list. Select another host.");
        }
      } catch (e) {
        if (!active) return;
        const message = e instanceof Error ? e.message : String(e);
        if (message === "Unauthorized") onUnauthorized();
        else { setFailure(message); onFleetError(message); }
      } finally {
        pending = false;
      }
    }

    void load();
    const poll = setInterval(() => void load(), 10000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(poll);
    };
  }, [refreshKey, onFleet, onFleetError, onUnauthorized]);

  useEffect(() => {
    if (!isVisible) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible || !selected) return;
    let active = true;
    let pending = false;
    const controller = new AbortController();

    async function load() {
      if (pending) return;
      pending = true;
      setHistoryRequest(previous => ({ id: selected!, pending: true, error: previous?.id === selected ? previous.error : null }));
      try {
        const samples: HostMetric[] = await request(`/hosts/${selected}/metrics`, controller.signal);
        if (active) {
          setHistory({ id: selected!, samples });
          setHistoryRequest({ id: selected!, pending: false, error: null });
        }
      } catch (e) {
        if (!active) return;
        const message = e instanceof Error ? e.message : String(e);
        if (message === "Unauthorized") onUnauthorized();
        else setHistoryRequest({ id: selected!, pending: false, error: message });
      } finally {
        pending = false;
      }
    }

    void load();
    const poll = setInterval(() => void load(), 10000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(poll);
    };
  }, [isVisible, selected, refreshKey, onUnauthorized]);

  useEffect(() => {
    if (!inspectHost) return;
    const frame = requestAnimationFrame(() => {
      inspectorHeading.current?.closest(".host-inspector")?.scrollIntoView({ block: "start" });
      inspectorHeading.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [inspectHost]);

  if (!isVisible) return null;

  const hosts = fleet?.hosts ?? [];
  const fleetLoading = !fleet && !failure;
  const rows = hosts.map(host => ({ host, risk: fleet && !failure ? pressure(host, fleet, now) : null }));
  rows.sort((a, b) => (a.risk?.headroom ?? Infinity) - (b.risk?.headroom ?? Infinity));
  const term = query.trim().toLowerCase();
  const visible = rows.filter(({ host, risk }) =>
    `${host.hostname} ${host.id}`.toLowerCase().includes(term) &&
    (status === "all" || host.status === status || (status === "attention" && !!risk && risk.state !== "within")),
  );
  const counts = {
    exceeded: rows.filter(({ risk }) => risk?.state === "exceeded").length,
    near: rows.filter(({ risk }) => risk?.state === "near").length,
    within: rows.filter(({ risk }) => risk?.state === "within").length,
  };
  const assessed = rows.filter(({ risk }) => risk !== null).length;
  const host = hosts.find(h => h.id === selected);
  const stale = (h: Host) => !fleet || !hasFreshSample(h, fleet, now);
  const selectedRisk = host && fleet && !failure ? pressure(host, fleet, now) : null;
  const activeHistoryRequest = historyRequest?.id === selected ? historyRequest : null;
  const activeHistoryError = activeHistoryRequest?.error ?? "";
  const historyPending = activeHistoryRequest?.pending ?? false;
  const relatedIncident = host ? incidents.find(i => i.agent_id === host.id && i.status === "open") : undefined;

  function selectHost(id: string) {
    if (id === selected) return;
    selectWithTransition(() => {
      setSelected(id);
      setSelectionNotice("");
    });
  }

  return (
    <section aria-labelledby="fleet-title" className="fleet-section">
      <div className="host-inventory-summary">
        <div>
          <h2 id="fleet-title">{fleet ? `${fleet.online} of ${fleet.total} hosts online${failure ? " · cached" : ""}` : failure ? "Host inventory unavailable" : "Host inventory"}</h2>
          <p>Agent connectivity and resource limits are measured independently of endpoint health.</p>
        </div>
        {fleet && !failure && (
          <div className="host-summary-counts">
            {assessed ? (
              <>
                <div><strong>{counts.exceeded}</strong> Limit reached</div>
                <div><strong>{counts.near}</strong> Near limit</div>
                <div><strong>{counts.within}</strong> Within limit</div>
                <p>{assessed} of {hosts.length} loaded hosts assessed</p>
              </>
            ) : <span>No hosts assessed</span>}
          </div>
        )}
      </div>

      {failure && (
        <Notice tone="warning" role="alert">
          Host refresh failed: {failure}.{" "}
          {fleet
            ? `Showing stale cached values from ${stamp(fleet.observed_at)}; connectivity may have changed.`
            : "Fleet data is unavailable, not an empty fleet."}
        </Notice>
      )}

      <div className="fleet-workspace">
        <div className="fleet-list">
          <h2>Host inventory</h2>
          <div className="host-inventory-toolbar">
            <div className="host-search">
              <label className="sr-only" htmlFor="host-search">Search hosts</label>
              <Input id="host-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search hosts or ID…" />
            </div>
            <label className="sr-only" htmlFor="host-status-filter">Filter by host status</label>
            <select className="ui-input" id="host-status-filter" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="attention">Needs attention</option>
            </select>
            <span className="tiny">Highest risk first</span>
          </div>
          <div className="host-table-group">
            <div
              className="host-table-scroll"
              role="region"
              aria-label="Host inventory table, horizontally scrollable"
              tabIndex={0}
            >
              <table className="host-table">
                <caption className="sr-only">
                  Host connectivity, measured resources and last agent contact. Offline or stale samples are historical; missing measurements are unavailable, not zero.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Host</th>
                    <th scope="col">Agent</th>
                    <th scope="col">CPU / limit</th>
                    <th scope="col">Memory / limit</th>
                    <th scope="col">Disk / limit</th>
                    <th scope="col">Resource status</th>
                  </tr>
                </thead>
                <tbody>
                  {fleetLoading && <tr><td colSpan={6}><AsciiLoading label="Loading host inventory…" lines={3} widths={["85%", "77%", "82%"]} /></td></tr>}
                  {visible.map(({ host: h, risk }) => (
                    <tr key={h.id} className={selected === h.id ? "host-selected" : ""}>
                      <th scope="row">
                        <Button
                          variant="ghost"
                          aria-pressed={selected === h.id}
                          aria-controls="host-inspector"
                          onClick={() => selectHost(h.id)}
                        >
                          <WorkspaceIcon name="hosts" />{h.hostname}
                          <svg className="host-selection-arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" /></svg>
                          <span className="sr-only">
                            {selected === h.id ? ", selected" : ", inspect host"}
                          </span>
                        </Button>
                        <small>{h.version ? `Agent ${h.version}` : "Agent version unavailable"}</small>
                        {(failure || h.status === "offline" || stale(h)) && (
                          <small>
                            {failure ? "Cached" : h.sampled_at ? "Historical sample" : "No measurement"}
                            {h.sampled_at && (
                              <>
                                {" "}·{" "}
                                <time dateTime={h.sampled_at} title={stamp(h.sampled_at)}>
                                  {age(h.sampled_at, now)}
                                </time>
                              </>
                            )}
                          </small>
                        )}
                      </th>
                      <td>
                        <span
                          className={
                            failure
                              ? "measurement--unknown"
                              : h.status === "online"
                                ? "measurement--success"
                                : "measurement--warning"
                          }
                        >
                          {h.status === "online" ? "Online" : "Offline"}
                          {failure ? " (cached)" : ""}
                        </span>
                        <small><time dateTime={h.last_seen_at ?? undefined} title={stamp(h.last_seen_at)}>{age(h.last_seen_at, now)}</time></small>
                      </td>
                      {resources.map(({ key }) => {
                        const reading = fleet && !failure ? resourcePressure(h, fleet, now, key) : null;
                        const limit = fleet?.thresholds?.[key] ?? null;
                        return <td key={key}>
                          <span className={pressureClass(reading?.state)} aria-label={h[key] == null ? "No measurement" : undefined}>{percent(h[key])}{` / ${percent(limit)}`}</span>
                          {reading && key === "cpu_percent" && <small>{reading.headroom > 0 ? `${Number(reading.headroom.toFixed(1))} pp below limit` : reading.headroom < 0 ? `${Number((-reading.headroom).toFixed(1))} pp over limit` : "At limit"}</small>}
                        </td>;
                      })}
                      <td><span className={pressureClass(risk?.state)}>{risk ? pressureLabel[risk.state] : failure ? "Cached" : h.status === "offline" ? "Historical" : stale(h) ? "No fresh sample" : "Unavailable"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {fleet && !failure && !hosts.length && (
              <p className="empty">
                No hosts enrolled. Connect a server to see agent connectivity and measured resource usage.
              </p>
            )}
            {hosts.length > 0 && !visible.length && (
              <p className="empty" role="status">
                No hosts match these filters.{" "}
                <Button variant="ghost" onClick={() => { setQuery(""); setStatus("all"); }}>Clear filters</Button>
              </p>
            )}

            <p className="tiny fleet-coverage" role="status">
              {fleet && `${visible.length} of ${hosts.length} loaded · ${fleet.total} enrolled · Sorted by resource risk`}
            </p>

          </div>
          <p className="tiny fleet-freshness">
            {fleet && (
              <>
                Fleet observed <time dateTime={fleet.observed_at}>{stamp(fleet.observed_at)}</time>.{" "}
              </>
            )}
            Offline or stale samples stay in the inventory as historical readings. Resource status requires fresh telemetry.
          </p>
          {host && (
            <a className="inspector-jump" href="#host-inspector">
              View {host.hostname} details
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 3v14m-5-5 5 5 5-5" /></svg>
            </a>
          )}
          <section className="host-guidance">
            <div>
              <h2>Connect another server</h2>
              <p className="muted">Install the Linux agent to add this server’s resource signals to the fleet.</p>
            </div>
            <Button onClick={onConnect}><WorkspaceIcon name="terminal" />Agent installation</Button>
          </section>
        </div>

        <Panel className="host-inspector" id="host-inspector" role="region" aria-labelledby="host-inspector-title" tabIndex={-1}>
          <div className="panel-head">
            <h2 id="host-inspector-title" ref={inspectorHeading} tabIndex={-1}>{host ? host.hostname : "Host inspector"}</h2>
            {host && (
              <Badge tone={host.status === "online" && !failure ? "success" : "warning"}>
                {host.status === "online" ? "Online" : "Offline"}
                {failure ? " (cached)" : ""}
              </Badge>
            )}
          </div>

          {fleetLoading ? <AsciiLoading label="Loading host details…" />
            : !host ? (
            <p className="muted" role="status">
              {selectionNotice || "Select a host to inspect its observations and resource history."}
            </p>
          ) : (
            <>
              <div className="inspector-headline">
                {selectedRisk ? (
                  <>
                    <span>{selectedRisk.label}</span>
                    <p><strong>{percent(selectedRisk.value)}</strong> / {percent(selectedRisk.limit)} limit</p>
                    <Badge tone={selectedRisk.state === "exceeded" ? "danger" : selectedRisk.state === "near" ? "warning" : "neutral"}>{pressureLabel[selectedRisk.state]}</Badge>
                  </>
                ) : (
                  <>
                    <strong>Resource assessment unavailable</strong>
                    <p className="tiny">{failure ? "Cached fleet data" : host.status === "offline" ? "Offline; sample is historical" : stale(host) ? "No fresh sample" : "No configured comparable limit"}</p>
                  </>
                )}
              </div>
              <p className="tiny inspector-sample">
                Sample <time dateTime={host.sampled_at ?? undefined}>{stamp(host.sampled_at)}</time> ·{" "}
                {failure ? "Cached, not live" : host.status === "offline" ? "Historical, not live" : stale(host) ? "Stale / unavailable" : `Within ${fleet?.stale_after_seconds ?? 60}s freshness window`}
              </p>
              <h3>Resource history</h3>
              <div className="history-stage" id="host-history">
                <div className="history-modes" role="group" aria-label="History view">
                  <Button aria-pressed={historyMode === "resource"} aria-controls="host-history-chart" onClick={() => setHistoryMode("resource")}>Resource (%)</Button>
                  <Button aria-pressed={historyMode === "network"} aria-controls="host-history-chart" onClick={() => setHistoryMode("network")}>Network (Mb/s)</Button>
                </div>
                {historyMode === "resource" && (
                  <div className="inspector-resources" role="group" aria-label="Choose a resource to view its history">
                    {resources.map(({ key, label }) => (
                      <Button key={key} variant="ghost" aria-pressed={resource === key} onClick={() => setResource(key)}>
                        <span className="resource-label">{label}</span>
                      </Button>
                    ))}
                  </div>
                )}
                {historyPending && activeHistoryError ? (
                  <Notice tone="warning">Refreshing history. Cached history below is stale.</Notice>
                ) : activeHistoryError ? (
                  <Notice tone="warning">
                    Resource history refresh failed: {activeHistoryError}.{" "}
                    {history?.id === host.id ? "Cached history below is stale." : "History unavailable."}
                  </Notice>
                ) : null}
                <div id="host-history-chart">
                  {history?.id === host.id ? (
                    historyMode === "resource" ? (
                      <ResourceHistory key={host.id} samples={history.samples} resource={resource} />
                    ) : (
                      <NetworkHistory
                        key={host.id}
                        samples={history.samples}
                        maxInterval={fleet?.stale_after_seconds ?? 60}
                        current={!failure && !!fleet && hasFreshSample(host, fleet, now) && !activeHistoryError}
                        cached={!!failure || !!activeHistoryError}
                      />
                    )
                  ) : !activeHistoryError || historyPending ? (
                    <AsciiLoading label="Loading resource history…" variant="dither" lines={4} widths={["100%", "90%", "100%", "84%"]} />
                  ) : null}
                </div>
              </div>
              <HostSystemd key={host.id} hostId={host.id} refreshKey={refreshKey} />

              <section className="inspector-incident" aria-labelledby="related-incident-title">
                <h3 id="related-incident-title">Related incident</h3>
                {relatedIncident ? (
                  <>
                    <p>{relatedIncident.title}</p>
                    <Button variant="primary" onClick={() => onOpenIncident(relatedIncident.id)}>
                      Open investigation{" "}
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 12h14 M13 6l6 6-6 6" />
                      </svg>
                    </Button>
                  </>
                ) : openIncidents === null && !incidentsStale ? (
                  <AsciiLoading label="Loading related incidents…" />
                ) : (
                  <p className="muted small">{openIncidents === null ? "Related incident data is unavailable." : "No open incident for this host in the latest 100 records."}</p>
                )}
                {incidentsStale && openIncidents !== null && <p className="tiny">Cached incident records; the latest refresh failed.</p>}
                <p className="tiny">Measured signals only. No root cause inferred.</p>
              </section>

              <details className="host-metadata">
                <summary>Host identity &amp; last contact</summary>
                <p className="tiny">OS and capacity unavailable · Uptime: Not collected</p>
                <dl className="host-facts">
                  <dt>Host ID</dt>
                  <dd>{host.id}</dd>
                  <dt>Agent version</dt>
                  <dd>{host.version || "Unavailable"}</dd>
                  <dt>Last agent contact</dt>
                  <dd>
                    {stamp(host.last_seen_at)} · {age(host.last_seen_at, now)}
                  </dd>
                </dl>
              </details>
            </>
          )}
        </Panel>
      </div>

    </section>
  );
}
