"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { BrandMark } from "../components/brand-mark";
import { Badge, Button, Field, Input, Notice, Panel, Select, Textarea } from "../components/ui";
import type { AiProvider, HostList, ProviderProtocol } from "@opspilot/contracts";
import { HostWorkspace } from "../components/host-workspace";
import { ProviderSettings } from "../components/provider-settings";
import { WorkspaceIcon, WorkspaceShell, type WorkspacePage } from "../components/workspace-shell";
import { ThresholdOverview } from "../components/threshold-overview";
import { ServerOnboarding } from "../components/server-onboarding";
import { api, ApiError } from "../lib/api";
import { percent, resources, type Resource } from "../lib/host-pressure";
type Incident = { id: string; title: string; category: string; status: string; hostname: string; agent_id: string; created_at: string; resolved_at: string | null; resolution: string | null };
type Evidence = { id: string; source: string; content: string; created_at: string };
type Investigation = { id: string; provider: { id: string | null; name: string; protocol: ProviderProtocol; baseUrl: string | null; model: string | null }; status: string; result_json: { probable_cause?: string; confidence?: number | string; evidence_ids?: string[]; recommended_checks?: string[] } | null; error: string | null };
type Detail = { incident: Incident; evidence: Evidence[]; investigations: Investigation[] };
type Memory = { id: string; summary: string; resolution: string; created_at: string };

const headings = {
  overview: ["Know what’s close to the edge.", "See which resources have reached their configured limits and how much headroom is left."],
  hosts: ["Every host. One clear view.", "Monitor agent connectivity and resource usage across your Linux hosts."],
  services: ["Services", "Workload state and endpoint reachability are measured separately from host health."],
  incidents: ["From signal to resolution.", "Review measured evidence, investigate, and record what fixed the incident."],
  drift: ["Configuration drift", "Recorded configuration hash changes. Correlation is not causation."],
  memory: ["Incident memory", "Human-confirmed resolutions from previous investigations."],
  providers: ["Provider settings", "Encrypted AI connections. Choose the endpoint and model explicitly; no automatic fallback."],
} as const;

function categoryLabel(category: string) {
  switch (category) {
    case "cpu": return "CPU pressure";
    case "memory": return "Memory pressure";
    case "disk": return "Disk pressure";
    case "config_drift": return "Configuration drift";
    case "manual": return "Manual investigation";
    default: return category;
  }
}


export default function Home() {
  const [logged, setLogged] = useState<boolean | null>(null);
  const [authDisabled, setAuthDisabled] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [incidentsError, setIncidentsError] = useState("");
  const [fleet, setFleet] = useState<HostList | null>(null);
  const [fleetError, setFleetError] = useState("");
  const [inspectHost, setInspectHost] = useState<{ id: string; resource?: Resource } | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedIncident = useRef<string | null>(null);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [encryptionConfigured, setEncryptionConfigured] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState("");
  const [investigationError, setInvestigationError] = useState("");
  const [providerReviewRequired, setProviderReviewRequired] = useState(false);
  const providerRequest = useRef<Promise<void> | null>(null);
  const sessionGeneration = useRef(0);
  const selectedProviderId = useRef("");
  const [title, setTitle] = useState("Manual service investigation");
  const [hostId, setHostId] = useState("");
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<WorkspacePage>("overview");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [search, setSearch] = useState("");
  const [hostRefresh, setHostRefresh] = useState(0);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const focusPage = useRef(false);
  const focusIncident = useRef(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const endSession = useCallback(() => {
    sessionGeneration.current++;
    setLogged(false); setAuthDisabled(false); setFleet(null); setFleetError(""); setInspectHost(null);
    setDetail(null); setSelected(null); selectedIncident.current = null;
    setTab("overview");
    setIncidents([]); setIncidentsError(""); setRefreshedAt(null);
    setProviders([]); setEncryptionConfigured(false); setProviderId(""); setModel("");
    selectedProviderId.current = "";
  }, []);

  useEffect(() => {
    window.addEventListener("opspilot-unauthorized", endSession);
    return () => window.removeEventListener("opspilot-unauthorized", endSession);
  }, [endSession]);

  const checkSession = useCallback(async () => {
    const generation = sessionGeneration.current;
    setSessionError("");
    try {
      const me = await api("/auth/me");
      if (generation === sessionGeneration.current) {
        setAuthDisabled(Boolean(me?.authDisabled));
        setLogged(true);
      }
    } catch (cause) {
      if (generation === sessionGeneration.current && !(cause instanceof ApiError && cause.status === 401)) {
        setSessionError(cause instanceof Error ? cause.message : "Unable to verify your session.");
      }
    }
  }, []);

  useEffect(() => { void checkSession(); }, [checkSession]);

  useEffect(() => {
    if (!focusPage.current || !logged) return;
    focusPage.current = false;
    pageHeading.current?.focus({ preventScroll: true });
  }, [tab, logged]);

  const refreshProviders = useCallback((): Promise<void> => {
    if (providerRequest.current) return providerRequest.current;
    const generation = sessionGeneration.current;
    setProvidersLoading(true);
    const request = (async () => {
      try {
        const data: { providers: AiProvider[]; encryptionConfigured: boolean } = await api("/ai/providers");
        if (generation !== sessionGeneration.current) return;
        setProviders(data.providers);
        setEncryptionConfigured(data.encryptionConfigured);
        setProvidersError("");
        const chosen = data.providers.find(p => p.id === selectedProviderId.current && p.enabled);
        if (!chosen) {
          const next = data.providers.find(p => p.enabled);
          selectedProviderId.current = next?.id ?? "";
          setProviderId(next?.id ?? "");
          setModel(next?.defaultModel ?? "");
        }
      } catch (cause) {
        if (generation === sessionGeneration.current && !(cause instanceof ApiError && cause.status === 401)) {
          setProvidersError(cause instanceof Error ? cause.message : "Provider metadata could not be loaded.");
        }
      } finally {
        if (generation === sessionGeneration.current) setProvidersLoading(false);
        providerRequest.current = null;
      }
    })();
    providerRequest.current = request;
    return request;
  }, []);

  const refreshIncidents = useCallback(async () => {
    const generation = sessionGeneration.current;
    try {
      const nextIncidents = await api("/incidents");
      if (generation !== sessionGeneration.current) return;
      setIncidents(nextIncidents);
      setRefreshedAt(new Date().toISOString());
      setIncidentsError("");
    } catch (cause) {
      if (generation === sessionGeneration.current && !(cause instanceof ApiError && cause.status === 401)) {
        setIncidentsError(cause instanceof Error ? cause.message : "Incident records could not be loaded.");
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    setHostRefresh(value => value + 1);
    await Promise.all([refreshIncidents(), refreshProviders()]);
  }, [refreshIncidents, refreshProviders]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const result: Detail = await api(`/incidents/${id}`);
      if (selectedIncident.current === id) setDetail(result);
    } catch (e: unknown) {
      if (selectedIncident.current === id) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!logged) return;
    void refreshIncidents();
    void refreshProviders();
    const timer = setInterval(() => { void refreshIncidents(); void refreshProviders(); }, 10000);
    return () => clearInterval(timer);
  }, [logged, refreshIncidents, refreshProviders]);
  const activeProviderTest = providers.some(p => p.lastTest?.status === "queued" || p.lastTest?.status === "running");
  useEffect(() => {
    if (!logged || tab !== "providers" || !activeProviderTest) return;
    const timer = setInterval(() => { void refreshProviders(); }, 2000);
    return () => clearInterval(timer);
  }, [logged, tab, activeProviderTest, refreshProviders]);
  useEffect(() => {
    if (!selected || !logged) return;
    void loadDetail(selected);
    const timer = setInterval(() => { void loadDetail(selected); }, 10000);
    return () => clearInterval(timer);
  }, [selected, logged, loadDetail]);
  useEffect(() => {
    if (detail && focusIncident.current) {
      focusIncident.current = false;
      document.getElementById("incident-detail-title")?.focus();
    }
  }, [detail]);
  useEffect(() => {
    if (logged && tab === "memory") void api(`/memory?q=${encodeURIComponent(search)}`).then(setMemories).catch(e => setError(e.message));
  }, [logged, tab, search]);

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
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", "POST", { password });
      setPassword("");
      setLogged(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in.");
    } finally { setBusy(false); }
  }

  async function investigate(event: FormEvent) {
    event.preventDefault();
    const connection = providers.find(p => p.id === providerId && p.enabled);
    if (!detail || !connection || !connection.hasApiKey || !encryptionConfigured || providersLoading || providersError || busy || providerReviewRequired || !model.trim() || detail.incident.status !== "open") return;
    setBusy(true); setInvestigationError(""); setError("");
    try {
      await api(`/incidents/${detail.incident.id}/investigate`, "POST", { providerId: connection.id, providerRevision: connection.revision, model: model.trim() });
      await loadDetail(detail.incident.id);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "provider_changed") {
        setProviderReviewRequired(true);
        setInvestigationError("Provider configuration changed. Refresh and review the current destination and model before investigating again. Nothing was automatically resubmitted.");
        await refreshProviders();
      } else setInvestigationError(cause instanceof Error ? cause.message : "Unable to start the investigation.");
    } finally { setBusy(false); }
  }

  if (logged === null) return (
    <main className="center">
      <div>
        <p role="status">{sessionError ? "Unable to verify your session." : "Checking admin session…"}</p>
        {sessionError && <Notice tone="danger" role="alert">{sessionError}<p><Button onClick={() => void checkSession()}>Retry session check</Button></p></Notice>}
        <Link href="/design-system">Explore the design system</Link>
      </div>
    </main>
  );

  if (!logged) return (
    <main className="login-container">
      <Panel className="login-card">
        <div className="logo"><BrandMark size={24} /><span>OpsPilot</span></div>
        <h1>Sign in to OpsPilot</h1>
        <p className="muted">Sign in with your single-admin password.</p>
        <form onSubmit={login}>
          <Field id="admin-password" label="Admin password" required>
            <Input id="admin-password" autoFocus type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required minLength={1} />
          </Field>
          <Button type="submit" variant="primary" loading={busy}>Sign in</Button>
        </form>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <p className="tiny">Your data stays in your own OpsPilot database. AI calls use the encrypted connections saved in Provider settings.</p>
        <Link href="/design-system">Explore the design system</Link>
      </Panel>
    </main>
  );

  const open = refreshedAt ? incidents.filter(i => i.status === "open").length : null;
  const heading = tab === "connect" || tab === "new-monitor" ? null : headings[tab];
  const hosts = fleet?.hosts ?? [];
  const incidentView = tab === "incidents" || tab === "drift";
  const visibleIncidents = tab === "drift" ? incidents.filter(i => i.category === "config_drift") : incidents;
  const selectedProvider = providers.find(p => p.id === providerId && p.enabled);
  const detailHost = detail && hosts.find(h => h.id === detail.incident.agent_id);

  function chooseIncident(id: string | null) {
    if (id === selectedIncident.current) return;
    selectedIncident.current = id;
    setDetail(null);
    setSelected(id);
    setResolution("");
  }

  function navigate(next: WorkspacePage) {
    if (tab === next) return;
    focusIncident.current = false;
    const records = next === "drift" ? incidents.filter(i => i.category === "config_drift") : incidents;
    chooseIncident(next === "incidents" || next === "drift"
      ? records.find(i => i.status === "open")?.id ?? records[0]?.id ?? null
      : null);
    focusPage.current = true;
    setTab(next);
    window.scrollTo(0, 0);
  }

  function inspect(id: string, resource?: Resource) {
    navigate("hosts");
    setInspectHost({ id, resource });
  }

  function openIncident(id: string) {
    focusIncident.current = true;
    setTab("incidents");
    chooseIncident(id);
    window.scrollTo(0, 0);
  }

  function signOut() {
    window.dispatchEvent(new Event("opspilot-clear-provider-draft"));
    setBusy(true);
    void api("/auth/logout", "POST").then(endSession).catch(e => setError(e.message)).finally(() => setBusy(false));
  }

  return (
    <WorkspaceShell page={tab} onNavigate={navigate} onInspectHost={inspect} hosts={hosts} incidents={open} incidentsStale={!!incidentsError} busy={busy} onSignOut={authDisabled ? undefined : signOut}>
      <main className="content" id="main-content" tabIndex={-1}>
        {heading && <header className="topbar">
          <div>
            <h1 ref={pageHeading} tabIndex={-1}>{heading[0]}</h1>
            <p className="muted">{heading[1]}</p>
          </div>
          <div className="header-actions">
            {(tab === "overview" || tab === "hosts") && <Button variant={tab === "hosts" ? "primary" : "secondary"} onClick={() => navigate("connect")}><WorkspaceIcon name="terminal" />Connect server</Button>}
            {(tab === "overview" || tab === "services") && <Button variant="primary" onClick={() => navigate("new-monitor")}><WorkspaceIcon name="add" />{tab === "services" ? "Add service" : "New monitor"}</Button>}
            {tab === "incidents" && <a className="workspace-action-link" href="#create-incident"><WorkspaceIcon name="add" />Create incident</a>}
          </div>
        </header>}
        {heading && <div className="workspace-toolbar">
          <span className="workspace-context">{tab === "overview" || tab === "hosts" ? <>
            Local workspace {fleet && <span className="workspace-meta">· {fleet.total} {fleet.total === 1 ? "host" : "hosts"}{fleetError ? " · cached" : ""}</span>}
          </> : incidentView ? <>
            {open === null ? incidentsError ? "Incident data unavailable" : "Loading incidents…" : `${visibleIncidents.filter(i => i.status === "open").length} open${incidentsError ? " · cached" : ""}`}
          </> : "Local workspace"}</span>
          {(tab === "overview" || tab === "hosts" || incidentView) && <div className="workspace-toolbar-actions">
            <span className="workspace-meta">{incidentView ? "Incident" : "Fleet"} refresh · 10s</span>
            <Button size="sm" onClick={() => void refresh()}><WorkspaceIcon name="refresh" />Refresh</Button>
          </div>}
        </div>}

        {error && <Notice tone="danger" role="alert" className="dashboard-alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => setError("")}>Dismiss</Button></Notice>}
        {incidentsError && <Notice tone="warning" role="alert" className="dashboard-alert"><span>Incident refresh failed: {incidentsError}. {refreshedAt ? `Showing cached incident records from ${new Date(refreshedAt).toLocaleString()}.` : "Incident data is unavailable, not zero open incidents."}</span><Button size="sm" onClick={() => void refreshIncidents()}>Retry incidents</Button></Notice>}

        <div hidden={tab !== "hosts"}><HostWorkspace refreshKey={hostRefresh} onFleet={setFleet} onFleetError={setFleetError} onUnauthorized={endSession} openIncidents={open} incidentsStale={!!incidentsError} incidents={incidents} onOpenIncident={openIncident} inspectHost={inspectHost} onConnect={() => navigate("connect")} /></div>
        {tab === "overview" && <ThresholdOverview fleet={fleet} fleetError={fleetError} openIncidents={open} incidentsStale={!!incidentsError} onInspectHost={inspect} onBrowseHosts={() => navigate("hosts")} />}
        {tab === "connect" && <ServerOnboarding onBack={() => navigate("hosts")} onUnauthorized={endSession} fleet={fleet} fleetError={fleetError} onRefresh={() => setHostRefresh(value => value + 1)} />}
        {tab === "services" && <Panel className="services-unavailable" aria-labelledby="services-title">
          <WorkspaceIcon name="services" />
          <h2 id="services-title">Service inventory is unavailable</h2>
          <p className="muted">This instance does not collect workload inventory or run endpoint checks. No service count or reachability result can be reported.</p>
          <Button onClick={() => navigate("hosts")}>View host inventory <WorkspaceIcon name="arrow" /></Button>
        </Panel>}
        {tab === "new-monitor" && <section className="onboarding" aria-labelledby="add-service-title">
          <Button className="onboarding-back" onClick={() => navigate("services")}><WorkspaceIcon name="back" />Back to Services</Button>
          <header className="onboarding-header"><h1 id="add-service-title" ref={pageHeading} tabIndex={-1}>Add service</h1><p>Endpoint setup requires monitoring support on this instance.</p></header>
          <ol className="onboarding-progress" aria-label="Service setup progress">
            {["Choose a server", "Configure service", "Verify service"].map((step, i) => <li className="onboarding-progress-item" data-state={i === 0 ? "active" : "upcoming"} aria-current={i === 0 ? "step" : undefined} key={step}>
              <span className="onboarding-progress-marker" aria-hidden="true">{i + 1}</span><div><span>{step}</span><span className="onboarding-step-status">{i === 0 ? "Unavailable" : "Not started"}</span></div>
            </li>)}
          </ol>
          <ol className="onboarding-steps">
            <li className="onboarding-step" data-state="active">
              <div className="onboarding-step-header"><h2>1. Choose a server</h2></div>
              <div className="onboarding-step-body"><p>Endpoint monitor configuration is not available on this instance. Connecting an agent enables host telemetry, not service probes.</p><div className="onboarding-actions"><Button onClick={() => navigate("hosts")}>View hosts</Button><Button onClick={() => navigate("connect")}><WorkspaceIcon name="terminal" />Connect server</Button></div></div>
            </li>
            <li className="onboarding-step" data-state="upcoming"><div className="onboarding-step-header"><h2>2. Configure service</h2></div></li>
            <li className="onboarding-step" data-state="upcoming"><div className="onboarding-step-header"><h2>3. Verify service</h2></div></li>
          </ol>
        </section>}
        {incidentView && (
          <div className="incident-workspace">
            <section className="incident-queue" aria-labelledby="incidents-title">
              <h2 id="incidents-title">{tab === "drift" ? "Recorded hash changes" : "Needs attention"}</h2>
              <div className="list">
                {open === null ? <p className="empty">{incidentsError ? "Incident records are unavailable. Retry the incident refresh to load them." : "Loading incident records…"}</p> : <>
                  {visibleIncidents.filter(i => i.status === "open").length === 0 && <p className="empty">No open {tab === "drift" ? "drift records" : "incidents"} in the latest 100 records.</p>}
                  {(["open", "resolved"] as const).map(status => {
                    const records = visibleIncidents.filter(i => i.status === status);
                    if (!records.length) return null;
                    return <div className={`incident-group incident-group--${status}`} key={status}>
                      {status === "resolved" && <h3>Recently resolved</h3>}
                      {records.map(i => <Button key={i.id} className="incident" aria-pressed={selected === i.id} onClick={() => chooseIncident(i.id)}>
                        <span className="incident-card-top"><span>{categoryLabel(i.category)}</span><span>{i.status}</span></span>
                        <strong>{i.title}</strong>
                        <small>{i.hostname} · <time dateTime={i.resolved_at ?? i.created_at}>{new Date(i.resolved_at ?? i.created_at).toLocaleString()}</time></small>
                      </Button>)}
                    </div>;
                  })}
                </>}
              </div>
              {tab === "incidents" && <form id="create-incident" className="panel-footer" onSubmit={e => { e.preventDefault(); void act(async () => { const x = await api("/incidents", "POST", { agentId: hostId, title }); chooseIncident(x.id); }); }}>
                  <h3>Create a test incident</h3>
                  <Field id="incident-host" label="Server" required><Select id="incident-host" value={hostId} onChange={e => setHostId(e.target.value)} required><option value="">Choose a server</option>{hosts.map(h => <option key={h.id} value={h.id}>{h.hostname}</option>)}</Select></Field>
                  <Field id="incident-title" label="Incident title" required><Input id="incident-title" value={title} onChange={e => setTitle(e.target.value)} required minLength={3} /></Field>
                  <Button type="submit" loading={busy} disabled={!hostId || title.length < 3}>Create incident</Button>
                </form>}
            </section>
            {!detail && <Panel className="incident-placeholder"><p className="muted">{selected ? "Loading incident detail…" : "Select an incident to review measured evidence and investigation activity."}</p></Panel>}
            {detail && (
              <Panel className="detail" role="region" aria-labelledby="incident-detail-title">
                <div className="panel-head"><div><h2 id="incident-detail-title" tabIndex={-1}>{detail.incident.title}</h2><p>{detail.incident.hostname} · {categoryLabel(detail.incident.category)}</p></div><Badge tone={detail.incident.status === "open" ? "danger" : "neutral"}>{detail.incident.status}</Badge></div>
                <div className="incident-context">
                  <WorkspaceIcon name="hosts" />
                  <div><h3>Host context</h3><p>{detail.incident.hostname} · {fleetError || !fleet ? "Connectivity unavailable" : detailHost?.status ?? "Not in loaded inventory"}</p>
                    <p className="muted">A host incident does not establish endpoint impact.</p>
                  </div>
                </div>
                {detailHost?.sampled_at && <section className="incident-measurements" aria-label="Latest host sample, not incident-time values">
                  <p className="muted">Latest host sample · <time dateTime={detailHost.sampled_at}>{new Date(detailHost.sampled_at).toLocaleString()}</time>{fleetError ? " · cached" : ""}. Separate from incident evidence.</p>
                  <dl>{resources.map(({ key, label }) => <div key={key}><dt>{label} / current limit</dt><dd>{percent(detailHost[key])} / {percent(fleet?.thresholds?.[key] ?? null)}</dd></div>)}</dl>
                </section>}
                <div className="detail-grid">
                  <div>
                    <h3>Activity timeline</h3>
                    <p className="muted small">Recorded incident activity and diagnostic evidence.</p>
                    <ol className="incident-timeline">
                      {detail.incident.resolved_at && <li><time dateTime={detail.incident.resolved_at}>{new Date(detail.incident.resolved_at).toLocaleString()}</time><div>Human-confirmed resolution recorded</div></li>}
                      {detail.evidence.map(e => <li className="evidence" key={e.id}><time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString()}</time><div><strong>{e.source}</strong><code>{e.content}</code><small>ID: {e.id}</small></div></li>)}
                      <li><time dateTime={detail.incident.created_at}>{new Date(detail.incident.created_at).toLocaleString()}</time><div>Incident opened</div></li>
                    </ol>
                  </div>
                  <div>
                    <h3>AI investigation</h3>
                    <Notice tone="info" className="investigation-notice">AI findings are hypotheses. Review the cited evidence before taking action.</Notice>
                    {providersError && <Notice tone="danger" role="alert">{providersError} Provider metadata may be stale. Investigate is disabled until a successful refresh. <Button size="sm" disabled={providersLoading} onClick={() => void refreshProviders()}>Retry provider refresh</Button></Notice>}
                    {!providersLoading && !providersError && !encryptionConfigured && <Notice tone="warning">AI is unavailable until the server administrator configures AI_PROVIDER_ENCRYPTION_KEY on the Hub and Worker.</Notice>}
                    {investigationError && <Notice tone="danger" role="alert">{investigationError}</Notice>}
                    <form className="investigation-form" onSubmit={investigate}>
                      <Field id="ai-provider" label="AI provider" hint={providersLoading ? "Refreshing provider metadata…" : "Only enabled connections are available."} required>
                        <Select id="ai-provider" value={providerId} aria-describedby="ai-provider-hint" required disabled={providersLoading || !!providersError || !encryptionConfigured || busy || !providers.some(p => p.enabled)} onChange={e => { const connection = providers.find(p => p.id === e.target.value); selectedProviderId.current = e.target.value; setProviderId(e.target.value); setModel(connection?.defaultModel ?? ""); }}>
                          {!providers.some(p => p.enabled) ? <option value="">No enabled AI providers</option> : providers.filter(p => p.enabled).map(p => <option key={p.id} value={p.id}>{p.name} · {p.protocol}</option>)}
                        </Select>
                      </Field>
                      <Field id="ai-model" label="Model" hint="Applies only to this investigation; the connection default is unchanged." required><Input id="ai-model" value={model} maxLength={200} required disabled={!selectedProvider || !encryptionConfigured || !!providersError || providersLoading || busy} aria-describedby="ai-model-hint" onChange={e => setModel(e.target.value)} /></Field>
                      {selectedProvider && <div className="investigation-destination" id="investigation-destination">
                        <p><strong>Destination: {selectedProvider.name}</strong> · {new URL(selectedProvider.baseUrl).hostname}</p><p>{selectedProvider.baseUrl} · {selectedProvider.protocol} · Revision {selectedProvider.revision}</p><p>Model: {model.trim() || "Choose an explicit model"}</p>
                        <p>Collected incident evidence and relevant incident memory will be sent to this endpoint. Review this destination and model before you continue. This request may incur API charges.</p>
                      </div>}
                      {providerReviewRequired && <Button disabled={providersLoading || !!providersError || !selectedProvider || !encryptionConfigured} onClick={() => { setProviderReviewRequired(false); setInvestigationError(""); }}>I reviewed the updated destination and model</Button>}
                      <Button type="submit" variant="primary" loading={busy} aria-describedby={selectedProvider ? "investigation-destination" : undefined} disabled={!selectedProvider || !selectedProvider.hasApiKey || !encryptionConfigured || !model.trim() || providersLoading || !!providersError || providerReviewRequired || detail.incident.status !== "open"}>Investigate</Button>
                    </form>
                    {detail.investigations.length === 0 ? <p className="muted">Investigation has not been started.</p> : detail.investigations.map(x => (
                      <div className="finding" key={x.id}>
                        <div className="finding-head"><div><strong>{x.provider.name}</strong><span className="finding-provider-meta">{x.provider.protocol} · {x.provider.model ?? "Model not recorded (legacy)"}</span>{x.provider.baseUrl && <span className="finding-provider-meta">{x.provider.baseUrl}</span>}</div><Badge tone={x.status === "failed" ? "danger" : x.status === "completed" ? "info" : "warning"}>{x.status}</Badge></div>
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
          </div>
        )}
        {tab === "memory" && (
          <Panel role="region" aria-labelledby="memory-title">
            <div className="panel-head"><div><h2 id="memory-title">Resolved incident knowledge</h2><p>Full-text incident retrieval for future investigations</p></div></div>
            <Field id="memory-search" label="Search confirmed resolutions"><Input id="memory-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search symptoms, service, resolution…" /></Field>
            {memories.length === 0 ? <p className="empty">No matching resolved incidents yet.</p> : memories.map(m => <div key={m.id} className="memory"><Badge tone="success">Human-confirmed</Badge><h3>{m.summary}</h3><p>{m.resolution}</p><small>{new Date(m.created_at).toLocaleString()}</small></div>)}
          </Panel>
        )}
        {tab === "providers" && <ProviderSettings providers={providers} encryptionConfigured={encryptionConfigured} loading={providersLoading} error={providersError} onRefresh={refreshProviders} />}
        <footer>OpsPilot starter · No automatic remediation · Read-only diagnostics only</footer>
      </main>
    </WorkspaceShell>
  );
}
