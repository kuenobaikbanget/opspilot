"use client";

import { useEffect, useRef, useState } from "react";
import type { Host, HostList, HostMetric } from "@opspilot/contracts";
import { Badge, Button, Field, Input, Notice, Panel } from "../components/ui";

type Props = { refreshKey: number; onHosts: (hosts: Host[]) => void; onUnauthorized: () => void; openIncidents: number };
const percent = (n: number | null) => n == null || !Number.isFinite(n) ? "Unavailable" : `${n.toFixed(1)}%`;
const stamp = (s: string | null) => s ? new Date(s).toLocaleString() : "Not observed";
const age = (s: string | null, now: number) => s ? `${Math.max(0, Math.floor((now - Date.parse(s)) / 1000))}s ago` : "Not observed";
async function request(path: string, signal?: AbortSignal, method = "GET") {
  const r = await fetch(`/api${path}`, { credentials: "same-origin", cache: "no-store", signal, method });
  if (r.status === 401) throw new Error("Unauthorized");
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || `HTTP ${r.status}`);
  return value;
}

function CpuHistory({ samples }: { samples: HostMetric[] }) {
  const rows = [...samples].sort((a, b) => Date.parse(a.sampled_at) - Date.parse(b.sampled_at));
  const valid = rows.filter(r => r.cpu_percent != null && Number.isFinite(r.cpu_percent));
  if (!rows.length) return <p className="empty">No CPU samples received yet. History is unavailable.</p>;
  const start = Date.parse(rows[0].sampled_at), end = Date.parse(rows[rows.length - 1].sampled_at);
  const x = (t: number) => 40 + ((t - start) / (end - start || 1)) * 520;
  const y = (n: number) => 150 - n * 1.3;
  const paths: string[] = [];
  let path = "", previous: number | null = null;
  for (const row of rows) {
    const t = Date.parse(row.sampled_at);
    if (row.cpu_percent == null || !Number.isFinite(row.cpu_percent)) { if (path) paths.push(path); path = ""; previous = null; continue; }
    if (previous != null && t - previous > 60000) { if (path) paths.push(path); path = ""; }
    path += `${path ? " L" : "M"}${x(t)},${y(row.cpu_percent)}`;
    previous = t;
  }
  if (path) paths.push(path);
  return <figure className="cpu-history">
    <figcaption><h3>CPU history</h3><p>{rows.length} raw samples · No aggregation · Up to 120 retained samples</p></figcaption>
    <svg viewBox="0 0 580 180" role="img" aria-label={`CPU usage, 0 to 100 percent. ${valid.length} measured samples from ${stamp(rows[0].sampled_at)} to ${stamp(rows[rows.length - 1].sampled_at)}. Gaps over 60 seconds are not connected.`}>
      {[0, 50, 100].map(n => <g key={n}><line x1="40" x2="560" y1={y(n)} y2={y(n)} className="chart-grid" /><text x="0" y={y(n) + 4}>{n}%</text></g>)}
      {paths.map((d, i) => <path key={i} d={d} className="chart-line" />)}
      {valid.map((r, i) => <circle key={i} cx={x(Date.parse(r.sampled_at))} cy={y(r.cpu_percent!)} r="2.5" className="chart-point"><title>{stamp(r.sampled_at)} · {percent(r.cpu_percent)}</title></circle>)}
    </svg>
    <div className="chart-range"><time>{stamp(rows[0].sampled_at)}</time><time>{stamp(rows[rows.length - 1].sampled_at)}</time></div>
    <p className="tiny">Server receipt timestamps · 0–100% · Gaps over 60s remain gaps.</p>
    {!valid.length && <p>CPU measurements unavailable for this range.</p>}
  </figure>;
}

export function HostWorkspace({ refreshKey, onHosts, onUnauthorized, openIncidents }: Props) {
  const [fleet, setFleet] = useState<HostList | null>(null);
  const [failure, setFailure] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState("");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [history, setHistory] = useState<{ id: string; samples: HostMetric[] } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [token, setToken] = useState<{ value: string; expires: number } | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState("");
  const [copied, setCopied] = useState(false);
  const [hubUrl, setHubUrl] = useState("");
  const callbacks = useRef({ onHosts, onUnauthorized });
  callbacks.current = { onHosts, onUnauthorized };
  useEffect(() => {
    let active = true, pending = false;
    const controller = new AbortController();
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const next: HostList = await request("/hosts", controller.signal);
        if (!active) return;
        setFleet(next); setFailure(""); callbacks.current.onHosts(next.hosts);
        if (selectedRef.current && !next.hosts.some(h => h.id === selectedRef.current)) {
          setSelected(null);
          setSelectionNotice("The selected host is no longer in the loaded host list. Select another host.");
        }
      } catch (e) {
        if (!active) return;
        const message = e instanceof Error ? e.message : String(e);
        if (message === "Unauthorized") callbacks.current.onUnauthorized();
        else setFailure(message);
      } finally { pending = false; }
    }
    void load(); const poll = setInterval(() => void load(), 10000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; controller.abort(); clearInterval(poll); clearInterval(clock); };
  }, [refreshKey]);
  useEffect(() => {
    setHistory(null); setHistoryError("");
    if (!selected) return;
    let active = true; let pending = false;
    const controller = new AbortController();
    async function load() {
      if (pending) return; pending = true;
      try {
        const samples: HostMetric[] = await request(`/hosts/${selected}/metrics`, controller.signal);
        if (active) { setHistory({ id: selected!, samples }); setHistoryError(""); }
      } catch (e) {
        if (!active) return;
        const message = e instanceof Error ? e.message : String(e);
        if (message === "Unauthorized") callbacks.current.onUnauthorized(); else setHistoryError(message);
      } finally { pending = false; }
    }
    void load(); const poll = setInterval(() => void load(), 10000);
    return () => { active = false; controller.abort(); clearInterval(poll); };
  }, [selected]);
  useEffect(() => { if (token && now >= token.expires) setToken(null); }, [now, token]);
  const hosts = fleet?.hosts ?? [];
  const visible = hosts.filter(h => `${h.hostname} ${h.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const host = hosts.find(h => h.id === selected);
  const stale = (h: Host) => !h.sampled_at || now - Date.parse(h.sampled_at) > (fleet?.stale_after_seconds ?? 60) * 1000;
  async function enroll() {
    setEnrolling(true); setEnrollError(""); setCopied(false); setToken(null);
    try { const result = await request("/agents/enrollment-token", undefined, "POST"); setToken({ value: result.token, expires: Date.now() + result.expiresInSeconds * 1000 }); }
    catch (e) { const message = e instanceof Error ? e.message : String(e); if (message === "Unauthorized") onUnauthorized(); else setEnrollError(message); }
    finally { setEnrolling(false); }
  }
  return <section aria-labelledby="fleet-title" className="fleet-section">
    <div className="fleet-summary" aria-label="Fleet summary"><span>Hosts online <strong>{fleet ? `${fleet.online} / ${fleet.total}` : "Unavailable"}</strong></span><span>Open incidents (latest 100) <strong>{openIncidents}</strong></span><span>Workloads: unavailable</span><span>Endpoints: unavailable</span></div>
    {failure && <Notice tone="warning" role="alert">Host refresh failed: {failure}. {fleet ? `Showing stale cached values from ${stamp(fleet.observed_at)}; connectivity may have changed.` : "Fleet data is unavailable, not an empty fleet."}</Notice>}
    <div className="fleet-workspace">
      <div className="fleet-list">
        <div className="panel-head"><div><h2 id="fleet-title">Hosts</h2><p>Agent connectivity and measured resources · Freshness window {fleet?.stale_after_seconds ?? 60}s</p></div></div>
        <div className="host-search"><Field id="host-search" label="Search hosts"><Input id="host-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Hostname or host ID" /></Field>{query && <Button onClick={() => setQuery("")}>Clear search</Button>}</div>
        <p className="tiny">{fleet ? `${hosts.length} of ${fleet.total} hosts loaded (limit ${fleet.limit}). Fleet observed ${stamp(fleet.observed_at)}.` : "Loading host inventory…"}</p>
        <div className="host-table-scroll" role="region" aria-label="Host inventory table, horizontally scrollable" tabIndex={0}>
          <table className="host-table"><caption className="sr-only">Host connectivity, resources and telemetry freshness</caption><thead><tr><th scope="col">Host</th><th scope="col">Agent</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Disk</th><th scope="col">Telemetry</th></tr></thead><tbody>{visible.map(h => <tr key={h.id} className={selected === h.id ? "host-selected" : ""}>
            <th scope="row"><Button variant="ghost" aria-pressed={selected === h.id} onClick={() => { setSelected(h.id); setSelectionNotice(""); }}>{h.hostname}<span className="sr-only">{selected === h.id ? ", selected" : ", inspect host"}</span></Button><small>{h.version || "Version unavailable"}</small></th>
            <td><Badge tone={failure ? "neutral" : h.status === "online" ? "success" : "neutral"}>{h.status}{failure ? " (cached)" : ""}</Badge></td>
            {[h.cpu_percent, h.memory_percent, h.disk_percent].map((v, i) => <td key={i}>{percent(v)}{v != null && (h.status === "offline" || stale(h) || failure) && <small>Historical</small>}</td>)}
            <td><span>{age(h.sampled_at, now)}</span><small>{stale(h) ? "Stale / unavailable" : "Within freshness window"}</small></td>
          </tr>)}</tbody></table>
        </div>
        {fleet && !hosts.length && <p className="empty">No hosts enrolled. Create a one-time token below to connect your first Linux host.</p>}
        {hosts.length > 0 && !visible.length && <p className="empty" role="status">No hosts match “{query}”. <Button variant="ghost" onClick={() => setQuery("")}>Clear search</Button></p>}
      </div>
      <Panel className="host-inspector" role="region" aria-labelledby="host-inspector-title">
        <div className="panel-head"><h2 id="host-inspector-title">{host ? host.hostname : "Host inspector"}</h2>{host && <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close</Button>}</div>
        {!host ? <p className="muted" role="status">{selectionNotice || "Select a host to inspect its observations and CPU history."}</p> : <>
          <Badge tone={host.status === "online" && !failure ? "success" : "neutral"}>{host.status}{failure ? " (cached)" : ""}</Badge>
          <dl className="host-facts"><dt>Host ID</dt><dd>{host.id}</dd><dt>Agent version</dt><dd>{host.version || "Unavailable"}</dd><dt>Last seen</dt><dd>{stamp(host.last_seen_at)} · {age(host.last_seen_at, now)}</dd><dt>Sample received</dt><dd>{stamp(host.sampled_at)} · {age(host.sampled_at, now)}</dd><dt>Sample freshness</dt><dd>{stale(host) ? "Stale / unavailable" : "Within 60s window"}</dd>{([['CPU', host.cpu_percent], ['Memory', host.memory_percent], ['Disk', host.disk_percent]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{percent(value)}{value != null && (host.status === "offline" || stale(host) || failure) ? " · Historical, not live" : ""}</dd></div>)}</dl>
          {historyError && <Notice tone="warning">CPU history refresh failed: {historyError}. {history?.id === host.id ? "Cached history below is stale." : "History unavailable."}</Notice>}
          {history && history.id === host.id ? <CpuHistory samples={history.samples} /> : !historyError && <p role="status">Loading CPU history…</p>}
          <p className="tiny">Workloads unavailable — not collected. Endpoints unavailable — not monitored. Agent connectivity does not establish service health. No root cause inferred.</p>
        </>}
      </Panel>
    </div>
    <section className="host-enrollment" aria-labelledby="enroll-host-title"><h2 id="enroll-host-title">Enroll a Linux host</h2><p className="muted">Admin-only, one-time secret. Expires in 10 minutes; never stored in this browser.</p><Button loading={enrolling} onClick={() => void enroll()}>Generate enrollment token</Button>
      {enrollError && <Notice tone="danger" role="alert">{enrollError}</Notice>}
      {token && <div className="enrollment-secret"><p>Expires {new Date(token.expires).toLocaleTimeString()} · {Math.max(0, Math.ceil((token.expires - now) / 1000))}s remaining. Usable once; creating another does not revoke earlier tokens.</p><div className="token"><code>{token.value}</code><Button size="sm" onClick={() => void navigator.clipboard.writeText(token.value).then(() => setCopied(true)).catch(() => setEnrollError("Clipboard unavailable. Select and copy the token manually."))}>{copied ? "Copied" : "Copy token"}</Button><Button size="sm" variant="ghost" onClick={() => setToken(null)}>Hide secret</Button></div></div>}
      <Field id="agent-hub-url" label="Hub URL reachable from the Linux host" hint="Use HTTPS for remote hosts. The hub must accept agent HTTP/WebSocket connections." ><Input id="agent-hub-url" type="url" value={hubUrl} onChange={e => setHubUrl(e.target.value)} placeholder="https://your-hub.example.com" aria-describedby="agent-hub-url-hint" /></Field>
      <p className="small">On the Linux host, install Go and obtain this OpsPilot repository. From its root, run:</p><pre className="agent-command"><code>{`cd agent\ngo mod download\nOPSPILOT_HUB_URL='${(hubUrl || "https://YOUR-HUB-HOST").replaceAll("'", "'\\''")}' \\\nOPSPILOT_ENROLL_TOKEN='<paste the one-time token>' \\\ngo run ./cmd/opspilot-agent`}</code></pre><p className="tiny">Identity is saved at ~/.local/share/opspilot-agent/identity.json (0600). Later starts reuse it without an enrollment token. Keep the agent running; this table refreshes every 10 seconds.</p>
    </section>
  </section>;
}
