import { useEffect, useId, useRef, useState } from "react";
import { finitePercent, type EndpointMonitor, type Host, type HostList } from "@opspilot/contracts";
import { api } from "../lib/api";
import { hasFreshSample, percent, pressure, resources, type Pressure, type Resource } from "../lib/host-pressure";
import { Badge, Button } from "./ui";

export type OverviewIncidentSummary = {
  id: string;
  agent_id: string;
  title: string;
  category: string;
  status: string;
  created_at: string;
};

type InvestigationSummary = {
  id: string;
  status: string;
  provider: { name: string; model: string | null };
  result_json: {
    probable_cause?: string;
    confidence?: string | number;
    recommended_checks?: string[];
  } | null;
  error: string | null;
};

type Props = {
  fleet: HostList | null;
  fleetError: string;
  openIncidents: number | null;
  incidentsStale: boolean;
  incidents: OverviewIncidentSummary[];
  endpoints: EndpointMonitor[];
  servicesError: string;
  checkingEndpointId: string | null;
  onCheckEndpoint: (id: string) => void;
  onOpenIncident: (id: string) => void;
  onInspectHost: (id: string, resource?: Resource) => void;
  onBrowseHosts: () => void;
};

type Risk = { host: Host; reading: Pressure };

const icons = {
  server: <><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/></>,
  sort: <path d="M4 4v16m-3-3 3 3 3-3M10 5h11M10 10h8m-8 5h5"/>,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6"/>,
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

function headroomMagnitude(value: number) {
  const magnitude = Math.abs(value);
  if (magnitude > 0 && magnitude < 0.1) return "<0.1";
  return `${Number(magnitude.toFixed(1))}`;
}

function marginLabel(headroom: number) {
  if (headroom === 0) return "At limit";
  return `${headroomMagnitude(headroom)}% ${headroom > 0 ? "below limit" : "over limit"}`;
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

function RiskCard({ risk, selected, inspectorId, onSelect }: {
  risk: Risk;
  selected: boolean;
  inspectorId: string;
  onSelect: () => void;
}) {
  const { host, reading } = risk;
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
          <div><dt>Margin</dt><dd>{marginLabel(reading.headroom)}</dd></div>
        </dl>
        <ThresholdBar share={limitShare(reading)} />
      </div>
    </li>
  );
}

function PressureInspector({
  risk,
  incident,
  investigation,
  investigationLoading,
  onInspectHost,
  onOpenIncident,
}: {
  risk: Risk;
  incident: OverviewIncidentSummary | null;
  investigation: InvestigationSummary | null;
  investigationLoading: boolean;
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
            {headroomMagnitude(reading.headroom)}% <span>{reading.headroom < 0 ? "over limit" : reading.headroom === 0 ? "at limit" : "below limit"}</span>
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
        <section className="overview-ai-card" aria-label="Advisory AI analysis">
          <div className="overview-ai-head">
            <span className="overview-meta">AI hypothesis (advisory)</span>
            {investigation ? (
              <Badge tone={investigation.status === "failed" ? "danger" : investigation.status === "completed" ? "info" : "warning"}>
                {investigation.status}
              </Badge>
            ) : (
              <Badge>Not run</Badge>
            )}
          </div>
          {investigationLoading ? (
            <p className="overview-meta" role="status">Loading recorded AI analysis…</p>
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
          ) : investigation?.error ? (
            <p className="overview-meta">{investigation.error}</p>
          ) : investigation ? (
            <p className="overview-meta">Investigation is {investigation.status}. Open the incident to inspect progress.</p>
          ) : (
            <p className="overview-meta">
              {incident
                ? "No AI investigation has been run for this host’s open incident yet."
                : "No recorded incident or AI analysis for this host."}
            </p>
          )}
        </section>
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
        <Badge dot>{host.status === "online" ? "Agent online" : "Agent offline"}{cached ? " · cached" : ""}</Badge>
        <span className="overview-meta">{fresh ? <SampleTime value={host.sampled_at} /> : cached ? "No current reading" : host.sampled_at ? "No fresh online sample" : "No sample received"}</span>
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
}: Props) {
  const [clock, setClock] = useState(Date.now);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [incidentDetails, setIncidentDetails] = useState<Record<string, InvestigationSummary | null>>({});
  const [loadingIncidentId, setLoadingIncidentId] = useState<string | null>(null);
  const inspectorId = useId();
  const inspector = useRef<HTMLElement>(null);
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
  const selected = risks.find(({ host }) => host.id === selectedId) ?? risks[0];
  const selectedIncident = selected
    ? incidents.find(i => i.agent_id === selected.host.id && i.status === "open")
      ?? incidents.find(i => i.agent_id === selected.host.id)
      ?? null
    : null;

  useEffect(() => {
    const id = selectedIncident?.id;
    if (!id) return;
    let active = true;
    setLoadingIncidentId(id);
    void api(`/incidents/${id}`)
      .then((data: { investigations?: InvestigationSummary[] }) => {
        if (!active) return;
        setIncidentDetails(prev => ({ ...prev, [id]: data.investigations?.[0] ?? null }));
      })
      .catch(() => {
        if (!active) return;
        setIncidentDetails(prev => ({ ...prev, [id]: prev[id] ?? null }));
      })
      .finally(() => {
        if (active) setLoadingIncidentId(current => (current === id ? null : current));
      });
    return () => { active = false; };
  }, [selectedIncident?.id]);

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
          <div className="overview-endpoint-scope">
            <div className="overview-endpoint-heading">
              <OverviewIcon name="globe" />
              <h3>Endpoint reachability</h3>
              {servicesError ? (
                <Badge tone="warning">Unavailable</Badge>
              ) : endpoints.length ? (
                <Badge tone={endpoints.some(e => e.last_status === "down") ? "danger" : endpoints.some(e => e.last_status === "up") ? "success" : "neutral"}>
                  {endpoints.filter(e => e.last_status === "up").length} / {endpoints.length} up
                </Badge>
              ) : (
                <Badge>Not measured</Badge>
              )}
            </div>
            {servicesError ? (
              <p>{servicesError}</p>
            ) : endpoints.length ? (
              <ul className="overview-endpoint-list" role="list">
                {endpoints.map(endpoint => (
                  <li key={endpoint.id} className="overview-endpoint-item">
                    <div className="overview-endpoint-main">
                      <div>
                        <strong>{endpoint.name}</strong>
                        <span className="overview-meta">
                          {endpoint.target_url} · Probe: {endpoint.probe_location}
                          {endpoint.last_checked_at ? <> · Checked <SampleTime value={endpoint.last_checked_at} /></> : " · Not checked yet"}
                        </span>
                      </div>
                      <div className="overview-endpoint-actions">
                        <Badge tone={endpoint.last_status === "up" ? "success" : endpoint.last_status === "down" ? "danger" : "neutral"} dot>
                          {endpoint.last_status === "up"
                            ? `Up · HTTP ${endpoint.last_http_status ?? endpoint.expected_status}${endpoint.last_latency_ms !== null ? ` · ${endpoint.last_latency_ms} ms` : ""}`
                            : endpoint.last_status === "down"
                              ? `Down · ${endpoint.last_http_status !== null ? `HTTP ${endpoint.last_http_status}` : endpoint.last_error ?? "unreachable"}`
                              : "Pending"}
                        </Badge>
                        <Button
                          size="sm"
                          loading={checkingEndpointId === endpoint.id}
                          onClick={() => onCheckEndpoint(endpoint.id)}
                        >
                          Check now
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Endpoint checks are not collected. Device readings do not establish endpoint availability.</p>
            )}
            <p className="overview-meta">Endpoint reachability is probed independently from host resource metrics.</p>
          </div>
          <p className="overview-rule">Devices are ranked by least margin below limit. Near limit means within 5% below the configured limit; readings at or above it count toward the exceeded total.</p>
        </section>

        <aside id={inspectorId} className="overview-inspector" aria-labelledby="overview-inspector-heading" ref={inspector} tabIndex={-1}>
          <h2 id="overview-inspector-heading" className={selected ? "sr-only" : undefined}>Pressure inspector</h2>
          {selected ? (
            <PressureInspector
              risk={selected}
              incident={selectedIncident}
              investigation={selectedIncident ? (incidentDetails[selectedIncident.id] ?? null) : null}
              investigationLoading={Boolean(selectedIncident && loadingIncidentId === selectedIncident.id && !(selectedIncident.id in incidentDetails))}
              onInspectHost={onInspectHost}
              onOpenIncident={onOpenIncident}
            />
          ) : (
            <p>A near-limit or exceeded device will show its current reading, threshold, sample time, and AI analysis here.</p>
          )}
        </aside>
      </div>

      <section className="overview-inventory" aria-labelledby="overview-inventory-heading">
        <div className="overview-section-head">
          <div>
            <h2 id="overview-inventory-heading">All devices</h2>
            {fleet && <p className="overview-meta">{scope} · Reading / configured threshold</p>}
          </div>
          <Button size="sm" onClick={onBrowseHosts}>Browse hosts <OverviewIcon name="arrow" /></Button>
        </div>
        {devices?.length ? (
          <ul className="overview-inventory-list" role="list">
            {devices.map(({ host, fresh }) => (
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
        ) : <p className="overview-inventory-empty">{fleetError ? "Device inventory unavailable." : fleet ? "No devices to show." : "Loading device inventory…"}</p>}
      </section>
    </div>
  );
}
