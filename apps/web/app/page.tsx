"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Badge, Button, Field, Input, Notice, Panel, Select, Textarea } from "../components/ui";
import type { Host } from "@opspilot/contracts";
import { HostWorkspace } from "./host-workspace";
type Incident = { id: string; title: string; category: string; status: string; hostname: string; agent_id: string; created_at: string; resolution: string | null };
type Evidence = { id: string; source: string; content: string; created_at: string };
type Investigation = { id: string; provider: string; status: string; result_json: { probable_cause?: string; confidence?: number | string; evidence_ids?: string[]; recommended_checks?: string[] } | null; error: string | null };
type Detail = { incident: Incident; evidence: Evidence[]; investigations: Investigation[] };
type Memory = { id: string; summary: string; resolution: string; created_at: string };

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
  const [tab, setTab] = useState<"overview" | "memory">("overview");
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [search, setSearch] = useState("");
  const [hostRefresh, setHostRefresh] = useState(0);
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
        <div className="logo">OpsPilot</div>
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

  return (
    <div className="shell" data-sidebar-collapsed={sidebarCollapsed}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar" id="opspilot-sidebar" aria-label="OpsPilot">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="logo sidebar-brand-name">OpsPilot</div>
            <span className="sidebar-monogram" aria-hidden="true">OP</span>
            <span className="sidebar-context">Self-hosted</span>
          </div>
          <Button variant="ghost" className="sidebar-utilities-toggle" aria-expanded={utilitiesOpen} aria-controls="sidebar-utilities" onClick={() => setUtilitiesOpen(value => !value)}>
            Utilities
            <svg className="sidebar-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={utilitiesOpen ? "m6 12 4-4 4 4" : "m6 8 4 4 4-4"} /></svg>
          </Button>
        </div>
        <nav className="sidebar-navigation" aria-label="Main navigation" data-active={tab}>
          <span className="sidebar-indicator" aria-hidden="true" />
          <Button variant="ghost" className={`nav ${tab === "overview" ? "active" : ""}`} title={sidebarCollapsed ? "Overview" : undefined} aria-current={tab === "overview" ? "page" : undefined} onClick={() => setTab("overview")}>
            <svg className="sidebar-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M3 8h14M8 8v9" /></svg>
            <span className="sidebar-label">Overview</span>
          </Button>
          <Button variant="ghost" className={`nav ${tab === "memory" ? "active" : ""}`} title={sidebarCollapsed ? "Incident memory" : undefined} aria-current={tab === "memory" ? "page" : undefined} onClick={() => setTab("memory")}>
            <svg className="sidebar-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 5c-2-2-5-2-7-1v12c2-1 5-1 7 1 2-2 5-2 7-1V4c-2-1-5-1-7 1Zm0 0v12" /></svg>
            <span className="sidebar-label">Incident memory</span>
          </Button>
        </nav>
        <div className="sidebar-bottom" id="sidebar-utilities" data-open={utilitiesOpen}>
          <Link className="nav sidebar-catalog" href="/design-system" title={sidebarCollapsed ? "Design system" : undefined}>
            <svg className="sidebar-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="5" height="5" rx="1" /><rect x="12" y="3" width="5" height="5" rx="1" /><rect x="3" y="12" width="5" height="5" rx="1" /><rect x="12" y="12" width="5" height="5" rx="1" /></svg>
            <span className="sidebar-label">Design system</span>
          </Link>
          <div className="sidebar-account">
            <p className="sidebar-account-context">Single-admin mode</p>
            <Button variant="ghost" className="nav" title={sidebarCollapsed ? "Sign out" : undefined} disabled={busy} onClick={() => { setBusy(true); void api("/auth/logout", "POST").then(() => { setLogged(false); setHosts([]); setDetail(null); setSelected(null); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>
              <svg className="sidebar-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4M8 10h9m-4-4 4 4-4 4" /></svg>
              <span className="sidebar-label">Sign out</span>
            </Button>
          </div>
        </div>
      </aside>

      <main className="content" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <div className="topbar-heading">
            <Button variant="ghost" className="sidebar-toggle" aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!sidebarCollapsed} aria-controls="opspilot-sidebar" onClick={toggleSidebar}>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2" /><path d="M7.5 3v14" /><path d={sidebarCollapsed ? "m11 8 2 2-2 2" : "m13 8-2 2 2 2"} /></svg>
            </Button>
            <div>
              <h1>{tab === "overview" ? "Server overview" : "Incident memory"}</h1>
              <p className="muted">Independent hub · Outbound agents · Evidence-first AI</p>
            </div>
          </div>
          <Button onClick={() => void refresh()}>Refresh</Button>
        </header>

        {error && <Notice tone="danger" role="alert" className="dashboard-alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => setError("")}>Dismiss</Button></Notice>}

        {tab === "overview" ? (
          <>
            <HostWorkspace refreshKey={hostRefresh} onHosts={setHosts} onUnauthorized={() => { setLogged(false); setHosts([]); setDetail(null); setSelected(null); }} openIncidents={open} />
            <Panel role="region" aria-labelledby="incidents-title">
              <div className="panel-head"><div><h2 id="incidents-title">Incidents</h2><p>Diagnostics, evidence and AI analysis</p></div><Badge tone={open ? "warning" : "neutral"}>{open} open</Badge></div>
              <div className="list">
                {incidents.length === 0 ? <div className="empty">No incidents recorded. Create one manually to test the investigation flow.</div> : incidents.map(i => (
                  <Button key={i.id} className={`incident ${selected === i.id ? "selected" : ""}`} aria-pressed={selected === i.id} onClick={() => { setSelected(i.id); setResolution(""); }}>
                    <span className="incident-main"><strong>{i.title}</strong><small>{i.hostname} · {i.category} · {new Date(i.created_at).toLocaleString()}</small></span>
                    <Badge tone={i.status === "resolved" ? "success" : "warning"}>{i.status}</Badge>
                  </Button>
                ))}
              </div>
                <form className="panel-footer" onSubmit={e => { e.preventDefault(); void act(async () => { const x = await api("/incidents", "POST", { agentId: hostId, title }); setSelected(x.id); }); }}>
                  <h3>Create a test incident</h3>
                  <Field id="incident-host" label="Server" required><Select id="incident-host" value={hostId} onChange={e => setHostId(e.target.value)} required><option value="">Choose a server</option>{hosts.map(h => <option key={h.id} value={h.id}>{h.hostname}</option>)}</Select></Field>
                  <Field id="incident-title" label="Incident title" required><Input id="incident-title" value={title} onChange={e => setTitle(e.target.value)} required minLength={3} /></Field>
                  <Button type="submit" loading={busy} disabled={!hostId || title.length < 3}>Create incident</Button>
                </form>
              </Panel>

            {detail && (
              <Panel className="detail" role="region" aria-labelledby="incident-detail-title">
                <div className="panel-head"><div><h2 id="incident-detail-title">{detail.incident.title}</h2><p>{detail.incident.hostname} · {detail.incident.status}</p></div><Button variant="ghost" size="sm" onClick={() => { setDetail(null); setSelected(null); }}>Close detail</Button></div>
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
        ) : (
          <Panel role="region" aria-labelledby="memory-title">
            <div className="panel-head"><div><h2 id="memory-title">Resolved incident knowledge</h2><p>Full-text incident retrieval for future investigations</p></div></div>
            <Field id="memory-search" label="Search confirmed resolutions"><Input id="memory-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search symptoms, service, resolution…" /></Field>
            {memories.length === 0 ? <p className="empty">No matching resolved incidents yet.</p> : memories.map(m => <div key={m.id} className="memory"><Badge tone="success">Human-confirmed</Badge><h3>{m.summary}</h3><p>{m.resolution}</p><small>{new Date(m.created_at).toLocaleString()}</small></div>)}
          </Panel>
        )}
        <footer>OpsPilot starter · No automatic remediation · Read-only diagnostics only</footer>
      </main>
    </div>
  );
}
