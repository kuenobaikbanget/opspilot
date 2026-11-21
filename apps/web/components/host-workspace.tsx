"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
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

type HistoryPoint = {
  sampledAt: string;
  timestampMs: number;
  values: readonly (number | null)[];
  intervalSeconds?: number | null;
};

const networkSeries = [{ label: "RX (download)", legend: "RX" }, { label: "TX (upload)", legend: "TX" }] as const;
const formatRate = (value: number | null) => {
  if (value === null) return "Unavailable";
  return `${value > 0 && value < 0.001 ? "<0.001" : Number(value.toFixed(3))} Mb/s`;
};

function HistorySeriesLabel({ label, index }: { label: string; index: number }) {
  return <span className="history-series-label"><span data-series={index} aria-hidden="true" />{label}</span>;
}

function HistoryColumns({
  rows, title, caption, series, top, format, latestLabel, network, activeSeries, onSeriesChange,
}: {
  rows: readonly HistoryPoint[];
  title: string;
  caption: string;
  series: readonly { label: string; legend?: string }[];
  top: number;
  format: (value: number | null) => string;
  latestLabel: string;
  network?: boolean;
  activeSeries?: number;
  onSeriesChange?: (index: number) => void;
}) {
  const sliderId = useId();
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const latest = rows.length - 1;
  const cursorIndex = rows.findIndex(row => row.timestampMs === cursorTime);
  const index = cursorIndex < 0 ? latest : cursorIndex;
  const observation = rows[index];
  const newest = rows[latest];
  const start = rows[0].timestampMs;
  const end = newest.timestampMs;
  const span = end - start;
  const recorded = observation.values.some(value => value !== null);
  const status = index === latest ? latestLabel : recorded ? "Historical" : "Unavailable";
  const interval = observation.intervalSeconds;
  const valueText = recorded
    ? `${interval != null ? `${interval} seconds, ` : ""}${series.map(({ label }, i) => `${label} ${format(observation.values[i])}`).join(", ")}`
    : "Unavailable";
  const showSeconds = span < 180_000;
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(undefined, {
    hour: "2-digit", minute: "2-digit", ...(showSeconds ? { second: "2-digit" } : {}),
  }), [showSeconds]);
  const marks = span >= 180_000 ? [start, start + span / 3, end - span / 3, end] : span ? [start, end] : [start];
  const columnWidth = useMemo(() => {
    let spacing = span;
    for (let i = 1; i < rows.length; i++) {
      const delta = rows[i].timestampMs - rows[i - 1].timestampMs;
      if (delta > 0) spacing = Math.min(spacing, delta);
    }
    // Cap the mark width so a data gap doesn't turn adjacent observations into wide blocks.
    return span ? `min(${(75 * spacing) / span}%, 3.5rem)` : "3.5rem";
  }, [rows, span]);

  function select(index: number) {
    setCursorTime(index === latest ? null : rows[index].timestampMs);
  }

  function inspectAt(track: HTMLDivElement, clientX: number) {
    const axis = track.firstElementChild!.getBoundingClientRect();
    const cursor = start + span * Math.max(0, Math.min(1, (clientX - axis.left) / axis.width));
    let nearest = 0;
    for (let i = 1; i < rows.length; i++) {
      if (Math.abs(rows[i].timestampMs - cursor) < Math.abs(rows[nearest].timestampMs - cursor)) nearest = i;
    }
    select(nearest);
  }

  return (
    <figure className={`resource-history${network ? " network-history" : ""}`}>
      <figcaption><h3>{title}</h3><span>{caption}</span></figcaption>
      <div className="history-card">
        <div className="history-legend" role="group" aria-label={network ? "Newest interval" : "Emphasize a resource"}>
          {series.map(({ label, legend }, i) => {
            const content = <><HistorySeriesLabel label={legend ?? label} index={i} /><strong>{format(newest.values[i])}</strong></>;
            return onSeriesChange ? (
              <Button key={label} variant="ghost" aria-pressed={activeSeries === i} onClick={() => onSeriesChange(i)}>
                {content}
              </Button>
            ) : <span key={label}>{content}</span>;
          })}
        </div>
        <div className="history-reading">
          <div>
            <p>Selected {network ? "interval" : "sample"}</p>
            <p className="history-hint tiny">Hover or tap a column</p>
          </div>
          <div className="history-observation">
            <header>
              <span>{status}</span>
              <time dateTime={observation.sampledAt}>{stamp(observation.sampledAt)}</time>
              {recorded && interval != null && <span>{interval} s receipt interval</span>}
            </header>
            <dl>
              {series.map(({ label }, i) => (
                <div key={label}>
                  <dt><HistorySeriesLabel label={`${label}:`} index={i} /></dt>{" "}
                  <dd>{format(observation.values[i])}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div
          className="history-plot"
          style={{ "--history-column": columnWidth } as CSSProperties}
          role="img"
          aria-label={`${title} from ${stamp(rows[0].sampledAt)} to ${stamp(newest.sampledAt)}. Each segment uses its own scale; missing readings leave gaps.`}
          onPointerMove={event => {
            if (event.pointerType === "mouse") inspectAt(event.currentTarget, event.clientX);
          }}
          onClick={event => inspectAt(event.currentTarget, event.clientX)}
        >
          <div className="history-axis" aria-hidden="true">
            {rows.map(({ timestampMs, values }, i) => values.some(value => value !== null) && (
              <div
                className="history-column"
                key={i}
                style={{ left: span ? `${((timestampMs - start) / span) * 100}%` : "50%" }}
                data-selected={i === index}
              >
                {values.map((value, j) => value !== null && (
                  <span
                    key={j}
                    data-series={j}
                    data-emphasized={j === activeSeries}
                    style={{ height: `max(2px, ${Math.min(value / top, 1) * 2.5}rem)` }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="history-time-labels" aria-hidden="true">
          {marks.map(timestamp => <span key={timestamp}>{timeFormat.format(timestamp)}</span>)}
        </div>
        <p className="history-scale tiny">Scale per metric: 0–{format(top)}</p>
      </div>
      <div className="history-scrubber">
        <label htmlFor={sliderId}>Inspect {network ? "network interval" : "observation"}</label>
        <span>{index + 1} / {rows.length}</span>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={latest}
          value={index}
          disabled={latest === 0}
          onChange={event => select(Number(event.target.value))}
          aria-valuetext={`${stamp(observation.sampledAt)}: ${valueText}`}
        />
      </div>
    </figure>
  );
}

function ResourceHistory({ samples, resource, onResourceChange }: {
  samples: HostMetric[];
  resource: Resource;
  onResourceChange: (resource: Resource) => void;
}) {
  const rows = useMemo(() => samples
    .map(sample => ({
      sampledAt: sample.sampled_at,
      timestampMs: Date.parse(sample.sampled_at),
      values: resources.map(({ key }) => Number.isFinite(sample[key]) ? sample[key] : null),
    }))
    .filter(row => Number.isFinite(row.timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs), [samples]);
  if (!rows.some(row => row.values.some(value => value !== null))) {
    return <p className="empty">No resource samples received yet. History is unavailable.</p>;
  }
  const latest = rows[rows.length - 1];
  return (
    <HistoryColumns
      rows={rows}
      title="Resource utilization"
      caption="Raw samples · no aggregation"
      series={resources}
      top={100}
      format={value => value === null ? "Unavailable" : percent(value)}
      latestLabel={latest.values.some(value => value !== null) ? "Newest sample" : "Newest sample unavailable"}
      activeSeries={resources.findIndex(({ key }) => key === resource)}
      onSeriesChange={index => onResourceChange(resources[index].key)}
    />
  );
}

function NetworkHistory({ samples, maxInterval, current, cached, now }: {
  samples: HostMetric[];
  maxInterval: number;
  current: boolean;
  cached: boolean;
  now: number;
}) {
  const { rows, top } = useMemo(() => {
    let top = 0;
    const rows = deriveNetworkRates(samples, maxInterval).map(({ rxMbps, txMbps, ...point }) => {
      top = Math.max(top, rxMbps ?? 0, txMbps ?? 0);
      return { ...point, values: [rxMbps, txMbps] };
    });
    return { rows, top };
  }, [samples, maxInterval]);
  if (!rows.some(row => row.values[0] !== null)) {
    return <p className="empty">Network rates unavailable — two usable samples are required.</p>;
  }
  const latest = rows[rows.length - 1];
  const latestLabel = latest.values[0] === null ? "Latest interval unavailable"
    : cached ? "Cached"
      : current && now - latest.timestampMs <= maxInterval * 1000 ? "Latest interval" : "Historical";
  return (
    <HistoryColumns
      rows={rows}
      title="Network traffic"
      caption="Estimated aggregate traffic · excludes loopback"
      series={networkSeries}
      top={top || 1}
      format={formatRate}
      latestLabel={latestLabel}
      network
    />
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
                {historyPending && activeHistoryError && history?.id === host.id ? (
                  <Notice tone="warning">Refreshing history. Cached history below is stale.</Notice>
                ) : !historyPending && activeHistoryError ? (
                  <Notice tone="warning">
                    Resource history refresh failed: {activeHistoryError}.{" "}
                    {history?.id === host.id ? "Cached history below is stale." : "History unavailable."}
                  </Notice>
                ) : null}
                <div id="host-history-chart">
                  {history?.id === host.id ? (
                    historyMode === "resource" ? (
                      <ResourceHistory key={host.id} samples={history.samples} resource={resource} onResourceChange={setResource} />
                    ) : (
                      <NetworkHistory
                        key={host.id}
                        samples={history.samples}
                        maxInterval={fleet?.stale_after_seconds ?? 60}
                        current={!failure && !!fleet && hasFreshSample(host, fleet, now) && !activeHistoryError}
                        cached={!!failure || !!activeHistoryError}
                        now={now}
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
