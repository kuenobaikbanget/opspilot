import { useEffect, useId, useRef, useState } from "react";
import { finitePercent, SYSTEMD_STALE_AFTER_SECONDS, type EndpointMonitor, type Host, type HostList, type HostSystemdStatus } from "@opspilot/contracts";
import { api } from "../lib/api";
import { hasFreshSample, percent, pressure, resources, type Pressure, type Resource } from "../lib/host-pressure";
import { HostSystemd, isSystemdReportCurrent, systemdCollection, systemdStates } from "./host-systemd";
import { Badge, Button } from "./ui";

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
  onBrowseHosts: () => void;
  refreshKey?: number;
};

type HostServiceEntry = { status: HostSystemdStatus | null; failed: boolean };

type Risk = { host: Host; reading: Pressure };

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

function MarginAmount({ value }: { value: number }) {
  const magnitude = Number(Math.abs(value).toPrecision(12));
  const tiny = magnitude > 0 && magnitude < 0.1;
  const amount = Number(magnitude.toFixed(1));
  return (
    <>
      <span aria-hidden="true">{tiny ? "<0.1" : amount} pp</span>
      <span className="sr-only">
        {tiny ? "Less than 0.1 percentage points" : `${amount} ${amount === 1 ? "percentage point" : "percentage points"}`}
      </span>
    </>
  );
}

function limitShare({ value, limit }: Pressure) {
  const share = (value / limit) * 100;
  return Number.isFinite(share) ? share : null;
}

function ThresholdBar({ share }: { share: number | null }) {
  if (share === null) return null;
  const fill = Math.max(0, Math.min(share, 100));
  return (
    <span className="overview-threshold-bar" aria-hidden="true">
      {fill > 0 && <span className="overview-threshold-used" style={{ flexGrow: fill }} />}
      {fill < 100 && <span className="overview-threshold-remaining" style={{ flexGrow: 100 - fill }} />}
    </span>
  );
}

function RiskBadge({ reading }: { reading: Pressure }) {
  if (reading.state === "exceeded") {
    return <Badge tone="danger">{reading.value === reading.limit ? "At limit" : "Exceeded"}</Badge>;
  }
  return <Badge tone="warning">Near limit</Badge>;
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
    <li className="overview-risk-card" data-pressure={reading.state} data-selected={selected}>
      <Button variant="ghost" className="overview-risk-select" aria-controls={inspectorId} aria-pressed={selected} onClick={onSelect}>
        <OverviewIcon name="server" />
        <span className="overview-identity">
          <span className="overview-hostname">{host.hostname}</span>
          <span className="overview-meta">Device · Agent online</span>
        </span>
        <RiskBadge reading={reading} />
      </Button>
      <div className="overview-risk-reading">
        <dl className="overview-risk-values">
          <div><dt>{reading.label} threshold</dt><dd>{percent(reading.limit)}</dd></div>
          <div><dt>Current reading</dt><dd>{percent(reading.value)}</dd></div>
          <div>
            <dt>Margin</dt>
            <dd>{reading.headroom === 0 ? "At limit" : <><MarginAmount value={reading.headroom} /> {reading.headroom > 0 ? "below" : "over"} limit</>}</dd>
          </div>
        </dl>
        <ThresholdBar share={limitShare(reading)} />
        <div className="overview-risk-services">
          {!serviceInfo ? (
            <span className="overview-meta">Service · Loading…</span>
          ) : failed && !service ? (
            <span className="overview-meta">Service · Unavailable</span>
          ) : service ? (
            <div className="overview-risk-service">
              <span className="overview-meta">Service</span>
              <strong>{service.name}</strong>
              <Badge tone={fresh ? systemdStates[service.state].tone : "neutral"} dot>
                {systemdStates[service.state].label}{fresh ? "" : " · Stale"}
              </Badge>
            </div>
          ) : status?.report && status.report.status !== "observed" ? (
            <span className="overview-meta">{systemdCollection[status.report.status]}</span>
          ) : (
            <span className="overview-meta">Service · Not reported</span>
          )}
        </div>
      </div>
    </li>
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
  return (
    <section className="overview-ai-card" aria-label="Advisory AI analysis">
      <div className="overview-ai-head">
        <span className="overview-meta">AI hypothesis (advisory)</span>
        {incident && (investigation ? (
          <Badge tone={investigation.status === "failed" ? "danger" : investigation.status === "completed" ? "info" : "warning"}>
            {investigation.status}
          </Badge>
        ) : (
          <Badge tone={read.state === "unavailable" ? "warning" : "neutral"}>
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
      {!incident ? (
        <p className="overview-meta" role="status">
          {incidentsStale ? "Cannot confirm a matching incident: incident records are unavailable or cached."
            : incidentsLoading ? "Loading incident records…"
              : "No incident for this resource on this device in the loaded records."}
        </p>
      ) : read.state === "loading" ? (
        <p className="overview-meta" role="status">Loading recorded AI analysis…</p>
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
  const share = limitShare(reading);
  return (
    <>
      <div className="overview-inspector-head">
        <OverviewIcon name="server" />
        <h3 className="overview-hostname">{host.hostname}</h3>
        <RiskBadge reading={reading} />
      </div>
      <div className="overview-inspector-body" data-pressure={reading.state}>
        <div>
          <p className="overview-meta">{reading.label} limit margin</p>
          <p className="overview-headroom">
            {reading.headroom === 0 ? "At limit" : (
              <><MarginAmount value={reading.headroom} /> <span className="overview-headroom-direction">{reading.headroom < 0 ? "over limit" : "below limit"}</span></>
            )}
          </p>
          <p className="overview-inspector-measurement"><strong>{percent(reading.value)}</strong> current · {percent(reading.limit)} threshold</p>
        </div>
        <div className="overview-inspector-share">
          <p>{share === null ? "Utilization ratio unavailable for this limit" : `${percent(share)} of configured limit`}</p>
          <ThresholdBar share={share} />
        </div>
        <dl className="overview-evidence">
          <div><dt>Measured sample</dt><dd><SampleTime value={host.sampled_at} /></dd></div>
          <div><dt>Agent connection</dt><dd>Online</dd></div>
        </dl>
        <HostSystemd key={host.id} hostId={host.id} refreshKey={refreshKey} />
        <AdvisoryAnalysis key={incident?.id} incident={incident} incidentsStale={incidentsStale} incidentsLoading={incidentsLoading} />
        <div className="overview-inspector-actions">
          <Button variant="primary" size="sm" onClick={() => onInspectHost(host.id, reading.key)}>
            Open host history <OverviewIcon name="arrow" />
          </Button>
          {incident && (
            <Button size="sm" onClick={() => onOpenIncident(incident.id)}>
              Open incident <OverviewIcon name="arrow" />
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

function SummaryReading({ label, value, state }: { label: string; value: number | null; state?: "near" | "exceeded" }) {
  return (
    <div className="overview-summary-reading" data-pressure={value ? state : undefined}>
      <dt>{label}</dt>
      <dd>{value === null ? <><span aria-hidden="true">—</span><span className="sr-only">Unavailable</span></> : value}</dd>
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
  return (
    <li className="overview-inventory-row">
      <div className="overview-inventory-device">
        <OverviewIcon name="server" />
        <span className="overview-identity">
          <span className="overview-hostname">{host.hostname}</span>
          <span className="overview-meta">
            {host.version ? `Agent ${host.version}` : "Device"}
          </span>
        </span>
      </div>
      <div className="overview-inventory-status">
        <Badge><OverviewIcon name={host.status === "online" ? "online" : "offline"} />{host.status === "online" ? "Agent online" : "Agent offline"}{cached ? " · cached" : ""}</Badge>
        {host.status === "offline" && host.last_seen_at && (
          <span className="overview-meta">Last seen <SampleTime value={host.last_seen_at} /></span>
        )}
        <span className="overview-meta">
          {cached ? "Cached snapshot · No current reading"
            : host.status === "offline" ? "Disconnected · No current reading"
              : fresh ? <SampleTime value={host.sampled_at} />
                : host.sampled_at ? <>Stale sample · <SampleTime value={host.sampled_at} /></> : "No sample received"}
        </span>
      </div>
      <dl className="overview-inventory-metrics" aria-label="Current readings and configured thresholds">
        {resources.map(({ key, label }) => {
          const value = fresh && finitePercent(host[key]) ? host[key] : null;
          const limit = thresholds?.[key] ?? null;
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                <span aria-hidden="true">{percent(value)} <span className="overview-inventory-limit">/ {percent(limit)}</span></span>
                <span className="sr-only">
                  {value === null ? "No current reading" : `${percent(value)} current`}; {limit === null ? "No threshold reported" : `${percent(limit)} threshold`}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
      <Button size="sm" className="overview-inventory-action" aria-label={`Inspect ${host.hostname}`} onClick={() => onInspectHost(host.id)}>
        Inspect <OverviewIcon name="arrow" />
      </Button>
    </li>
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

function EndpointReachability({ endpoints, servicesError, checkingEndpointId, onCheckEndpoint }: Pick<Props, "endpoints" | "servicesError" | "checkingEndpointId" | "onCheckEndpoint">) {
  const [, setClock] = useState(Date.now);
  const now = Date.now();
  const counts = { up: 0, down: 0, pending: 0, stale: 0 };
  let nextExpiry = Infinity;
  const rows = servicesError ? null : endpoints?.map(endpoint => {
    const expiry = Date.parse(endpoint.last_checked_at ?? "") + endpointFreshnessMs;
    const status = endpoint.last_status === "unknown" || !Number.isFinite(expiry) ? "pending"
      : now >= expiry ? "stale" : endpoint.last_status;
    counts[status]++;
    if (status === "up" || status === "down") nextExpiry = Math.min(nextExpiry, expiry);
    return { endpoint, status };
  });

  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(1, nextExpiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);

  return (
    <section className="overview-endpoint-scope" aria-labelledby="overview-endpoint-heading">
      <div className="overview-endpoint-heading">
        <OverviewIcon name="globe" />
        <h2 id="overview-endpoint-heading">Endpoint reachability</h2>
      </div>
      {servicesError ? (
        <p role="status">Endpoint reachability unavailable. {servicesError}</p>
      ) : !rows ? (
        <p role="status">Loading endpoint monitors…</p>
      ) : !rows.length ? (
        <p role="status">No endpoint monitors configured.</p>
      ) : (
        <>
          <p role="status">{counts.up} up · {counts.down} down · {counts.pending} pending · {counts.stale} stale</p>
          <ul className="overview-endpoint-list" role="list">
            {rows.map(({ endpoint, status }) => (
              <li key={endpoint.id} className="overview-endpoint-item">
                <div className="overview-endpoint-main">
                  <div>
                    <strong>{endpoint.name}</strong>
                    <span className="overview-meta">
                      {endpoint.target_url} · Probe: {endpoint.probe_location}
                      {endpoint.last_checked_at ? <> · Checked <SampleTime value={endpoint.last_checked_at} /></> : " · Not checked yet"}
                    </span>
                    {status === "stale" && <span className="overview-meta">Last result: {endpointResult(endpoint)}</span>}
                  </div>
                  <div className="overview-endpoint-actions">
                    <Badge tone={status === "up" ? "success" : status === "down" ? "danger" : "neutral"} dot>
                      {status === "stale" ? "Stale" : status === "pending" ? "Pending" : endpointResult(endpoint)}
                    </Badge>
                    <Button size="sm" loading={checkingEndpointId === endpoint.id} onClick={() => onCheckEndpoint(endpoint.id)}>
                      Check now
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <p>Probed independently of host metrics. A result becomes stale 60 seconds after its last check.</p>
    </section>
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
  onBrowseHosts,
  refreshKey = 0,
}: Props) {
  const [clock, setClock] = useState(Date.now);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hostServices, setHostServices] = useState<Record<string, HostServiceEntry>>({});
  const [offlineOnly, setOfflineOnly] = useState(false);
  const inspectorId = useId();
  const inspector = useRef<HTMLElement>(null);
  const inventoryHeading = useRef<HTMLHeadingElement>(null);
  const loaded = fleet?.hosts.length ?? 0;
  const cached = Boolean(fleet && fleetError);

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

  const selected = risks.find(({ host }) => host.id === selectedId) ?? risks[0];
  const matchingIncidents = selected ? incidents.filter(i =>
    i.agent_id === selected.host.id && i.category === categoryByResource[selected.reading.key],
  ) : [];
  const selectedIncident = matchingIncidents.find(i => i.status === "open") ?? matchingIncidents[0] ?? null;
  const visibleDevices = offlineOnly ? devices?.filter(({ host }) => host.status === "offline") : devices;
  const offline = fleet ? fleet.total - fleet.online : null;

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

  return (
    <div className="threshold-overview">
      <section className="overview-summary" aria-labelledby="overview-pressure-heading">
        <div className="overview-summary-statement">
          <h2 id="overview-pressure-heading">
            {assessed ? `${risks.length} ${risks.length === 1 ? "device" : "devices"} at risk` : "Device threshold pressure"}
          </h2>
          <p>{fleet ? `${scope} · ${assessed} assessed against a configured limit` : fleetError ? "Could not load fleet scope" : "Loading fleet scope…"}</p>
          {fleetError && (
            <p role="status">{cached && <>Cached inventory from <SampleTime value={fleet?.observed_at ?? null} />. </>}{fleetError}</p>
          )}
          <div className="overview-fleet-connectivity">
            {fleet ? (
              <dl aria-label={cached ? "Fleet agent connectivity, cached" : "Fleet agent connectivity"}>
                <div><dt>Agent online</dt><dd>{fleet.online}</dd></div>
                <div><dt>Agent offline</dt><dd>{offline}</dd></div>
              </dl>
            ) : <p role="status">{fleetError ? "Agent connectivity counts unavailable." : "Loading agent connectivity counts…"}</p>}
            {cached && <p>Agent counts are cached.</p>}
            {offline !== null && offline > 0 && (
              <Button size="sm" onClick={() => {
                setOfflineOnly(true);
                inventoryHeading.current?.focus();
              }}>Show offline devices <OverviewIcon name="arrow" /></Button>
            )}
          </div>
        </div>
        <dl className="overview-summary-readings">
          <SummaryReading label="At or above limit" value={assessed ? exceeded : null} state="exceeded" />
          <SummaryReading label="Near limit" value={assessed ? near : null} state="near" />
          <SummaryReading label={incidentsStale && openIncidents !== null ? "Open incidents · cached" : "Open incidents"} value={openIncidents} />
        </dl>
      </section>

      <div className="overview-pressure-workspace">
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
                  selected={selected?.host.id === risk.host.id}
                  inspectorId={inspectorId}
                  onSelect={() => {
                    setSelectedId(risk.host.id);
                    inspector.current?.focus();
                  }}
                />
              ))}
            </ul>
          ) : <p className="overview-empty">{emptyWatchlist}</p>}
          <p className="overview-rule">Devices are ranked by smallest limit margin. Near limit means no more than 5 percentage points below the configured limit. Readings at or above it count toward the exceeded total.</p>
        </section>

        <aside id={inspectorId} className="overview-inspector" aria-labelledby="overview-inspector-heading" ref={inspector} tabIndex={-1}>
          <h2 id="overview-inspector-heading" className={selected ? "sr-only" : undefined}>Pressure inspector</h2>
          {selected ? (
            <PressureInspector
              key={selected.host.id}
              risk={selected}
              refreshKey={refreshKey}
              incident={selectedIncident}
              incidentsStale={incidentsStale}
              incidentsLoading={openIncidents === null && !incidentsStale}
              onInspectHost={onInspectHost}
              onOpenIncident={onOpenIncident}
            />
          ) : (
            <p>A near-limit or exceeded device will show its current reading, threshold, sample time, and AI analysis here.</p>
          )}
        </aside>
      </div>

      <EndpointReachability endpoints={endpoints} servicesError={servicesError} checkingEndpointId={checkingEndpointId} onCheckEndpoint={onCheckEndpoint} />

      <section className="overview-inventory" aria-labelledby="overview-inventory-heading">
        <div className="overview-section-head">
          <div>
            <h2 id="overview-inventory-heading" ref={inventoryHeading} tabIndex={-1}>{offlineOnly ? "Offline devices" : "All devices"}</h2>
            {fleet && <p className="overview-meta">{scope} · {offlineOnly ? "Offline filter applies to loaded devices only" : "Reading / configured threshold"}{cached ? " · Cached" : ""}</p>}
          </div>
          {offlineOnly
            ? <Button size="sm" onClick={() => { setOfflineOnly(false); inventoryHeading.current?.focus(); }}>Show all devices</Button>
            : <Button size="sm" onClick={onBrowseHosts}>Browse hosts <OverviewIcon name="arrow" /></Button>}
        </div>
        {visibleDevices?.length ? (
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
        ) : <p className="overview-inventory-empty">{fleetError && !fleet ? "Device inventory unavailable." : !fleet ? "Loading device inventory…" : offlineOnly ? "No offline devices in the loaded inventory." : "No devices to show."}</p>}
      </section>
    </div>
  );
}
