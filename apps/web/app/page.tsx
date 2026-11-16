"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Badge, Button, Field, Input, MetricMeter, Notice, Panel, Select, Textarea } from "../components/ui";

type Host = { id: string; hostname: string; status: string; last_seen_at: string | null; cpu_percent: number | null; memory_percent: number | null; disk_percent: number | null; version: string };
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
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const fmt = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "Unknown" : `${Number(value).toFixed(1)}%`;

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
  const [enrollment, setEnrollment] = useState("");
  const [title, setTitle] = useState("Manual service investigation");
  const [hostId, setHostId] = useState("");
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"overview" | "memory">("overview");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [search, setSearch] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [h, i, p] = await Promise.all([api("/hosts"), api("/incidents"), api("/ai/providers")]);
      setHosts(h);
      setIncidents(i);
      setProviders(p.available);
      setProvider(old => p.available.includes(old) ? old : (p.available[0] || ""));
      setLogged(true);
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
  const online = hosts.filter(h => h.status === "online").length;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar">
        <div className="logo">OpsPilot</div>
        <nav aria-label="Main navigation">
          <Button variant="ghost" className={`nav ${tab === "overview" ? "active" : ""}`} aria-current={tab === "overview" ? "page" : undefined} onClick={() => setTab("overview")}>Overview</Button>
          <Button variant="ghost" className={`nav ${tab === "memory" ? "active" : ""}`} aria-current={tab === "memory" ? "page" : undefined} onClick={() => setTab("memory")}>Incident memory</Button>
          <Link className="nav" href="/design-system">Design system</Link>
        </nav>
        <div className="sidebar-bottom">
          <p>Single-admin mode</p>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(async () => { await api("/auth/logout", "POST"); setLogged(false); })}>Sign out</Button>
        </div>
      </aside>

      <main className="content" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <div>
            <h1>{tab === "overview" ? "Server overview" : "Incident memory"}</h1>
            <p className="muted">Independent hub · Outbound agents · Evidence-first AI</p>
          </div>
          <Button onClick={() => void refresh()}>Refresh</Button>
        </header>

        {error && <Notice tone="danger" role="alert" className="dashboard-alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => setError("")}>Dismiss</Button></Notice>}

        {tab === "overview" ? (
          <>
            <section className="stats" aria-label="Current operations summary">
              <div className="stat"><p>Managed servers</p><strong>{hosts.length}</strong><small>{online} online</small></div>
              <div className="stat"><p>Open incidents</p><strong>{open}</strong><small>Need investigation</small></div>
              <div className="stat"><p>AI providers</p><strong>{providers.length}</strong><small>Keys configured on server</small></div>
            </section>

            <div className="columns">
              <Panel role="region" aria-labelledby="infrastructure-title">
                <div className="panel-head">
                  <div><h2 id="infrastructure-title">Infrastructure</h2><p>Agent telemetry &amp; status</p></div>
                  <Badge tone="success">{online} online</Badge>
                </div>
                {hosts.length === 0 ? <div className="empty">No agents enrolled yet. Generate an enrollment token to connect your first Linux host.</div> : hosts.map(h => (
                  <div className="host" key={h.id}>
                    <div className="host-head"><strong>{h.hostname}</strong><div className="host-status"><Badge dot tone={h.status === "online" ? "success" : "danger"}>{h.status}</Badge><span className="muted small">{h.version}</span></div></div>
                    <div className="host-metrics">
                      {([["CPU", h.cpu_percent], ["Memory", h.memory_percent], ["Disk", h.disk_percent]] as const).map(([label, value]) => (
                        <div key={label}><div className="metric-label"><span>{label}</span><b>{fmt(value)}</b></div><MetricMeter label={`${h.hostname} ${label} usage`} value={value} /></div>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="panel-footer">
                  <h3>Enroll a new agent</h3>
                  <p className="muted">One-time token expires in 10 minutes. Treat it as secret.</p>
                  <Button loading={busy} onClick={() => void act(async () => { const x = await api("/agents/enrollment-token", "POST"); setEnrollment(x.token); })}>Generate enrollment token</Button>
                  {enrollment && <div className="token"><code>{enrollment}</code><Button size="sm" onClick={() => void navigator.clipboard.writeText(enrollment).catch(() => setError("Could not copy the enrollment token. Select and copy the token manually."))}>Copy</Button></div>}
                  <p className="tiny">Set <code>OPSPILOT_HUB_URL</code> and <code>OPSPILOT_ENROLL_TOKEN</code> before starting the Go agent.</p>
                </div>
              </Panel>

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
            </div>

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
