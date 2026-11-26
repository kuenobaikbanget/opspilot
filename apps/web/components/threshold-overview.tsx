import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { finitePercent, SYSTEMD_STALE_AFTER_SECONDS, type EndpointMonitor, type Host, type HostList, type HostSystemdStatus } from "@opspilot/contracts";
import { api } from "../lib/api";
import { hasFreshSample, percent, pressure, resources, type Pressure, type Resource } from "../lib/host-pressure";
import { HostSystemd, isSystemdReportCurrent, systemdCollection, systemdStates } from "./host-systemd";
import { AsciiCardReveal, AsciiCardSkeleton, AsciiLoading } from "./ascii-card-reveal";
import { Badge, Button, ButtonLink } from "./ui";

type OverviewIncidentSummary = {
  id: string;
  agent_id: string;
  title: string;
  category: string;
  status: string;
  created_at: string;
};

type InvestigationSummary = {
  status: string;
  provider: { name: string; model: string | null };
  result_json: {
    probable_cause?: string;
    confidence?: string | number;
    recommended_checks?: string[];
  } | null;
  error: string | null;
};

type InvestigationRead =
  | { state: "loading" | "unavailable" }
  | { state: "loaded"; investigation: InvestigationSummary | null };

const categoryByResource: Record<Resource, string> = {
  cpu_percent: "cpu",
  memory_percent: "memory",
  disk_percent: "disk",
};

type Props = {
  fleet: HostList | null;
  fleetError: string;
  openIncidents: number | null;
  incidentsStale: boolean;
  incidents: OverviewIncidentSummary[];
  endpoints: EndpointMonitor[] | null;
  servicesError: string;
  checkingEndpointId: string | null;
  onCheckEndpoint: (id: string) => void;
  onOpenIncident: (id: string) => void;
  onInspectHost: (id: string, resource?: Resource) => void;
  refreshKey?: number;
};

type HostServiceEntry = { status: HostSystemdStatus | null; failed: boolean };

type Risk = { host: Host; reading: Pressure };

type DetailSelection = { kind: "host" | "endpoint"; id: string };
type EndpointStatus = "up" | "down" | "pending" | "stale";
type EndpointRow = { endpoint: EndpointMonitor; status: EndpointStatus };

// Every Overview card reveals as one full-card dither wave. useCanAnimateAscii() inside
// AsciiCardReveal still falls back to plain rendering under reduced motion or without Canvas 2D.
const cardReveal = { preset: "dither", duration: "cinematic", speed: 1 } as const;

const icons = {
  server: <><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/></>,
  sort: <path d="M4 4v16m-3-3 3 3 3-3M10 5h11M10 10h8m-8 5h5"/>,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6"/>,
  online: <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>,
  offline: <><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></>,
};

function OverviewIcon({ name }: { name: keyof typeof icons }) {
  return (
    <svg className="overview-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function SampleTime({ value }: { value: string | null }) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp)
    ? <time dateTime={value ?? undefined}>{dateTime.format(timestamp)}</time>
    : "Not observed";
}

function PressureReading({ reading }: { reading: Pressure }) {
  return (
    <div className="overview-pressure-reading">
      <p className="overview-meta">{reading.label} usage</p>
      <p className="overview-pressure-comparison">
        <strong>{percent(reading.value)}</strong>
        <span className="overview-pressure-limit-label">Limit <span className="overview-pressure-limit">{percent(reading.limit)}</span></span>
      </p>
      <div className="overview-pressure-gauge" data-ascii="media" aria-hidden="true">
        <div className="overview-pressure-track" style={{
          "--usage": `${reading.value}%`,
          "--limit": `${reading.limit}%`,
        } as CSSProperties}>
          {reading.value > 0 && <span className="overview-pressure-fill" />}
          {reading.value > reading.limit && <span className="overview-pressure-overrun" />}
          <span className="overview-pressure-marker" />
        </div>
        <div className="overview-pressure-ticks" />
        <div className="overview-pressure-scale"><span>0%</span><span>100%</span></div>
      </div>
    </div>
  );
}

function RiskBadge({ reading }: { reading: Pressure }) {
  if (reading.state === "exceeded") {
    return <Badge tone="danger" data-ascii="fade">{reading.value === reading.limit ? "At limit" : "Exceeded"}</Badge>;
  }
  return <Badge tone="warning" data-ascii="fade">Near limit</Badge>;
}

function RiskCard({ risk, serviceInfo, now, selected, inspectorId, onSelect }: {
  risk: Risk;
  serviceInfo?: HostServiceEntry;
  now: number;
  selected: boolean;
  inspectorId: string;
  onSelect: () => void;
}) {
  const { host, reading } = risk;
  const status = serviceInfo?.status;
  const service = status?.service;
  const failed = Boolean(serviceInfo?.failed);
  const expired = Boolean(
    status?.report?.current &&
    now - Date.parse(status.checked_at) >= SYSTEMD_STALE_AFTER_SECONDS * 1000 + Date.parse(status.report.observed_at) - Date.parse(status.checked_at),
  );
  const fresh = service?.freshness === "fresh" && isSystemdReportCurrent(status, expired, failed);

  return (
    <AsciiCardReveal as="li" className="overview-risk-item" lazy={true} {...cardReveal}>
      <div className="overview-risk-card" data-ascii="surface" data-pressure={reading.state} data-selected={selected}>
        <Button variant="ghost" className="overview-risk-select" data-ascii="fade" aria-controls={inspectorId} aria-pressed={selected} onClick={onSelect}>
          <OverviewIcon name="server" />
          <span className="overview-identity">
            <span className="overview-hostname">{host.hostname}</span>
            <span className="overview-meta">Device · Agent online</span>
          </span>
          <RiskBadge reading={reading} />
        </Button>
        <div className="overview-risk-reading">
          <PressureReading reading={reading} />
        </div>
        {/* Async service arrival decodes in its own reveal so it never resizes the card reveal above. */}
        {!serviceInfo ? (
          <div className="overview-risk-services">
            <AsciiLoading className="overview-service-skeleton" label="Service · Loading…" lines={1} widths={["72%"]} seed={11} />
          </div>
        ) : (
          <AsciiCardReveal className="overview-risk-services" revealOnMount={true} {...cardReveal}>
            {failed && !service ? (
              <span className="overview-meta">Service · Unavailable</span>
            ) : service ? (
              <div className="overview-risk-service">
                <span className="overview-meta">Service</span>
                <strong>{service.name}</strong>
                <Badge tone={fresh ? systemdStates[service.state].tone : "neutral"} dot data-ascii="fade">
                  {systemdStates[service.state].label}{fresh ? "" : " · Stale"}
                </Badge>
              </div>
            ) : status?.report && status.report.status !== "observed" ? (
              <span className="overview-meta">{systemdCollection[status.report.status]}</span>
            ) : (
              <span className="overview-meta">Service · Not reported</span>
            )}
          </AsciiCardReveal>
        )}
      </div>
    </AsciiCardReveal>
  );
}

function AdvisoryAnalysis({ incident, incidentsStale, incidentsLoading }: {
  incident: OverviewIncidentSummary | null;
  incidentsStale: boolean;
  incidentsLoading: boolean;
}) {
  const [read, setRead] = useState<InvestigationRead>({ state: "loading" });
  const incidentId = incident?.id;

  useEffect(() => {
    if (!incidentId) return;
    let active = true;
    void api(`/incidents/${incidentId}`)
      .then((data: { investigations: InvestigationSummary[] }) => {
        if (active) setRead({ state: "loaded", investigation: data.investigations[0] ?? null });
      })
      .catch(() => {
        if (active) setRead({ state: "unavailable" });
      });
    return () => { active = false; };
  }, [incidentId]);

  const investigation = read.state === "loaded" ? read.investigation : null;
  const advisoryLoading = (!incident && !incidentsStale && incidentsLoading) || (Boolean(incident) && read.state === "loading");
  const advisoryKey = incident
    ? `${incident.id}:${read.state}`
    : incidentsStale
      ? "stale"
      : "empty";

  return (
    <section className="overview-ai-card" data-ascii="surface" aria-label="Advisory AI analysis">
      <div className="overview-ai-head">
        <span className="overview-meta">AI hypothesis (advisory)</span>
        {incident && (investigation ? (
          <Badge tone={investigation.status === "failed" ? "danger" : investigation.status === "completed" ? "info" : "warning"} data-ascii="fade">
            {investigation.status}
          </Badge>
        ) : (
          <Badge tone={read.state === "unavailable" ? "warning" : "neutral"} data-ascii="fade">
            {read.state === "loading" ? "Loading" : read.state === "unavailable" ? "Unavailable" : "Not run"}
          </Badge>
        ))}
      </div>
      {incident && (
        <p className="overview-meta">
          Source incident{incidentsStale ? " (cached record)" : ""}: {incident.title} · Opened <SampleTime value={incident.created_at} />.
          {investigation && " This investigation does not assess the current sample."}
        </p>
      )}
      {advisoryLoading ? (
        incident ? (
          <AsciiLoading className="overview-ai-skeleton" label="Loading recorded AI analysis…" variant="braille" lines={3} widths={["92%", "78%", "56%"]} seed={37} />
        ) : (
          <AsciiLoading className="overview-ai-skeleton" label="Loading incident records…" />
        )
      ) : (
        <AsciiCardReveal key={advisoryKey} revealOnMount={true} {...cardReveal}>
          {!incident ? (
            <p className="overview-meta" role="status">
              {incidentsStale ? "Cannot confirm a matching incident: incident records are unavailable or cached."
                : "No incident for this resource on this device in the loaded records."}
            </p>
          ) : read.state === "unavailable" ? (
            <p className="overview-meta" role="status">Could not load the incident’s investigation record.</p>
          ) : investigation?.result_json?.probable_cause ? (
            <>
              <p className="overview-ai-cause">{investigation.result_json.probable_cause}</p>
              <p className="overview-meta">
                Confidence: {investigation.result_json.confidence ?? "unknown"} · {investigation.provider.name}
                {investigation.provider.model ? ` · ${investigation.provider.model}` : ""}
              </p>
              {!!investigation.result_json.recommended_checks?.length && (
                <ul className="overview-ai-checks">
                  {investigation.result_json.recommended_checks.slice(0, 2).map((check, i) => (
                    <li key={i}>{check}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="overview-meta">
              {investigation ? investigation.error ?? "Open the incident to see the investigation record."
                : "No AI investigation recorded for this incident."}
            </p>
          )}
        </AsciiCardReveal>
      )}
    </section>
  );
}

function PressureInspector({
  risk,
  refreshKey,
  incident,
  incidentsStale,
  incidentsLoading,
  onInspectHost,
  onOpenIncident,
}: {
  risk: Risk;
  refreshKey: number;
  incident: OverviewIncidentSummary | null;
  incidentsStale: boolean;
  incidentsLoading: boolean;
  onInspectHost: Props["onInspectHost"];
  onOpenIncident: Props["onOpenIncident"];
}) {
  const { host, reading } = risk;
  return (
    <>
      <AsciiCardReveal {...cardReveal}>
        <div className="overview-inspector-surface" data-ascii="surface">
          <div className="overview-inspector-head">
            <OverviewIcon name="server" />
            <h3 className="overview-hostname">{host.hostname}</h3>
            <RiskBadge reading={reading} />
          </div>
          <div className="overview-inspector-body overview-inspector-readings" data-pressure={reading.state}>
            <PressureReading reading={reading} />
            <dl className="overview-evidence">
              <div><dt>Measured sample</dt><dd><SampleTime value={host.sampled_at} /></dd></div>
              <div><dt>Agent connection</dt><dd>Online</dd></div>
            </dl>
          </div>
        </div>
      </AsciiCardReveal>
      {/* Async evidence can resize without interrupting the reveal above. */}
      <div className="overview-inspector-body overview-inspector-support">
        <HostSystemd key={host.id} hostId={host.id} refreshKey={refreshKey} />
        <AdvisoryAnalysis key={incident?.id} incident={incident} incidentsStale={incidentsStale} incidentsLoading={incidentsLoading} />
        <AsciiCardReveal className="overview-inspector-actions" revealOnMount={true} {...cardReveal}>
          <Button variant="primary" size="sm" data-ascii="fade" onClick={() => onInspectHost(host.id, reading.key)}>
            Open host history <OverviewIcon name="arrow" />
          </Button>
          {incident && (
            <Button size="sm" data-ascii="fade" onClick={() => onOpenIncident(incident.id)}>
              Open incident <OverviewIcon name="arrow" />
            </Button>
          )}
        </AsciiCardReveal>
      </div>
    </>
  );
}

function SummaryReading({ label, value, state, loading }: { label: string; value: number | null; state?: "near" | "exceeded"; loading?: boolean }) {
  return (
    <div className="overview-summary-reading" data-pressure={value ? state : undefined}>
      <dt>{label}</dt>
      <dd>{loading ? <AsciiLoading label={`Loading ${label.toLowerCase()}…`} lines={1} widths={["2ch"]} />
        : value === null ? <><span aria-hidden="true">—</span><span className="sr-only">Unavailable</span></> : value}</dd>
    </div>
  );
}

function InventoryRow({ host, fresh, cached, thresholds, onInspectHost }: {
  host: Host;
  fresh: boolean;
  cached: boolean;
  thresholds: HostList["thresholds"] | undefined;
  onInspectHost: Props["onInspectHost"];
}) {
  const statusTone = cached ? "warning" : host.status === "online" ? (fresh ? "success" : "warning") : "danger";
  const statusLabel = cached ? "Cached" : host.status === "online" ? (fresh ? "Online" : "Stale") : "Offline";

  return (
    <AsciiCardReveal as="li" className="overview-inventory-item" lazy={true} {...cardReveal}>
      <div className="overview-inventory-row" data-ascii="surface">
        <div className="overview-inventory-device">
          <OverviewIcon name="server" />
          <span className="overview-identity">
            <span className="overview-hostname">{host.hostname}</span>
            <span className="overview-meta">
              {host.version ? `v${host.version}` : "Device"}
            </span>
          </span>
        </div>
        <div className="overview-inventory-status">
          <Badge tone={statusTone} dot data-ascii="fade">{statusLabel}</Badge>
          {host.status === "offline" && host.last_seen_at && (
            <span className="overview-meta">Last seen <SampleTime value={host.last_seen_at} /></span>
          )}
          <span className="overview-meta">
            {cached ? "Cached snapshot"
              : host.status === "offline" ? "Disconnected"
                : fresh ? <SampleTime value={host.sampled_at} />
                  : host.sampled_at ? <SampleTime value={host.sampled_at} /> : "No sample received"}
          </span>
        </div>
        <dl className="overview-inventory-metrics" aria-label="Current readings and configured thresholds">
          {resources.map(({ key, label }) => {
            const value = fresh && finitePercent(host[key]) ? host[key] : null;
            const limit = thresholds?.[key] ?? null;
            const headroom = value !== null && limit !== null ? limit - value : null;
            const pressureState = headroom === null ? undefined : headroom <= 0 ? "exceeded" : headroom <= 5 ? "near" : undefined;
            return (
              <div key={key} className="overview-inventory-metric" data-pressure={pressureState}>
                <dt className="overview-inventory-metric-label">{label}</dt>
                <dd>
                  <span className="overview-inventory-reading" aria-hidden="true">
                    <strong>{percent(value)}</strong>
                    <span className="overview-inventory-limit">/ {percent(limit)}</span>
                  </span>
                  <span
                    className="overview-inventory-meter"
                    aria-hidden="true"
                    style={{ "--usage": `${value ?? 0}%` } as CSSProperties}
                  >
                    {value !== null && value > 0 && <span className="overview-inventory-meter-fill" />}
                  </span>
                  <span className="sr-only">
                    {value === null ? "No current reading" : `${percent(value)} current`}; {limit === null ? "No threshold reported" : `${percent(limit)} threshold`}
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
        <Button variant="ghost" size="sm" className="overview-inventory-action" data-ascii="fade" aria-label={`Inspect ${host.hostname}`} onClick={() => onInspectHost(host.id)}>
          Inspect <OverviewIcon name="arrow" />
        </Button>
      </div>
    </AsciiCardReveal>
  );
}

// Worker probes become eligible after 15s; allow 60s for polling and queue delays.
const endpointFreshnessMs = 60_000;

function endpointResult(endpoint: EndpointMonitor) {
  if (endpoint.last_status === "up") {
    return `Up${endpoint.last_http_status !== null ? ` · HTTP ${endpoint.last_http_status}` : ""}${endpoint.last_latency_ms !== null ? ` · ${endpoint.last_latency_ms} ms` : ""}`;
  }
  return `Down · ${endpoint.last_http_status !== null ? `HTTP ${endpoint.last_http_status}` : endpoint.last_error ?? "unreachable"}`;
}

function EndpointBadge({ endpoint, status }: EndpointRow) {
  return (
    <Badge tone={status === "up" ? "success" : status === "down" ? "danger" : "neutral"} dot data-ascii="fade">
      {status === "stale" ? "Stale" : status === "pending" ? "Pending" : endpointResult(endpoint)}
    </Badge>
  );
}

function EndpointInspector({ row, checkingEndpointId, onCheckEndpoint }: Pick<Props, "checkingEndpointId" | "onCheckEndpoint"> & { row: EndpointRow }) {
  const { endpoint, status } = row;
  return (
    <AsciiCardReveal {...cardReveal}>
      <div className="overview-inspector-surface" data-ascii="surface">
        <div className="overview-inspector-head">
          <OverviewIcon name="globe" />
          <h3 className="overview-endpoint-name">{endpoint.name}</h3>
          <EndpointBadge {...row} />
        </div>
        <div className="overview-inspector-body">
          <dl className="overview-evidence">
            <div className="overview-endpoint-target"><dt>Target URL</dt><dd>{endpoint.target_url}</dd></div>
            {endpoint.service_name && <div><dt>Service</dt><dd>{endpoint.service_name}</dd></div>}
            <div><dt>Probe location</dt><dd>{endpoint.probe_location}</dd></div>
            <div><dt>Expected response</dt><dd>HTTP {endpoint.expected_status}</dd></div>
            <div><dt>Last checked</dt><dd><SampleTime value={endpoint.last_checked_at} /></dd></div>
            {status === "stale" && <div><dt>Last result</dt><dd>{endpointResult(endpoint)}</dd></div>}
          </dl>
          <Button size="sm" data-ascii="fade" loading={checkingEndpointId === endpoint.id} onClick={() => onCheckEndpoint(endpoint.id)}>
            Check now
          </Button>
        </div>
      </div>
    </AsciiCardReveal>
  );
}

function EndpointReachability({ rows, servicesError, checkingEndpointId, onCheckEndpoint, selectedId, inspectorId, onSelect }: Pick<Props, "servicesError" | "checkingEndpointId" | "onCheckEndpoint"> & {
  rows: EndpointRow[] | undefined;
  selectedId: string | undefined;
  inspectorId: string;
  onSelect: (id: string) => void;
}) {
  const counts = { up: 0, down: 0, pending: 0, stale: 0 };
  for (const { status } of rows ?? []) counts[status]++;
  const loading = !rows && !servicesError;

  const content = (
    <section className="overview-endpoint-scope" data-ascii={loading ? undefined : "surface"} aria-labelledby="overview-endpoint-heading">
      <div className="overview-endpoint-heading">
        <OverviewIcon name="globe" />
        <h2 id="overview-endpoint-heading">Endpoint reachability</h2>
      </div>
      {servicesError ? (
        <p role="status">Endpoint reachability unavailable. {servicesError}</p>
      ) : !rows ? (
        <AsciiLoading className="overview-ascii-loading" label="Loading endpoint monitors…" lines={3} widths={["46%", "94%", "82%"]} seed={23} />
      ) : !rows.length ? (
        <p role="status">No endpoint monitors configured.</p>
      ) : (
        <>
          <p role="status">{counts.up} up · {counts.down} down · {counts.pending} pending · {counts.stale} stale</p>
          <ul className="overview-endpoint-list" role="list">
            {rows.map((row) => (
              <li key={row.endpoint.id} className="overview-endpoint-item" data-selected={selectedId === row.endpoint.id}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="overview-endpoint-select"
                  data-ascii="fade"
                  aria-controls={inspectorId}
                  aria-pressed={selectedId === row.endpoint.id}
                  onClick={() => onSelect(row.endpoint.id)}
                >
                  <span className="overview-endpoint-name">{row.endpoint.name}</span>
                  <EndpointBadge {...row} />
                </Button>
                <Button
                  size="sm"
                  data-ascii="fade"
                  aria-label={`Check now: ${row.endpoint.name}`}
                  loading={checkingEndpointId === row.endpoint.id}
                  onClick={() => onCheckEndpoint(row.endpoint.id)}
                >
                  Check now
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p>Probed independently of host metrics. A result becomes stale 60 seconds after its last check.</p>
    </section>
  );

  return loading ? content : (
    <AsciiCardReveal revealOnMount={true} {...cardReveal}>
      {content}
    </AsciiCardReveal>
  );
}

export function ThresholdOverview({
  fleet,
  fleetError,
  openIncidents,
  incidentsStale,
  incidents,
  endpoints,
  servicesError,
  checkingEndpointId,
  onCheckEndpoint,
  onOpenIncident,
  onInspectHost,
  refreshKey = 0,
}: Props) {
  const [clock, setClock] = useState(Date.now);
  const [selection, setSelection] = useState<DetailSelection | null>(null);
  const [hostServices, setHostServices] = useState<Record<string, HostServiceEntry>>({});
  const [offlineOnly, setOfflineOnly] = useState(false);
  const inspectorId = useId();
  const inspector = useRef<HTMLElement>(null);
  const inventoryHeading = useRef<HTMLHeadingElement>(null);
  const loaded = fleet?.hosts.length ?? 0;
  const cached = Boolean(fleet && fleetError);

  function selectDetail(kind: DetailSelection["kind"], id: string) {
    setSelection({ kind, id });
    inspector.current?.focus();
  }

  const observedAt = fleet ? Date.parse(fleet.observed_at) : NaN;
  const now = Number.isFinite(observedAt) ? Math.max(clock, observedAt) : clock;

  let exceeded = 0;
  let near = 0;
  let assessed = 0;
  let haveReadings = false;
  let nextExpiry = Infinity;
  const risks: Risk[] = [];
  const devices = fleet?.hosts.map((host) => {
    const fresh = !cached && hasFreshSample(host, fleet, now);
    if (fresh && host.sampled_at) {
      nextExpiry = Math.min(nextExpiry, Date.parse(host.sampled_at) + fleet.stale_after_seconds * 1000 + 1);
      haveReadings ||= resources.some(({ key }) => finitePercent(host[key]));
      const reading = pressure(host, fleet, now);
      if (reading) {
        assessed++;
        if (reading.state === "exceeded") exceeded++;
        if (reading.state === "near") near++;
        if (reading.state !== "within") risks.push({ host, reading });
      }
    }
    return { host, fresh };
  });

  const endpointNow = Date.now();
  const endpointRows = servicesError ? undefined : endpoints?.map((endpoint): EndpointRow => {
    const expiry = Date.parse(endpoint.last_checked_at ?? "") + endpointFreshnessMs;
    const status = endpoint.last_status === "unknown" || !Number.isFinite(expiry) ? "pending"
      : endpointNow >= expiry ? "stale" : endpoint.last_status;
    if (status === "up" || status === "down") nextExpiry = Math.min(nextExpiry, expiry);
    return { endpoint, status };
  });

  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(1, nextExpiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);
  risks.sort((a, b) => a.reading.headroom - b.reading.headroom || a.host.hostname.localeCompare(b.host.hostname));
  const riskHostKeys = risks.map(r => r.host.id).join(",");

  useEffect(() => {
    const ids = riskHostKeys ? riskHostKeys.split(",") : [];
    if (!ids.length) return;
    let active = true;

    async function load() {
      const entries = await Promise.all(
        ids.map(async (id): Promise<[string, HostServiceEntry]> => {
          try {
            const status: HostSystemdStatus = await api(`/hosts/${id}/services`);
            return [id, { status, failed: false }];
          } catch {
            return [id, { status: null, failed: true }];
          }
        }),
      );
      if (!active) return;
      setHostServices(prev => {
        const next = { ...prev };
        for (const [id, entry] of entries) {
          next[id] = entry.failed && prev[id]?.status ? { status: prev[id].status, failed: true } : entry;
        }
        return next;
      });
    }

    void load();
    const poll = setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [riskHostKeys, refreshKey]);

  const selectedEndpointId = selection?.kind === "endpoint" ? selection.id : undefined;
  const selectedEndpoint = endpointRows?.find(({ endpoint }) => endpoint.id === selectedEndpointId);
  const selectedRisk = selectedEndpointId === undefined
    ? risks.find(({ host }) => host.id === selection?.id) ?? risks[0]
    : undefined;
  const matchingIncidents = selectedRisk ? incidents.filter(i =>
    i.agent_id === selectedRisk.host.id && i.category === categoryByResource[selectedRisk.reading.key],
  ) : [];
  const selectedIncident = matchingIncidents.find(i => i.status === "open") ?? matchingIncidents[0] ?? null;
  const visibleDevices = offlineOnly ? devices?.filter(({ host }) => host.status === "offline") : devices;
  const offline = fleet ? fleet.total - fleet.online : null;
  const fleetLoading = !fleet && !fleetError;

  const thresholds = fleet?.thresholds;
  const hasThreshold = resources.some(({ key }) => finitePercent(thresholds?.[key]));
  const scope = fleet ? `${loaded} of ${fleet.total} devices loaded` : "Fleet scope unavailable";
  const emptyWatchlist = fleetError
    ? "Current threshold risk is unavailable until the fleet refreshes successfully."
    : !fleet
      ? "Loading device readings and configured thresholds…"
      : !loaded
        ? fleet.total ? "No devices were loaded for this view." : "No devices have been connected."
        : !hasThreshold
          ? thresholds ? "No resource thresholds are configured." : "The hub has not reported its resource thresholds."
          : !haveReadings
            ? "No fresh online resource readings are available."
            : !assessed
              ? "No fresh readings are available for resources with a configured threshold."
              : "No assessed devices are at or near a configured limit.";

  const summarySection = (
    <section className="overview-summary" data-ascii={fleetLoading ? undefined : "surface"} aria-labelledby="overview-pressure-heading">
      <div className="overview-summary-statement">
        <h2 id="overview-pressure-heading">
          {assessed ? `${risks.length} ${risks.length === 1 ? "device" : "devices"} at risk` : "Device threshold pressure"}
        </h2>
        {fleetLoading ? (
          <AsciiLoading className="overview-ascii-loading" label="Loading fleet scope and agent connectivity counts…" widths={["62%", "48%"]} seed={3} />
        ) : (
          <>
            <p>{fleet ? `${scope} · ${assessed} assessed against a configured limit` : "Could not load fleet scope"}</p>
            {fleetError && (
              <p role="status">{cached && <>Cached inventory from <SampleTime value={fleet?.observed_at ?? null} />. </>}{fleetError}</p>
            )}
            <div className="overview-fleet-connectivity">
              {fleet ? (
                <dl aria-label={cached ? "Fleet agent connectivity, cached" : "Fleet agent connectivity"}>
                  <div><dt>Agent online</dt><dd>{fleet.online}</dd></div>
                  <div><dt>Agent offline</dt><dd>{offline}</dd></div>
                </dl>
              ) : <p role="status">Agent connectivity counts unavailable.</p>}
              {cached && <p>Agent counts are cached.</p>}
              {offline !== null && offline > 0 && (
                <Button size="sm" data-ascii="fade" onClick={() => {
                  setOfflineOnly(true);
                  inventoryHeading.current?.focus();
                }}>Show offline devices <OverviewIcon name="arrow" /></Button>
              )}
            </div>
          </>
        )}
      </div>
      {fleetLoading ? (
        <AsciiLoading className="overview-summary-skeleton" label="Loading threshold readings…" variant="dither" widths={["100%", "78%"]} seed={7} />
      ) : (
        <dl className="overview-summary-readings">
          <SummaryReading label="At or above limit" value={assessed ? exceeded : null} state="exceeded" />
          <SummaryReading label="Near limit" value={assessed ? near : null} state="near" />
          <SummaryReading label={incidentsStale && openIncidents !== null ? "Open incidents · cached" : "Open incidents"} value={openIncidents} loading={openIncidents === null && !incidentsStale} />
        </dl>
      )}
    </section>
  );

  const inventoryHead = (
    <div className="overview-section-head" data-ascii={fleetLoading ? undefined : "surface"}>
      <div>
        <h2 id="overview-inventory-heading" ref={inventoryHeading} tabIndex={-1}>{offlineOnly ? "Offline devices" : "All devices"}</h2>
        {fleet && <p className="overview-meta">{scope} · {offlineOnly ? "Offline filter applies to loaded devices only" : "Reading / configured threshold"}{cached ? " · Cached" : ""}</p>}
      </div>
      {offlineOnly
        ? <Button size="sm" data-ascii="fade" onClick={() => { setOfflineOnly(false); inventoryHeading.current?.focus(); }}>Show all devices</Button>
        : <ButtonLink size="sm" href="/hosts" data-ascii="fade">Browse hosts <OverviewIcon name="arrow" /></ButtonLink>}
    </div>
  );

  return (
    <div className="threshold-overview">
      {fleetLoading ? summarySection : (
        <AsciiCardReveal revealOnMount={true} {...cardReveal}>
          {summarySection}
        </AsciiCardReveal>
      )}

      <div className="overview-pressure-workspace">
        <div className="overview-pressure-sources">
          <section className="overview-watchlist" aria-labelledby="overview-watchlist-heading">
            <div className="overview-section-head">
              <h2 id="overview-watchlist-heading">Devices at risk</h2>
              <span className="overview-meta overview-sort"><OverviewIcon name="sort" /> Risk first</span>
            </div>
            {risks.length ? (
              <ul className="overview-risk-list" role="list">
                {risks.map((risk) => (
                  <RiskCard
                    key={risk.host.id}
                    risk={risk}
                    serviceInfo={hostServices[risk.host.id]}
                    now={now}
                    selected={selectedRisk?.host.id === risk.host.id}
                    inspectorId={inspectorId}
                    onSelect={() => selectDetail("host", risk.host.id)}
                  />
                ))}
              </ul>
            ) : fleetLoading ? (
              <div className="overview-risk-list" role="status" aria-live="polite">
                <span className="sr-only" data-ascii="skip">{emptyWatchlist}</span>
                {[1, 2].map((index) => (
                  <div key={index} className="overview-risk-card">
                    <div className="overview-risk-skeleton-head">
                      <AsciiCardSkeleton variant="scan" lines={2} widths={["42%", "32%"]} seed={13 + index} />
                    </div>
                    <div className="overview-risk-reading overview-risk-skeleton-body">
                      <AsciiCardSkeleton variant="scan" lines={2} widths={["20%", "28%"]} seed={17 + index} />
                      <AsciiCardSkeleton variant="dither" lines={1} widths={["100%"]} seed={21 + index} />
                    </div>
                    <div className="overview-risk-services">
                      <AsciiCardSkeleton variant="scan" lines={1} widths={["55%"]} seed={25 + index} />
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="overview-empty">{emptyWatchlist}</p>}
            <p className="overview-rule">Devices are ranked by smallest limit margin. Near limit means no more than 5 percentage points below the configured limit. Readings at or above it count toward the exceeded total.</p>
          </section>
          <EndpointReachability
            rows={endpointRows}
            servicesError={servicesError}
            checkingEndpointId={checkingEndpointId}
            onCheckEndpoint={onCheckEndpoint}
            selectedId={selectedEndpointId}
            inspectorId={inspectorId}
            onSelect={(id) => selectDetail("endpoint", id)}
          />
        </div>

        <aside id={inspectorId} className="overview-inspector" aria-labelledby="overview-inspector-heading" ref={inspector} tabIndex={-1}>
          <h2 id="overview-inspector-heading" className={selectedRisk || selectedEndpoint || fleetLoading ? "sr-only" : undefined}>Overview details</h2>
          {selectedEndpoint ? (
            <EndpointInspector
              key={selectedEndpoint.endpoint.id}
              row={selectedEndpoint}
              checkingEndpointId={checkingEndpointId}
              onCheckEndpoint={onCheckEndpoint}
            />
          ) : selectedEndpointId !== undefined ? (
            <p role="status">{servicesError ? "Endpoint details are unavailable until the endpoint list refreshes successfully." : "This endpoint is no longer in the loaded list."}</p>
          ) : selectedRisk ? (
            <PressureInspector
              key={selectedRisk.host.id}
              risk={selectedRisk}
              refreshKey={refreshKey}
              incident={selectedIncident}
              incidentsStale={incidentsStale}
              incidentsLoading={openIncidents === null && !incidentsStale}
              onInspectHost={onInspectHost}
              onOpenIncident={onOpenIncident}
            />
          ) : fleetLoading ? (
            <div role="status">
              <span className="sr-only">Loading device details…</span>
              <div className="overview-inspector-head">
                <AsciiCardSkeleton variant="scan" lines={1} widths={["50%"]} seed={43} />
              </div>
              <div className="overview-inspector-body">
                <AsciiCardSkeleton variant="scan" lines={2} widths={["25%", "37%"]} seed={47} />
                <AsciiCardSkeleton variant="dither" lines={1} widths={["100%"]} seed={51} />
                <AsciiCardSkeleton variant="scan" lines={3} widths={["84%", "73%", "51%"]} seed={55} />
              </div>
            </div>
          ) : (
            <p>Select an endpoint to see its probe details, or a device at risk to see its readings and analysis.</p>
          )}
        </aside>
      </div>

      <section className="overview-inventory" aria-labelledby="overview-inventory-heading">
        {fleetLoading ? inventoryHead : (
          <AsciiCardReveal lazy={true} revealOnMount={true} {...cardReveal}>
            {inventoryHead}
          </AsciiCardReveal>
        )}
        {visibleDevices?.length ? (
          <>
            <div className="overview-inventory-columns" aria-hidden="true">
              <span>Device</span>
              <span>Status</span>
              <div className="overview-inventory-columns-metrics">
                {resources.map(({ key, label }) => (
                  <span key={key}>{label}</span>
                ))}
              </div>
              <span className="overview-inventory-columns-action">Action</span>
            </div>
            <ul className="overview-inventory-list" role="list">
              {visibleDevices.map(({ host, fresh }) => (
                <InventoryRow
                  key={host.id}
                  host={host}
                  fresh={fresh}
                  cached={cached}
                  thresholds={thresholds}
                  onInspectHost={onInspectHost}
                />
              ))}
            </ul>
          </>
        ) : fleetLoading ? (
          <div className="overview-inventory-skeleton" role="status">
            <span className="sr-only" data-ascii="skip">Loading device inventory…</span>
            {[1, 2, 3].map((index) => (
              <div key={index} className="overview-inventory-skeleton-row">
                <AsciiCardSkeleton variant="dither" lines={2} widths={["58%", "86%"]} seed={41 + index} />
              </div>
            ))}
          </div>
        ) : <p className="overview-inventory-empty">{fleetError && !fleet ? "Device inventory unavailable." : offlineOnly ? "No offline devices in the loaded inventory." : "No devices to show."}</p>}
      </section>
    </div>
  );
}
