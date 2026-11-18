import { useEffect, useId, useRef, useState } from "react";
import { finitePercent, type Host, type HostList } from "@opspilot/contracts";
import { hasFreshSample, percent, pressure, resources, type Pressure, type Resource } from "../lib/host-pressure";
import { Badge, Button } from "./ui";

type Props = {
  fleet: HostList | null;
  fleetError: string;
  openIncidents: number | null;
  incidentsStale: boolean;
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

function headroomText(value: number) {
  const magnitude = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (magnitude > 0 && magnitude < 0.1) return value < 0 ? "−<0.1" : "<0.1";
  return `${sign}${Number(magnitude.toFixed(1))}`;
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
          <div><dt>Headroom</dt><dd>{headroomText(reading.headroom)} <abbr title="percentage points">pp</abbr></dd></div>
        </dl>
        <ThresholdBar share={limitShare(reading)} />
      </div>
    </li>
  );
}

function PressureInspector({ risk, onInspectHost }: { risk: Risk; onInspectHost: Props["onInspectHost"] }) {
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
          <p className="overview-meta">{reading.label} headroom</p>
          <p className="overview-headroom">
            {headroomText(reading.headroom)} <abbr title="percentage points">pp</abbr>
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
        <Button variant="primary" size="sm" onClick={() => onInspectHost(host.id, reading.key)}>
          Open host history <OverviewIcon name="arrow" />
        </Button>
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
          <span className="overview-meta">{host.version ? `Agent ${host.version}` : "Device"}</span>
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

export function ThresholdOverview({ fleet, fleetError, openIncidents, incidentsStale, onInspectHost, onBrowseHosts }: Props) {
  const [clock, setClock] = useState(Date.now);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
            <h2 id="overview-watchlist-heading">Device &amp; endpoint watchlist</h2>
            <span className="overview-meta overview-sort"><OverviewIcon name="sort" /> Risk first</span>
          </div>
          {risks.length ? (
            <ul className="overview-risk-list" role="list">
              {risks.map((risk) => (
                <RiskCard key={risk.host.id} risk={risk} selected={selected?.host.id === risk.host.id} inspectorId={inspectorId} onSelect={() => {
                  setSelectedId(risk.host.id);
                  inspector.current?.focus();
                }} />
              ))}
            </ul>
          ) : <p className="overview-empty">{emptyWatchlist}</p>}
          <div className="overview-endpoint-scope">
            <div className="overview-endpoint-heading">
              <OverviewIcon name="globe" />
              <h3>Endpoint reachability</h3>
              <Badge>Not measured</Badge>
            </div>
            <p>Endpoint checks are not collected. Device readings do not establish endpoint availability.</p>
          </div>
          <p className="overview-rule">Devices are ranked by least headroom. Near limit means within 5 percentage points below the configured limit; readings at or above it count toward the exceeded total.</p>
        </section>

        <aside id={inspectorId} className="overview-inspector" aria-labelledby="overview-inspector-heading" ref={inspector} tabIndex={-1}>
          <h2 id="overview-inspector-heading" className={selected ? "sr-only" : undefined}>Pressure inspector</h2>
          {selected ? <PressureInspector risk={selected} onInspectHost={onInspectHost} /> : (
            <p>A near-limit or exceeded device will show its current reading, threshold, and sample time here.</p>
          )}
        </aside>
      </div>

      <section className="overview-inventory" aria-labelledby="overview-inventory-heading">
        <div className="overview-section-head">
          <div>
            <h2 id="overview-inventory-heading">Device &amp; service</h2>
            {fleet && <p className="overview-meta">{scope} · Reading / configured threshold</p>}
          </div>
          <Button size="sm" onClick={onBrowseHosts}>Browse hosts <OverviewIcon name="arrow" /></Button>
        </div>
        {devices?.length ? (
          <ul className="overview-inventory-list" role="list">
            {devices.map(({ host, fresh }) => (
              <InventoryRow key={host.id} host={host} fresh={fresh} cached={cached} thresholds={thresholds} onInspectHost={onInspectHost} />
            ))}
          </ul>
        ) : <p className="overview-inventory-empty">{fleetError ? "Device inventory unavailable." : fleet ? "No devices to show." : "Loading device inventory…"}</p>}
        <div className="overview-services-scope">
          <h3>Service availability</h3>
          <Badge>Not collected</Badge>
          <p>Service status is independent of agent connectivity.</p>
        </div>
      </section>
    </div>
  );
}
