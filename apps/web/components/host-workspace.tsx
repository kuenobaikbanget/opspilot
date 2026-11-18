"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AgentInstallConfig, Host, HostList, HostMetric } from "@opspilot/contracts";
import { Badge, Button, Input, Notice, Panel } from "./ui";
import { buildAgentInstallCommand } from "../lib/agent-install";

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
  onHosts: (hosts: Host[]) => void;
  selected: string | null;
  onSelectHost: (id: string | null) => void;
  onUnauthorized: () => void;
  openIncidents: number;
  incidents: FleetIncident[];
  onOpenIncident: (id: string) => void;
  enrollmentOpen: boolean;
  onCloseEnrollment: () => void;
};

type Resource = "cpu_percent" | "memory_percent" | "disk_percent";

const resources = [
  { key: "cpu_percent", label: "CPU" },
  { key: "memory_percent", label: "Memory" },
  { key: "disk_percent", label: "Disk" },
] as const;

const percent = (n: number | null) =>
  n == null || !Number.isFinite(n) ? "—" : `${Number(n.toFixed(1))}%`;

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

const measurementClass = (n: number | null) =>
  n == null || !Number.isFinite(n)
    ? "measurement--unknown"
    : n > 90
      ? "measurement--danger"
      : n > 75
        ? "measurement--warning"
        : "";

function selectWithTransition(update: () => void) {
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce), (max-width: 700px)").matches) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
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
        <strong className={measurementClass(observation[resource])}>{percent(observation[resource])}</strong>
        <time dateTime={observation.sampled_at}>{stamp(observation.sampled_at)}</time>
      </div>
      <svg
        viewBox="0 0 548 232"
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
            <text x="0" y={y(value) + 4}>{value}%</text>
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
            className={`chart-bar ${measurementClass(r[resource])}`}
            data-active={r.sampled_at === observation.sampled_at}
          >
            <title>{stamp(r.sampled_at)} · {percent(r[resource])}</title>
          </rect>
        ))}
        <line x1={cursorX} x2={cursorX} y1="16" y2="196" className="chart-cursor" />
        {measured && <circle cx={cursorX} cy={y(observation[resource])} r="4" className="chart-cursor-point" />}
        <text x="48" y="224">{time(rows[0].sampled_at)}</text>
        {duration > 0 && (
          <text x="528" y="224" textAnchor="end">{time(rows[rows.length - 1].sampled_at)}</text>
        )}
      </svg>
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

export function HostWorkspace({
  refreshKey,
  onHosts,
  selected,
  onSelectHost,
  onUnauthorized,
  openIncidents,
  incidents,
  onOpenIncident,
  enrollmentOpen,
  onCloseEnrollment,
}: Props) {
  const [fleet, setFleet] = useState<HostList | null>(null);
  const [failure, setFailure] = useState("");
  const [query, setQuery] = useState("");
  const [selectionNotice, setSelectionNotice] = useState("");
  const selectedRef = useRef(selected);
  const loadedOnce = useRef(false);
  selectedRef.current = selected;
  const [history, setHistory] = useState<{ id: string; samples: HostMetric[] } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [resource, setResource] = useState<Resource>("disk_percent");
  const [now, setNow] = useState(Date.now());
  const [token, setToken] = useState<{ command: string; expires: number } | null>(null);
  const tokenRef = useRef(token);
  const generation = useRef(0);
  const tokenController = useRef<AbortController | null>(null);
  const enrollmentVisible = useRef(enrollmentOpen);
  enrollmentVisible.current = enrollmentOpen;
  const [enrolling, setEnrolling] = useState(false);
  const enrollmentPanel = useRef<HTMLElement>(null);
  const [enrollError, setEnrollError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [installConfig, setInstallConfig] = useState<AgentInstallConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState("");
  const callbacks = useRef({ onHosts, onSelectHost, onUnauthorized });
  callbacks.current = { onHosts, onSelectHost, onUnauthorized };

  const clearSecret = useCallback(() => {
    generation.current++;
    tokenController.current?.abort();
    tokenController.current = null;
    tokenRef.current = null;
    setToken(null);
    setCopied(false);
    setCopyError("");
    setEnrollError("");
    setEnrolling(false);
  }, []);

  const unauthorized = useCallback(() => {
    enrollmentVisible.current = false;
    clearSecret();
    callbacks.current.onUnauthorized();
  }, [clearSecret]);

  useEffect(() => {
    clearSecret();
    setInstallConfig(null);
    setConfigError("");
    setConfigLoading(enrollmentOpen);
    if (!enrollmentOpen) return;
    let active = true;
    const controller = new AbortController();
    void request("/agents/install-config", controller.signal).then((config: AgentInstallConfig) => {
      if (active && enrollmentVisible.current) setInstallConfig(config);
    }).catch((e: unknown) => {
      if (!active || !enrollmentVisible.current) return;
      const message = e instanceof Error ? e.message : String(e);
      if (message === "Unauthorized") unauthorized();
      else setConfigError(message);
    }).finally(() => {
      if (active) setConfigLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
      clearSecret();
    };
  }, [enrollmentOpen, clearSecret, unauthorized]);

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
        callbacks.current.onHosts(next.hosts);
        if (!loadedOnce.current) {
          loadedOnce.current = true;
          callbacks.current.onSelectHost(next.hosts[0]?.id ?? null);
        }
        if (selectedRef.current && !next.hosts.some(h => h.id === selectedRef.current)) {
          callbacks.current.onSelectHost(null);
          setSelectionNotice("The selected host is no longer in the loaded host list. Select another host.");
        }
      } catch (e) {
        if (!active) return;
        const message = e instanceof Error ? e.message : String(e);
        if (message === "Unauthorized") unauthorized();
        else setFailure(message);
      } finally {
        pending = false;
      }
    }

    void load();
    const poll = setInterval(() => void load(), 10000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [refreshKey, unauthorized]);

  useEffect(() => {
    setHistory(null);
    setHistoryError("");
    if (!selected) return;
    let active = true;
    let pending = false;
    const controller = new AbortController();

    async function load() {
      if (pending) return;
      pending = true;
      try {
        const samples: HostMetric[] = await request(`/hosts/${selected}/metrics`, controller.signal);
        if (active) {
          setHistory({ id: selected!, samples });
          setHistoryError("");
        }
      } catch (e) {
        if (!active) return;
        const message = e instanceof Error ? e.message : String(e);
        if (message === "Unauthorized") unauthorized();
        else setHistoryError(message);
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
  }, [selected, unauthorized]);

  useEffect(() => {
    if (token && now >= token.expires) clearSecret();
  }, [now, token, clearSecret]);

  useEffect(() => {
    if (enrollmentOpen) {
      enrollmentPanel.current?.focus();
      enrollmentPanel.current?.scrollIntoView({ block: "start" });
    }
  }, [enrollmentOpen]);

  const hosts = fleet?.hosts ?? [];
  const visible = hosts.filter(h => `${h.hostname} ${h.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const host = hosts.find(h => h.id === selected);
  const stale = (h: Host) => !h.sampled_at || now - Date.parse(h.sampled_at) > (fleet?.stale_after_seconds ?? 60) * 1000;
  const relatedIncident = host ? incidents.find(i => i.agent_id === host.id && i.status === "open") : undefined;
  const drift = incidents.find(i => i.category === "config_drift");

  function selectHost(id: string) {
    if (id === selected) return;
    selectWithTransition(() => {
      onSelectHost(id);
      setSelectionNotice("");
    });
  }

  async function enroll() {
    if (!enrollmentVisible.current || !installConfig) return;
    clearSecret();
    const current = generation.current;
    const controller = new AbortController();
    tokenController.current = controller;
    setEnrolling(true);
    try {
      const result = await request("/agents/enrollment-token", controller.signal, "POST");
      if (current !== generation.current || !enrollmentVisible.current) return;
      const next = {
        command: buildAgentInstallCommand(installConfig, result.token),
        expires: Date.now() + result.expiresInSeconds * 1000,
      };
      tokenRef.current = next;
      setToken(next);
    } catch (e) {
      if (current !== generation.current || !enrollmentVisible.current) return;
      const message = e instanceof Error ? e.message : String(e);
      if (message === "Unauthorized") unauthorized();
      else setEnrollError(message);
    } finally {
      if (current === generation.current) setEnrolling(false);
    }
  }

  async function copyCommand() {
    const secret = tokenRef.current;
    if (!secret || !enrollmentVisible.current) return;
    if (Date.now() >= secret.expires) {
      clearSecret();
      return;
    }
    const current = generation.current;
    setCopied(false);
    setCopyError("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(secret.command);
      if (current === generation.current && enrollmentVisible.current && Date.now() < secret.expires) setCopied(true);
    } catch {
      if (current === generation.current && enrollmentVisible.current && Date.now() < secret.expires) {
        setCopyError("Clipboard unavailable. Select and copy the install command manually.");
      }
    }
  }

  function closeEnrollment() {
    enrollmentVisible.current = false;
    clearSecret();
    onCloseEnrollment();
  }

  return (
    <section aria-labelledby="fleet-title" className="fleet-section">
      <div className="fleet-summary" aria-label="Fleet summary">
        <div className="fleet-summary-primary">
          <span className="summary-label">Hosts online</span>
          <strong className={failure ? undefined : "measurement--success"}>
            {fleet ? <>{fleet.online}<span className="summary-denominator"> / {fleet.total}</span></> : "—"}
          </strong>
          <small>fleet{failure ? " · cached" : ""}</small>
        </div>
        <div>
          <span className="summary-label">Open host incidents</span>
          <strong className={openIncidents ? "measurement--warning" : undefined}>{openIncidents}</strong>
          <small>latest 100</small>
        </div>
        <div>
          <span className="summary-label">Endpoints up</span>
          <strong className="measurement--unknown">—</strong>
          <small>Monitoring unavailable</small>
        </div>
        <div>
          <span className="summary-label">Endpoints failing</span>
          <strong className="measurement--unknown">—</strong>
          <small>Monitoring unavailable</small>
        </div>
      </div>

      {failure && (
        <Notice tone="warning" role="alert">
          Host refresh failed: {failure}.{" "}
          {fleet
            ? `Showing stale cached values from ${stamp(fleet.observed_at)}; connectivity may have changed.`
            : "Fleet data is unavailable, not an empty fleet."}
        </Notice>
      )}

      {hosts.length > 0 && (
        <div className="fleet-signals" role="group" aria-label="Select a loaded host">
          {hosts.map(h => (
            <Button
              key={h.id}
              variant="ghost"
              className="fleet-signal"
              aria-pressed={selected === h.id}
              aria-controls="host-inspector"
              aria-label={`${h.hostname}, ${h.status}${failure ? ", cached" : ""}, inspect host`}
              title={`${h.hostname} · ${h.status}${failure ? " (cached)" : ""} · Last contact ${stamp(h.last_seen_at)}`}
              onClick={() => selectHost(h.id)}
            >
              <span className="signal-track" aria-hidden="true">
                <span className={failure ? "measurement--unknown" : h.status === "online" ? "measurement--success" : "measurement--warning"} />
              </span>
              <span className="signal-hostname">{h.hostname}</span>
              <span className="signal-status">{h.status === "online" ? "Online" : "Offline"}{failure ? " · cached" : ""}</span>
            </Button>
          ))}
        </div>
      )}

      <div className="fleet-workspace">
        <div className="fleet-list">
          <div className="panel-head fleet-list-heading">
            <div>
              <h2 id="fleet-title">Linux hosts</h2>
              <p>Agent connectivity and host resources</p>
            </div>
            <div className="host-search">
              <label className="sr-only" htmlFor="host-search">Search hosts</label>
              <Input
                id="host-search"
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search hosts or ID…"
              />
              {query && (
                <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          <p className="tiny fleet-coverage" role="status">
            {fleet
              ? `${visible.length} matching · ${hosts.length} of ${fleet.total} hosts loaded · Limit ${fleet.limit}`
              : failure
                ? "Host inventory unavailable"
                : "Loading host inventory…"}
          </p>

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
                  <th scope="col">Status</th>
                  <th scope="col">CPU</th>
                  <th scope="col">Memory</th>
                  <th scope="col">Disk</th>
                  <th scope="col">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(h => (
                  <tr key={h.id} className={selected === h.id ? "host-selected" : ""}>
                    <th scope="row">
                      <Button
                        variant="ghost"
                        aria-pressed={selected === h.id}
                        aria-controls="host-inspector"
                        onClick={() => selectHost(h.id)}
                      >
                        {h.hostname}
                        <svg className="host-selection-arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" /></svg>
                        <span className="sr-only">
                          {selected === h.id ? ", selected" : ", inspect host"}
                        </span>
                      </Button>
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
                    </td>
                    {[h.cpu_percent, h.memory_percent, h.disk_percent].map((v, i) => (
                      <td key={i}>
                        <span
                          className={measurementClass(v)}
                          aria-label={v == null || !Number.isFinite(v) ? "No measurement" : undefined}
                        >
                          {percent(v)}
                        </span>
                      </td>
                    ))}
                    <td>
                      <time dateTime={h.last_seen_at ?? undefined} title={stamp(h.last_seen_at)}>
                        {age(h.last_seen_at, now)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {fleet && !hosts.length && (
            <p className="empty">
              No hosts enrolled. Use Enroll host to create a one-time token and connect your first Linux host.
            </p>
          )}
          {hosts.length > 0 && !visible.length && (
            <p className="empty" role="status">
              No hosts match “{query}”.{" "}
              <Button variant="ghost" onClick={() => setQuery("")}>Clear search</Button>
            </p>
          )}

          <p className="tiny fleet-freshness">
            {fleet && (
              <>
                Fleet observed <time dateTime={fleet.observed_at}>{stamp(fleet.observed_at)}</time>.{" "}
              </>
            )}
            Samples older than {fleet?.stale_after_seconds ?? 60}s are stale. Offline agents retain historical observations; connectivity is not endpoint reachability.
          </p>
          {host && (
            <a className="inspector-jump" href="#host-inspector">
              View {host.hostname} observations
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 3v14m-5-5 5 5 5-5" /></svg>
            </a>
          )}

        </div>

        <Panel className="host-inspector" id="host-inspector" role="region" aria-labelledby="host-inspector-title" tabIndex={-1}>
          <div className="panel-head">
            <h2 id="host-inspector-title">{host ? host.hostname : "Host inspector"}</h2>
            {host && (
              <Badge tone={host.status === "online" && !failure ? "success" : "warning"}>
                {host.status === "online" ? "Online" : "Offline"}
                {failure ? " (cached)" : ""}
              </Badge>
            )}
          </div>

          {!host ? (
            <p className="muted" role="status">
              {selectionNotice || "Select a host to inspect its observations and resource history."}
            </p>
          ) : (
            <>
              <div className="inspector-resources" role="group" aria-label="Resource history">
                <span className="sr-only">Choose a resource to view its history</span>
                {resources.map(({ key, label }) => (
                  <Button
                    key={key}
                    variant="ghost"
                    aria-pressed={resource === key}
                    onClick={() => {
                      if (resource !== key) selectWithTransition(() => setResource(key));
                    }}
                  >
                    <span
                      className={`resource-value ${measurementClass(host[key])}`}
                      aria-label={host[key] == null ? "No measurement" : undefined}
                    >
                      {percent(host[key])}
                    </span>
                    <span className="resource-label">{label}</span>
                  </Button>
                ))}
              </div>

              <p className="tiny inspector-sample">
                Sample <time dateTime={host.sampled_at ?? undefined}>{stamp(host.sampled_at)}</time> ·{" "}
                {failure
                  ? "Cached, not live"
                  : host.status === "offline"
                    ? "Historical, not live"
                    : stale(host)
                      ? "Stale / unavailable"
                      : `Within ${fleet?.stale_after_seconds ?? 60}s freshness window`}
              </p>

              {historyError && (
                <Notice tone="warning">
                  Resource history refresh failed: {historyError}.{" "}
                  {history?.id === host.id ? "Cached history below is stale." : "History unavailable."}
                </Notice>
              )}
              <div className="history-stage">
                {history && history.id === host.id ? (
                  <ResourceHistory key={host.id} samples={history.samples} resource={resource} />
                ) : (
                  !historyError && <p className="empty" role="status">Loading resource history…</p>
                )}
              </div>

              <div className="inspector-network">
                <p>
                  RX / TX <span className="muted">Rates unavailable</span>
                </p>
                <p>
                  Uptime <span className="muted">Not collected</span>
                </p>
              </div>

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
                ) : (
                  <p className="muted small">No open incident for this host in the latest 100 records.</p>
                )}
                <p className="tiny">Measured signals only. No root cause inferred.</p>
              </section>

              <details className="host-metadata">
                <summary>Host identity &amp; last contact</summary>
                <p className="tiny">OS and capacity unavailable · Not collected</p>
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
          {drift && (
            <section className="fleet-drift" aria-labelledby="fleet-drift-title">
              <h2 id="fleet-drift-title">Monitored file changed</h2>
              <p className="drift-observation">
                {drift.hostname} · <time dateTime={drift.created_at}>{stamp(drift.created_at)}</time>
              </p>
              <Button variant="ghost" onClick={() => onOpenIncident(drift.id)}>
                {drift.title}
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 12h14 M13 6l6 6-6 6" />
                </svg>
              </Button>
              <p className="muted">Hash change recorded. Relationship to resource incidents is unknown.</p>
              <small className="muted">
                Latest recorded drift in the last 100 incidents · {drift.status}
              </small>
            </section>
          )}

          <details className="service-inventory">
            <summary>
              Service &amp; endpoint availability <span className="muted">Not collected</span>
            </summary>
            <section aria-labelledby="services-title">
              <div className="panel-head">
                <div>
                  <h2 id="services-title">
                    {host ? `Services on ${host.hostname}` : "Services on selected host"}
                  </h2>
                  <p>Read-only inventory · Collection unavailable</p>
                </div>
                <Button size="sm" disabled aria-describedby="inventory-unavailable">
                  Add endpoint
                </Button>
              </div>
              <div
                className="host-table-scroll"
                role="region"
                aria-label="Service inventory table, horizontally scrollable"
                tabIndex={0}
              >
                <table className="host-table service-table">
                  <caption className="sr-only">
                    Service runtime, process state, resources and independent endpoint checks. Inventory is unavailable.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Service / runtime</th>
                      <th scope="col">Process</th>
                      <th scope="col">Resources</th>
                      <th scope="col">Endpoint</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div className="inventory-unavailable" id="inventory-unavailable">
                <strong>{host ? "Inventory unavailable" : "Select a host to view inventory availability"}</strong>
                <p>
                  Continuous Docker/systemd inventory is not collected. Workload count, process state and per-service resources are unavailable—not zero.
                </p>
                <p>
                  Endpoint configuration and HTTP checks are not available. No reachability result has been inferred.
                </p>
              </div>
              <div className="signal-boundary">
                <p>Running is not the same as reachable.</p>
                <p className="muted small">
                  Agent telemetry describes the host. Endpoint checks require independent observations from a named probe.
                </p>
              </div>
            </section>
          </details>
      </div>

      <section
        ref={enrollmentPanel}
        tabIndex={-1}
        className="host-enrollment"
        id="host-enrollment"
        aria-labelledby="enroll-host-title"
        hidden={!enrollmentOpen}
      >
        <div className="panel-head">
          <div>
            <h2 id="enroll-host-title">Enroll a Linux host</h2>
            <p>Copy one command, SSH to the intended host, and paste it there.</p>
          </div>
          <Button size="sm" variant="ghost" onClick={closeEnrollment}>
            Close enrollment
          </Button>
        </div>

        <p className="small">
          Requires Linux with running systemd, amd64 or arm64, curl and CA certificates.
          {" "}Run as root or with sudo (which may prompt for your password). No Go toolchain or repository checkout needed.
        </p>
        {configLoading && <p role="status">Loading installation configuration…</p>}
        {configError && <Notice tone="warning" role="alert">{configError}. Monitoring and manual enrollment remain available.</Notice>}
        {installConfig && (
          <p className="small">
            Hub: <code>{installConfig.hubUrl}</code><br />
            Pinned release: <code>{installConfig.version}</code> from <code>{installConfig.repository}</code>
          </p>
        )}
        <Button loading={enrolling} disabled={!installConfig || configLoading} onClick={() => void enroll()}>
          Generate install command
        </Button>

        {enrollError && (
          <Notice tone="danger" role="alert">
            {enrollError}
          </Notice>
        )}

        {token && now < token.expires && (
          <div className="enrollment-secret">
            <Notice tone="warning">
              This command contains a one-time token and may remain in shell history and the clipboard. It expires after 10 minutes; use it only on the intended host.
            </Notice>
            <p>
              Expires {new Date(token.expires).toLocaleTimeString()} ·{" "}
              {Math.max(0, Math.ceil((token.expires - now) / 1000))}s remaining.
              {" "}Usable once; creating another does not revoke earlier tokens.
            </p>
            <pre className="agent-command" tabIndex={0} aria-label="Install command"><code>{token.command}</code></pre>
            <div className="token">
              <Button size="sm" onClick={() => void copyCommand()}>Copy install command</Button>
              <Button size="sm" variant="ghost" onClick={clearSecret}>Hide command</Button>
              {copied && <span role="status">Install command copied.</span>}
            </div>
            {copyError && <Notice tone="warning" role="alert">{copyError}</Notice>}
          </div>
        )}

        <p className="tiny">
          The installer verifies the pinned binary and enables a nonroot systemd service.
          {" "}Hiding a command does not clear clipboard/history or revoke its token.
          {" "}Verify the host’s Online status and fresh measurements in the fleet table; it refreshes every 10 seconds.
        </p>
      </section>
    </section>
  );
}
