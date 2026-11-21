"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import type { Host, HostList, HostMetric } from "@opspilot/contracts";
import { AsciiLoading } from "./ascii-card-reveal";
import { Badge, Button, ButtonLink, Input, Notice, Panel } from "./ui";
import { hasFreshSample, percent, pressure, resourcePressure, resources, type Resource } from "../lib/host-pressure";
import { WorkspaceIcon } from "./workspace-shell";
import { HostSystemd } from "./host-systemd";
import { deriveNetworkRates, type NetworkRatePoint } from "../lib/host-network";
import { api, ApiError } from "../lib/api";

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
  fleet: HostList | null;
  failure: string;
  openIncidents: number | null;
  incidentsStale: boolean;
  incidents: FleetIncident[];
  onOpenIncident: (id: string) => void;
  inspectHost: { id: string; resource?: Resource } | null;
  onInspectionHandled: (inspection: NonNullable<Props["inspectHost"]>) => void;
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

type HistoryMode = Resource | "all";

const networkSeries = [{ label: "RX (download)", legend: "RX" }, { label: "TX (upload)", legend: "TX" }] as const;
const formatRate = (value: number | null) => {
  if (value === null) return "Unavailable";
  return `${value > 0 && value < 0.001 ? "<0.001" : Number(value.toFixed(3))} Mb/s`;
};

function HistorySeriesLabel({ label, index }: { label: string; index: number }) {
  return <span className="history-series-label"><span data-series={index} aria-hidden="true" />{label}</span>;
}

function NetworkColumns({ rows, top, latestLabel }: {
  rows: readonly NetworkRatePoint[];
  top: number;
  latestLabel: string;
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
  const recorded = observation.rxMbps !== null;
  const status = index === latest ? latestLabel : recorded ? "Historical" : "Unavailable";
  const interval = observation.intervalSeconds;
  const valueText = recorded
    ? `${interval} seconds, RX (download) ${formatRate(observation.rxMbps)}, TX (upload) ${formatRate(observation.txMbps)}`
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
    <figure className="resource-history network-history">
      <figcaption><h3>Network traffic</h3><span>Estimated aggregate traffic · excludes loopback</span></figcaption>
      <div className="history-card">
        <div className="history-legend" role="group" aria-label="Newest interval">
          {networkSeries.map(({ label, legend }, i) => (
            <span key={label}><HistorySeriesLabel label={legend} index={i} /><strong>{formatRate(i === 0 ? newest.rxMbps : newest.txMbps)}</strong></span>
          ))}
        </div>
        <div className="history-reading">
          <div>
            <p>Selected interval</p>
            <p className="history-hint tiny">Hover or tap a column</p>
          </div>
          <div className="network-observation">
            <header>
              <span>{status}</span>
              <time dateTime={observation.sampledAt}>{stamp(observation.sampledAt)}</time>
              {recorded && interval != null && <span>{interval} s receipt interval</span>}
            </header>
            <dl>
              {networkSeries.map(({ label }, i) => (
                <div key={label}>
                  <dt><HistorySeriesLabel label={`${label}:`} index={i} /></dt>{" "}
                  <dd>{formatRate(i === 0 ? observation.rxMbps : observation.txMbps)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div
          className="network-plot"
          style={{ "--history-column": columnWidth } as CSSProperties}
          role="img"
          aria-label={`Estimated network traffic from ${stamp(rows[0].sampledAt)} to ${stamp(newest.sampledAt)}. RX and TX use the same Mb/s scale; missing intervals leave gaps.`}
          onPointerMove={event => {
            if (event.pointerType === "mouse") inspectAt(event.currentTarget, event.clientX);
          }}
          onClick={event => inspectAt(event.currentTarget, event.clientX)}
        >
          <div className="history-axis" aria-hidden="true">
            {rows.map(({ timestampMs, rxMbps, txMbps }, i) => rxMbps !== null && (
              <div
                className="history-column"
                key={i}
                style={{ left: span ? `${((timestampMs - start) / span) * 100}%` : "50%" }}
                data-selected={i === index}
              >
                {[rxMbps, txMbps].map((value, j) => value !== null && (
                  <span
                    key={j}
                    data-series={j}
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
        <p className="network-scale tiny">Scale per direction: 0–{formatRate(top)}</p>
      </div>
      <div className="history-scrubber">
        <label htmlFor={sliderId}>Inspect network interval</label>
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

const hasReading = (value: number | null): value is number => value != null && Number.isFinite(value);

function ResourceHistory({ samples, resource }: { samples: HostMetric[]; resource: HistoryMode }) {
  const instructionsId = useId();
  const marks = useRef<SVGGElement>(null);
  const [cursorTime, setCursorTime] = useState<string | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const [announceSelection, setAnnounceSelection] = useState(false);
  useEffect(() => {
    if (!showTooltip) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowTooltip(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [showTooltip]);
  const stacked = resource === "all";
  const series = stacked ? resources : resources.filter(r => r.key === resource);
  const title = stacked ? "Resource history" : `${series[0].label} utilization`;
  const rows = useMemo(() => samples
    .map(sample => ({ sample, timestamp: Date.parse(sample.sampled_at) }))
    .sort((a, b) => a.timestamp - b.timestamp), [samples]);
  if (!rows.length) {
    return <p className="empty">No {stacked ? "resource" : series[0].label} samples received yet. History is unavailable.</p>;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const duration = last.timestamp - first.timestamp;
  const svgWidth = 548;
  const svgHeight = 232;
  const left = 54;
  const width = 528 - left;
  const top = 16;
  const height = 180;
  const max = stacked ? 300 : 100;
  const x = (t: number) => left + ((t - first.timestamp) / (duration || 1)) * width;
  const y = (n: number) => top + height * (1 - n / max);
  const baseline = y(0);
  const cursorIndex = rows.findIndex(({ sample }) => sample.sampled_at === cursorTime);
  const index = cursorIndex < 0 ? rows.length - 1 : cursorIndex;
  const observation = rows[index].sample;
  const observationTime = stamp(observation.sampled_at);
  const readings = series.map(({ key, label }) => {
    const reading = observation[key];
    const value = hasReading(reading) ? reading : null;
    return { key, label, value, text: value === null ? "Unavailable" : percent(value) };
  });
  const measured = readings.filter(({ value }) => value !== null).length;
  const partial = stacked && measured > 0 && measured < series.length;

  let interval = 15000;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].timestamp - rows[i - 1].timestamp;
    if (gap > 0) interval = Math.min(interval, gap);
  }
  const barWidth = Math.min(24, duration ? (width * interval) / duration * 0.72 : 24);
  const measuredSamples = rows.filter(({ sample }) => series.some(({ key }) => hasReading(sample[key]))).length;
  const time = (s: string) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const columnX = x(rows[index].timestamp);

  function inspectPoint(svg: SVGSVGElement, clientX: number, clientY: number, hover: boolean) {
    const bounds = svg.getBoundingClientRect();
    const position = (clientX - bounds.left) / bounds.width * svgWidth;
    const vertical = (clientY - bounds.top) / bounds.height * svgHeight;
    if (vertical < top || vertical > baseline) {
      setShowTooltip(false);
      return;
    }
    const timestamp = first.timestamp + Math.max(0, Math.min(1, (position - left) / width)) * duration;
    let nearest = 0;
    for (let i = 1; i < rows.length; i++) {
      if (Math.abs(rows[i].timestamp - timestamp) < Math.abs(rows[nearest].timestamp - timestamp)) nearest = i;
    }
    const distance = Math.abs(position - x(rows[nearest].timestamp));
    const hit = hover ? distance <= barWidth / 2 + 2 : position >= left - barWidth && position <= left + width + barWidth;
    setShowTooltip(hover && hit);
    if (hit) {
      if (!hover || !showTooltip) marks.current?.getAnimations()[0]?.finish();
      setAnnounceSelection(false);
      setCursorTime(rows[nearest].sample.sampled_at);
    }
  }

  const observationContent = (
    <>
      <div className="history-observation-meta">
        <time dateTime={observation.sampled_at}>{observationTime}</time>
        {partial && <span>Partial observation</span>}
      </div>
      <dl className="history-readings">
        {readings.map(({ key, label, value, text }) => (
          <div key={key} data-series={key}>
            <dt>{label}</dt>
            <dd className={value === null ? "measurement--unknown" : undefined}>{text}</dd>
          </div>
        ))}
      </dl>
    </>
  );

  return (
    <figure className="resource-history">
      <figcaption>
        <h3>{title}</h3>
        <span>{duration ? `${Math.round(duration / 60000)} min` : "Single sample"} · Raw samples</span>
      </figcaption>
      <p className="history-instructions tiny" id={instructionsId}>
        {rows.length > 1 ? "Hover or tap a bar, or use arrow keys on the chart." : "Hover or tap the bar to inspect its sample."}
      </p>
      {stacked && <p className="history-scale tiny">Stack height (percentage points) · Not overall host utilization</p>}
      <div
        className="history-plot"
        role="group"
        aria-label={`${title} chart`}
        aria-describedby={instructionsId}
        tabIndex={rows.length > 1 ? 0 : undefined}
        onKeyDown={event => {
          const next = event.key === "ArrowLeft" ? Math.max(index - 1, 0)
            : event.key === "ArrowRight" ? Math.min(index + 1, rows.length - 1)
            : event.key === "Home" ? 0
            : event.key === "End" ? rows.length - 1
            : null;
          if (next === null) return;
          event.preventDefault();
          marks.current?.getAnimations()[0]?.finish();
          setShowTooltip(false);
          setAnnounceSelection(true);
          setCursorTime(rows[next].sample.sampled_at);
        }}
      >
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          role="img"
          aria-label={`${title}, 0 to ${max} ${stacked ? "percentage points" : "percent"}. ${measuredSamples} samples with measurements from ${stamp(first.sample.sampled_at)} to ${stamp(last.sample.sampled_at)}. Each column is one observation; missing intervals remain empty.`}
          onPointerMove={event => {
            if (event.pointerType === "mouse") inspectPoint(event.currentTarget, event.clientX, event.clientY, true);
          }}
          onClick={event => {
            const mouse = "pointerType" in event.nativeEvent && event.nativeEvent.pointerType === "mouse";
            inspectPoint(event.currentTarget, event.clientX, event.clientY, mouse);
          }}
          onPointerLeave={() => setShowTooltip(false)}
        >
          {(stacked ? [0, 100, 200, 300] : [0, 50, 100]).map(value => (
            <g key={value}>
              <text x="0" y={y(value) + 4}>{value}{stacked ? "" : "%"}</text>
              <line x1={left - 14} x2="544" y1={y(value)} y2={y(value)} className="chart-grid" />
            </g>
          ))}
          <g
            key={resource}
            ref={marks}
            className="history-marks"
            style={{ transformOrigin: `0 ${baseline}px` }}
          >
            {rows.map(({ sample, timestamp }, rowIndex) => {
              const center = x(timestamp);
              let level = 0;
              let hasZero = false;
              const segments = series.map(({ key }) => {
                const value = sample[key];
                if (!hasReading(value)) return null;
                if (value === 0) {
                  hasZero = true;
                  return null;
                }
                level += value;
                return (
                  <rect
                    key={key}
                    x={center - barWidth / 2}
                    y={y(level)}
                    width={barWidth}
                    height={height * value / max}
                    rx={stacked ? undefined : 1.5}
                    className="chart-bar"
                    data-series={key}
                  />
                );
              });
              return (
                <g key={sample.sampled_at}>
                  {segments}
                  {level === 0 && hasZero && (
                    <line x1={center - barWidth / 2} x2={center + barWidth / 2} y1={baseline} y2={baseline} className="chart-zero" />
                  )}
                  {rowIndex === index && measured > 0 && (
                    <rect
                      x={center - barWidth / 2 - 1.5}
                      y={y(level) - 2}
                      width={barWidth + 3}
                      height={baseline - y(level) + 4}
                      rx="2"
                      className="chart-selection"
                    />
                  )}
                </g>
              );
            })}
          </g>
          {measured === 0 && <line x1={columnX} x2={columnX} y1={top} y2={baseline} className="chart-cursor" />}
          <text x={left} y="224">{time(first.sample.sampled_at)}</text>
          {duration > 0 && <text x={left + width} y="224" textAnchor="end">{time(last.sample.sampled_at)}</text>}
        </svg>
        {showTooltip && (
          <div
            className="history-tooltip"
            data-side={columnX > svgWidth / 2 ? "left" : "right"}
            aria-hidden="true"
            style={{
              "--column-x": `${columnX / svgWidth * 100}%`,
              "--column-y": `${y(readings.reduce((level, { value }) => level + (value ?? 0), 0)) / svgHeight * 100}%`,
            } as CSSProperties}
          >
            {observationContent}
          </div>
        )}
      </div>
      <div className="history-observation">
        <span className="history-observation-label">Selected sample</span>
        {observationContent}
      </div>
      <p className="sr-only" role="status">
        {announceSelection && `${observationTime}${partial ? ", partial observation" : ""}: ${readings.map(({ label, text }) => `${label} ${text}`).join(", ")}. Sample ${index + 1} of ${rows.length}.`}
      </p>
      <p className="tiny history-provenance">
        {measuredSamples} samples with measurements · No aggregation · {Intl.DateTimeFormat().resolvedOptions().timeZone}
        <br />
        <time dateTime={first.sample.sampled_at}>{stamp(first.sample.sampled_at)}</time> –{" "}
        <time dateTime={last.sample.sampled_at}>{stamp(last.sample.sampled_at)}</time>
      </p>
      {!measuredSamples && <p>{stacked ? "Resource" : series[0].label} measurements unavailable for this range.</p>}
    </figure>
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
    const rows = deriveNetworkRates(samples, maxInterval);
    let top = 0;
    for (const { rxMbps, txMbps } of rows) top = Math.max(top, rxMbps ?? 0, txMbps ?? 0);
    return { rows, top };
  }, [samples, maxInterval]);
  if (!rows.some(row => row.rxMbps !== null)) {
    return <p className="empty">Network rates unavailable — two usable samples are required.</p>;
  }
  const latest = rows[rows.length - 1];
  const latestLabel = latest.rxMbps === null ? "Latest interval unavailable"
    : cached ? "Cached"
      : current && now - latest.timestampMs <= maxInterval * 1000 ? "Latest interval" : "Historical";
  return <NetworkColumns rows={rows} top={top || 1} latestLabel={latestLabel} />;
}

export function HostWorkspace({
  refreshKey,
  fleet,
  failure,
  openIncidents,
  incidentsStale,
  incidents,
  onOpenIncident,
  inspectHost,
  onInspectionHandled,
}: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [appliedInspection, setAppliedInspection] = useState<Props["inspectHost"]>(null);
  const [history, setHistory] = useState<{ id: string; samples: HostMetric[] } | null>(null);
  const [historyRequest, setHistoryRequest] = useState<{ id: string; pending: boolean; error: string | null } | null>(null);
  const [historyMode, setHistoryMode] = useState<"resource" | "network">("resource");
  const [resource, setResource] = useState<HistoryMode>("cpu_percent");
  const [now, setNow] = useState(Date.now());
  const inspectorHeading = useRef<HTMLHeadingElement>(null);

  const hosts = fleet?.hosts ?? [];
  const rows = hosts.map(host => ({ host, risk: fleet && !failure ? pressure(host, fleet, now) : null }));
  rows.sort((a, b) => (a.risk?.headroom ?? Infinity) - (b.risk?.headroom ?? Infinity));

  if (inspectHost && inspectHost !== appliedInspection) {
    setAppliedInspection(inspectHost);
    setSelected(inspectHost.id);
    setSelectionNotice("");
    setResource(inspectHost.resource ?? "cpu_percent");
    setHistoryMode("resource");
  } else if (rows.length && selected === undefined) {
    setSelected(rows[0].host.id);
  } else if (fleet && selected && !fleet.hosts.some(host => host.id === selected)) {
    setSelected(null);
    setSelectionNotice("The selected host is no longer in the loaded host list. Select another host.");
  }

  useEffect(() => {
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    // Keep cached history for same-host retries, but never carry it across host changes.
    setHistory(previous => previous?.id === selected ? previous : null);
    setHistoryRequest(previous => previous?.id === selected ? previous : null);
    if (!selected) return;
    const hostId = selected;
    let active = true;
    let pending = false;
    const controller = new AbortController();

    async function load() {
      if (pending) return;
      pending = true;
      setHistoryRequest(previous => ({ id: hostId, pending: true, error: previous?.id === hostId ? previous.error : null }));
      try {
        const samples: HostMetric[] = await api(`/hosts/${hostId}/metrics`, "GET", undefined, controller.signal);
        if (active) {
          setHistory({ id: hostId, samples });
          setHistoryRequest({ id: hostId, pending: false, error: null });
        }
      } catch (e) {
        if (active && !(e instanceof ApiError && e.status === 401)) {
          setHistoryRequest({ id: hostId, pending: false, error: e instanceof Error ? e.message : String(e) });
        }
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
  }, [selected, refreshKey]);

  useEffect(() => {
    if (!inspectHost) return;
    const frame = window.requestAnimationFrame(() => {
      inspectorHeading.current?.closest(".host-inspector")?.scrollIntoView({ block: "start" });
      inspectorHeading.current?.focus({ preventScroll: true });
      onInspectionHandled(inspectHost);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inspectHost, onInspectionHandled]);

  const fleetLoading = !fleet && !failure;
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
            <ButtonLink href="/connect"><WorkspaceIcon name="terminal" />Agent installation</ButtonLink>
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
            <div className="host-inspector-body">
              <div className="inspector-history">
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
                  Latest sample <time dateTime={host.sampled_at ?? undefined}>{stamp(host.sampled_at)}</time> ·{" "}
                  {failure
                    ? "Cached, not live"
                    : host.status === "offline"
                      ? "Historical, not live"
                      : stale(host)
                        ? "Stale / unavailable"
                        : `Within ${fleet?.stale_after_seconds ?? 60}s freshness window`}
                </p>
                <div className="history-stage">
                  <div className="history-modes" role="group" aria-label="History view">
                    <Button aria-pressed={historyMode === "resource"} aria-controls="host-history-chart" onClick={() => setHistoryMode("resource")}>Resource (%)</Button>
                    <Button aria-pressed={historyMode === "network"} aria-controls="host-history-chart" onClick={() => setHistoryMode("network")}>Network (Mb/s)</Button>
                  </div>
                  {historyMode === "resource" && (
                    <div className="inspector-resources" role="group" aria-label="Resource history">
                      {resources.map(({ key, label }) => (
                        <Button key={key} variant="ghost" aria-pressed={resource === key} aria-controls="host-history-chart" onClick={() => setResource(key)}>
                          <span className="resource-label">{label}</span>
                          <span
                            className={`resource-value ${pressureClass(fleet && !failure ? resourcePressure(host, fleet, now, key)?.state : undefined)}`}
                            aria-label={host[key] == null ? "No measurement" : undefined}
                          >
                            {percent(host[key])}
                          </span>
                        </Button>
                      ))}
                      <Button variant="ghost" aria-pressed={resource === "all"} aria-controls="host-history-chart" onClick={() => setResource("all")}>
                        <span className="resource-label">All</span>
                        <span className="resource-mode">Stacked</span>
                      </Button>
                    </div>
                  )}
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
                        <ResourceHistory key={host.id} samples={history.samples} resource={resource} />
                      ) : (
                        <NetworkHistory
                          key={host.id}
                          samples={history.samples}
                          maxInterval={fleet?.stale_after_seconds ?? 60}
                          current={!failure && !stale(host) && !activeHistoryError}
                          cached={!!failure || !!activeHistoryError}
                          now={now}
                        />
                      )
                    ) : !activeHistoryError || historyPending ? (
                      <AsciiLoading label="Loading resource history…" variant="dither" lines={4} widths={["100%", "90%", "100%", "84%"]} />
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="inspector-context">
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
              </div>
            </div>
          )}
        </Panel>
      </div>

    </section>
  );
}
