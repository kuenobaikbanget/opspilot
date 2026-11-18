"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { BrandMark } from "../components/brand-mark";
import { Badge, Button, Field, Input, Notice, Panel, Select, Textarea } from "../components/ui";
import type { Host } from "@opspilot/contracts";
import { HostWorkspace } from "../components/host-workspace";
type Incident = { id: string; title: string; category: string; status: string; hostname: string; agent_id: string; created_at: string; resolution: string | null };
type Evidence = { id: string; source: string; content: string; created_at: string };
type Investigation = { id: string; provider: string; status: string; result_json: { probable_cause?: string; confidence?: number | string; evidence_ids?: string[]; recommended_checks?: string[] } | null; error: string | null };
type Detail = { incident: Incident; evidence: Evidence[]; investigations: Investigation[] };
type Memory = { id: string; summary: string; resolution: string; created_at: string };

const destinations = [
  { id: "hosts", label: "Hosts", title: "Fleet & services", description: "Infrastructure signals and endpoint checks. Side by side, never conflated.", icon: "M3 3h18v7H3z M3 14h18v7H3z M6 6h.01 M6 17h.01" },
  { id: "incidents", label: "Incidents", title: "Host incidents", description: "Measured evidence, advisory AI hypotheses and human-confirmed resolutions.", icon: "M12 8v5 M12 16h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" },
  { id: "drift", label: "Configuration drift", title: "Configuration drift", description: "Recorded configuration hash changes. Correlation is not causation.", icon: "M14 2H5v20h14V7z M14 2v5h5 M8 12h8 M8 16h5" },
  { id: "memory", label: "Incident memory", title: "Incident memory", description: "Human-confirmed resolutions from previous investigations.", icon: "M12 5v16 M3 3h5l4 2 4-2h5v16h-5l-4 2-4-2H3z" },
] as const;
type Destination = typeof destinations[number]["id"] | "providers";

async function api(path: string, method = "GET", payload?: unknown) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event("opspilot-unauthorized"));
    throw new Error("Unauthorized");
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export default function Home() {
  const [logged, setLogged] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [hosts, setHosts] = useState<Host[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [provider, setProvider] = useState("openai");
  const [title, setTitle] = useState("Manual service investigation");
  const [hostId, setHostId] = useState("");
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Destination>("hosts");
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [search, setSearch] = useState("");
  const [hostRefresh, setHostRefresh] = useState(0);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const enrollmentTrigger = useRef<HTMLButtonElement>(null);
  const focusIncident = useRef(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  useEffect(() => {
    const unauthorized = () => { setLogged(false); setHosts([]); setDetail(null); setSelected(null); };
    window.addEventListener("opspilot-unauthorized", unauthorized);
    return () => window.removeEventListener("opspilot-unauthorized", unauthorized);
  }, []);

  useEffect(() => {
    try {
      setSidebarCollapsed(localStorage.getItem("opspilot-sidebar-collapsed") === "true");
    } catch {
      // Navigation still works when browser storage is unavailable.
    }
  }, []);

  function toggleSidebar() {
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    try {
      localStorage.setItem("opspilot-sidebar-collapsed", String(collapsed));
    } catch {
      // Keep the current session's preference without persistent storage.
    }
  }

  const refresh = useCallback(async () => {
    setHostRefresh(value => value + 1);
    try {
      const [i, p] = await Promise.all([api("/incidents"), api("/ai/providers")]);
      setIncidents(i);
      setProviders(p.available);
      setProvider(old => p.available.includes(old) ? old : (p.available[0] || ""));
      setRefreshedAt(new Date().toISOString());
      setLogged(old => old === null ? true : old);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("Unauthorized")) setLogged(false);
      else setError(message);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await api(`/incidents/${id}`)); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => { if (selected) void loadDetail(selected); }, [selected, loadDetail]);
  useEffect(() => {
    if (detail && focusIncident.current) {
      focusIncident.current = false;
      document.getElementById("incident-detail-title")?.focus();
    }
  }, [detail]);
  useEffect(() => {
    if (tab === "memory") void api(`/memory?q=${encodeURIComponent(search)}`).then(setMemories).catch(e => setError(e.message));
  }, [tab, search]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      if (selected) await loadDetail(selected);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      await api("/auth/login", "POST", { password });
      setPassword("");
      setLogged(true);
    });
  }

  if (logged === null) return (
    <main className="center">
      <div>
        <p role="status">Loading OpsPilot…</p>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <Link href="/design-system">Explore the design system</Link>
      </div>
    </main>
  );

  if (!logged) return (
    <main className="login-container">
      <Panel className="login-card">
        <div className="logo"><BrandMark size={24} /><span>OpsPilot</span></div>
        <h1>Welcome back.</h1>
        <p className="muted">Sign in with your single-admin password.</p>
        <form onSubmit={login}>
          <Field id="admin-password" label="Admin password" required>
            <Input id="admin-password" autoFocus type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required minLength={1} />
          </Field>
          <Button type="submit" variant="primary" loading={busy}>Sign in</Button>
        </form>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <p className="tiny">Your data stays in your own OpsPilot database. AI calls require configured provider keys.</p>
        <Link href="/design-system">Explore the design system</Link>
      </Panel>
    </main>
  );

  const open = incidents.filter(i => i.status === "open").length;
  const page = destinations.find(item => item.id === tab);
  const fleetVisible = tab === "hosts";
  const incidentView = tab === "incidents" || tab === "drift";
  const visibleIncidents = tab === "drift" ? incidents.filter(i => i.category === "config_drift") : incidents;

  return (
    <div className="shell" data-sidebar-collapsed={sidebarCollapsed}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar" id="opspilot-sidebar" aria-label="OpsPilot">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="logo sidebar-brand-name"><BrandMark size={22} /><span>OpsPilot</span></div>
            <span className="sidebar-monogram" aria-hidden="true"><BrandMark size={26} /></span>
          </div>
          <Button variant="ghost" className="sidebar-utilities-toggle" aria-expanded={utilitiesOpen} aria-controls="sidebar-utilities" onClick={() => setUtilitiesOpen(value => !value)}>
            More
            <svg className="sidebar-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={utilitiesOpen ? "m6 12 4-4 4 4" : "m6 8 4 4 4-4"} /></svg>
          </Button>
        </div>
        <nav className="sidebar-navigation" aria-label="Main navigation">
          {destinations.map(item => (
            <Button key={item.id} variant="ghost" className={`nav ${tab === item.id ? "active" : ""}`} title={sidebarCollapsed ? item.label : undefined} aria-current={tab === item.id ? "page" : undefined} onClick={() => { setTab(item.id); setDetail(null); setSelected(null); }}>
              <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.icon} /></svg>
              <span className="sidebar-label">{item.label}</span>
            </Button>
          ))}
        </nav>
        <div className="sidebar-bottom" id="sidebar-utilities" data-open={utilitiesOpen}>
          <Button variant="ghost" className={`nav ${tab === "providers" ? "active" : ""}`} title={sidebarCollapsed ? "Provider settings" : undefined} aria-current={tab === "providers" ? "page" : undefined} onClick={() => setTab("providers")}>
            <svg className="sidebar-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h3m4 0h7M3 14h7m4 0h3M8 4v4m4 4v4" /></svg>
            <span className="sidebar-label">Provider settings</span>
          </Button>
          <Button variant="ghost" className="nav" title={sidebarCollapsed ? "Sign out" : undefined} disabled={busy} onClick={() => { setBusy(true); void api("/auth/logout", "POST").then(() => { setLogged(false); setHosts([]); setDetail(null); setSelected(null); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>
            <svg className="sidebar-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4M8 10h9m-4-4 4 4-4 4" /></svg>
            <span className="sidebar-label">Sign out</span>
          </Button>
        </div>
      </aside>

      <main className="content" id="main-content" tabIndex={-1}>
        <div className="dashboard-context"><span>{refreshedAt ? <>Incident/provider refresh <time dateTime={refreshedAt}>{new Date(refreshedAt).toLocaleTimeString()} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</time></> : "Waiting for observations"}</span></div>
        <header className="topbar">
          <div className="topbar-heading">
            <Button variant="ghost" className="sidebar-toggle" aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!sidebarCollapsed} aria-controls="opspilot-sidebar" onClick={toggleSidebar}>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2" /><path d="M7.5 3v14" /><path d={sidebarCollapsed ? "m11 8 2 2-2 2" : "m13 8-2 2 2 2"} /></svg>
            </Button>
            <div>
              <h1>{page?.title ?? "Provider settings"}</h1>
              <p className="muted">{page?.description ?? "Server-side AI configuration. Keys never leave the Hub."}</p>
            </div>
          </div>
          <div className="header-actions">
            <Button size="sm" variant="ghost" onClick={() => void refresh()}>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M16 7a6 6 0 1 0 .1 6M16 3v4h-4" /></svg>
              Refresh
            </Button>
            <Button ref={enrollmentTrigger} aria-expanded={enrollmentOpen} aria-controls="host-enrollment" onClick={() => { setTab("hosts"); setEnrollmentOpen(true); }}>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
              Enroll host
            </Button>
          </div>
        </header>

        {error && <Notice tone="danger" role="alert" className="dashboard-alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => setError("")}>Dismiss</Button></Notice>}

        <div hidden={!fleetVisible}><HostWorkspace refreshKey={hostRefresh} onHosts={setHosts} onUnauthorized={() => { setLogged(false); setHosts([]); setDetail(null); setSelected(null); }} openIncidents={open} incidents={incidents} onOpenIncident={id => { focusIncident.current = true; setTab("incidents"); setDetail(null); setSelected(id); setResolution(""); }} enrollmentOpen={enrollmentOpen && fleetVisible} onCloseEnrollment={() => { setEnrollmentOpen(false); enrollmentTrigger.current?.focus(); }} /></div>
        {incidentView && (
          <>
            <Panel role="region" aria-labelledby="incidents-title">
              <div className="panel-head"><div><h2 id="incidents-title">{tab === "drift" ? "Recorded hash changes" : "Incidents"}</h2><p>{tab === "drift" ? "Configuration drift incidents from the latest 100 records. This is not a complete file inventory." : "Diagnostics, evidence and AI analysis · Latest 100 records"}</p></div><Badge tone={visibleIncidents.some(i => i.status === "open") ? "warning" : "neutral"}>{visibleIncidents.filter(i => i.status === "open").length} open</Badge></div>
              <div className="list">
                {visibleIncidents.length === 0 ? <div className="empty">{tab === "drift" ? "No configuration drift in the latest 100 incident records. This does not establish that all configurations are unchanged." : "No incidents recorded. Create one manually to test the investigation flow."}</div> : visibleIncidents.map(i => (
                  <Button key={i.id} className={`incident ${selected === i.id ? "selected" : ""}`} aria-pressed={selected === i.id} onClick={() => { setSelected(i.id); setResolution(""); }}>
                    <span className="incident-main"><strong>{i.title}</strong><small>{i.hostname} · {i.category} · {new Date(i.created_at).toLocaleString()}</small></span>
                    <Badge tone={i.status === "resolved" ? "success" : "warning"}>{i.status}</Badge>
                  </Button>
                ))}
              </div>
                {tab === "incidents" && <form className="panel-footer" onSubmit={e => { e.preventDefault(); void act(async () => { const x = await api("/incidents", "POST", { agentId: hostId, title }); setSelected(x.id); }); }}>
                  <h3>Create a test incident</h3>
                  <Field id="incident-host" label="Server" required><Select id="incident-host" value={hostId} onChange={e => setHostId(e.target.value)} required><option value="">Choose a server</option>{hosts.map(h => <option key={h.id} value={h.id}>{h.hostname}</option>)}</Select></Field>
                  <Field id="incident-title" label="Incident title" required><Input id="incident-title" value={title} onChange={e => setTitle(e.target.value)} required minLength={3} /></Field>
                  <Button type="submit" loading={busy} disabled={!hostId || title.length < 3}>Create incident</Button>
                </form>}
              </Panel>

            {detail && (
              <Panel className="detail" role="region" aria-labelledby="incident-detail-title">
                <div className="panel-head"><div><h2 id="incident-detail-title" tabIndex={-1}>{detail.incident.title}</h2><p>{detail.incident.hostname} · {detail.incident.status}</p></div><Button variant="ghost" size="sm" onClick={() => { setDetail(null); setSelected(null); }}>Close detail</Button></div>
                <div className="detail-grid">
                  <div>
                    <h3>Collected evidence</h3>
                    <p className="muted small">Diagnostic records collected from the host.</p>
                    {detail.evidence.length === 0 ? <p className="muted">No evidence yet.</p> : detail.evidence.map(e => <div className="evidence" key={e.id}><strong>{e.source}</strong><code>{e.content}</code><small>ID: {e.id}</small></div>)}
                  </div>
                  <div>
                    <h3>AI investigation</h3>
                    <Notice tone="info" className="investigation-notice">AI findings are hypotheses. Review the cited evidence before taking action.</Notice>
                    <form className="investigation-form" onSubmit={e => { e.preventDefault(); void act(() => api(`/incidents/${detail.incident.id}/investigate`, "POST", { provider })); }}>
                      <Field id="ai-provider" label="AI provider"><Select id="ai-provider" value={provider} onChange={e => setProvider(e.target.value)} disabled={providers.length === 0}>{providers.length === 0 ? <option value="">No API keys configured</option> : providers.map(p => <option key={p} value={p}>{p}</option>)}</Select></Field>
                      <Button type="submit" variant="primary" loading={busy} disabled={!provider || detail.incident.status !== "open"}>Investigate</Button>
                    </form>
                    {detail.investigations.length === 0 ? <p className="muted">Investigation has not been started.</p> : detail.investigations.map(x => (
                      <div className="finding" key={x.id}>
                        <div className="finding-head"><span>{x.provider}</span><Badge tone={x.status === "failed" ? "danger" : x.status === "completed" ? "info" : "warning"}>{x.status}</Badge></div>
                        {x.result_json ? <><p><strong>AI hypothesis: {x.result_json.probable_cause}</strong></p><p>Confidence: {x.result_json.confidence}</p><p>Evidence: {x.result_json.evidence_ids?.join(", ") || "none"}</p>{x.result_json.recommended_checks && <ul>{x.result_json.recommended_checks.map((c, k) => <li key={k}>{c}</li>)}</ul>}</> : x.error ? <Notice tone="danger">{x.error}</Notice> : <p className="muted">Queued or running. Refresh in a few seconds.</p>}
                      </div>
                    ))}
                    {detail.incident.status === "open" ? (
                      <form className="resolution-form" onSubmit={e => { e.preventDefault(); void act(() => api(`/incidents/${detail.incident.id}/resolve`, "POST", { resolution })); }}>
                        <h3>Resolve &amp; save to memory</h3>
                        <Field id="incident-resolution" label="Confirmed resolution" hint="Describe what actually fixed this incident. Minimum 8 characters." required><Textarea id="incident-resolution" value={resolution} onChange={e => setResolution(e.target.value)} aria-describedby="incident-resolution-hint" rows={3} required minLength={8} /></Field>
                        <Button type="submit" loading={busy} disabled={resolution.trim().length < 8}>Mark resolved</Button>
                      </form>
                    ) : <Notice tone="success"><strong>Human-confirmed resolution</strong><p>{detail.incident.resolution}</p></Notice>}
                  </div>
                </div>
              </Panel>
            )}
          </>
        )}
        {tab === "memory" && (
          <Panel role="region" aria-labelledby="memory-title">
            <div className="panel-head"><div><h2 id="memory-title">Resolved incident knowledge</h2><p>Full-text incident retrieval for future investigations</p></div></div>
            <Field id="memory-search" label="Search confirmed resolutions"><Input id="memory-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search symptoms, service, resolution…" /></Field>
            {memories.length === 0 ? <p className="empty">No matching resolved incidents yet.</p> : memories.map(m => <div key={m.id} className="memory"><Badge tone="success">Human-confirmed</Badge><h3>{m.summary}</h3><p>{m.resolution}</p><small>{new Date(m.created_at).toLocaleString()}</small></div>)}
          </Panel>
        )}
        {tab === "providers" && <Panel className="provider-settings" role="region" aria-labelledby="provider-settings-title"><div className="panel-head"><div><h2 id="provider-settings-title">AI provider availability</h2><p>Configuration status reported by the Hub; no credentials are returned.</p></div><Badge tone="info">Read-only configuration</Badge></div><dl className="provider-list">{["openai", "anthropic", "gemini"].map(name => <div key={name}><dt>{name}</dt><dd><Badge tone={providers.includes(name) ? "success" : "neutral"}>{providers.includes(name) ? "Configured" : "Not configured"}</Badge></dd></div>)}</dl><p className="muted">Provider keys are managed in the Hub server environment. After updating that environment, restart the Hub and refresh this page.</p><Notice tone="info">Inspection does not call a model. AI investigation remains a separate explicit action on an open incident.</Notice></Panel>}
        <footer>OpsPilot starter · No automatic remediation · Read-only diagnostics only</footer>
      </main>
    </div>
  );
}
