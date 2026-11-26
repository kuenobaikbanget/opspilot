"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AsciiLoading } from "../../../components/ascii-card-reveal";
import { Badge, Button, Field, Input, Notice, Panel, Select, Textarea } from "../../../components/ui";
import { WorkspaceIcon } from "../../../components/workspace-shell";
import { api, ApiError, getIncidentDetail, type IncidentDetailResponse, type IncidentEvidence, type InvestigationResultJson } from "../../../lib/api";
import { percent, resources } from "../../../lib/host-pressure";
import { useWorkspace, type Incident } from "../workspace";
import { WorkspaceHeader } from "../workspace-header";
import { useProviders } from "../use-providers";

type Detail = IncidentDetailResponse<Incident>;
type EvidenceSort = "relevance" | "chronological";

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

function shortId(id: string) {
  return id.replace(/-/g, "").slice(0, 6);
}

/** Deterministic client-side ordering, mirroring the server's sortScoredEvidence. */
function sortEvidence(items: IncidentEvidence[], mode: EvidenceSort): IncidentEvidence[] {
  const sorted = [...items];
  if (mode === "chronological") {
    sorted.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.created_at < b.created_at ? 1 : -1));
    return sorted;
  }
  sorted.sort((a, b) => {
    const citedDelta = Number(b.relevance?.cited ?? false) - Number(a.relevance?.cited ?? false);
    if (citedDelta !== 0) return citedDelta;
    const scoreDelta = (b.relevance?.score ?? 0) - (a.relevance?.score ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted;
}

/** Compact truthful usage line; returns null when no token metadata is present. */
function usageLine(result: InvestigationResultJson): string | null {
  const total = typeof result.total_tokens === "number" && Number.isFinite(result.total_tokens)
    ? result.total_tokens
    : typeof result.input_tokens === "number" && typeof result.output_tokens === "number"
      ? result.input_tokens + result.output_tokens
      : null;
  if (total === null) return null;
  const cost = typeof result.estimated_cost_usd === "number" && Number.isFinite(result.estimated_cost_usd)
    ? `est. $${result.estimated_cost_usd.toFixed(4)}`
    : "cost unknown";
  return `${Math.round(total).toLocaleString("en-US")} tokens · ${cost}`;
}

const SIGNAL_LABELS: Record<string, string> = {
  cited_by_hypothesis: "cited by hypothesis",
  error_signal: "error signal",
  category_match: "category match",
  keyword_overlap: "keyword overlap",
  source_priority: "priority source",
};

export function IncidentWorkspace({ drift = false }: { drift?: boolean }) {
  const { fleet, fleetError, incidents, incidentsError, openIncidents, refresh, selection, consumeSelection } = useWorkspace();
  const { providers, encryptionConfigured, loading: providersLoading, error: providersError, refresh: refreshProviders } = useProviders();
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState("");
  const detailRead = useRef<{ id: string; signal: AbortSignal } | null>(null);
  const [focusDetail, setFocusDetail] = useState<string | null>(null);
  const incidentHeading = useRef<HTMLHeadingElement>(null);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [investigationError, setInvestigationError] = useState("");
  const [providerReviewRequired, setProviderReviewRequired] = useState(false);
  const [title, setTitle] = useState("Manual service investigation");
  const [hostId, setHostId] = useState("");
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [evidenceSort, setEvidenceSort] = useState<EvidenceSort | null>(null);
  const [highlightedEvidence, setHighlightedEvidence] = useState<string | null>(null);
  const evidenceRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hosts = fleet?.hosts ?? [];
  const visibleIncidents = drift ? incidents.filter(i => i.category === "config_drift") : incidents;
  const visibleOpen = openIncidents === null ? null : drift ? visibleIncidents.filter(i => i.status === "open").length : openIncidents;
  const selectedProvider = providers.find(p => p.id === providerId && p.enabled);
  const detailHost = detail && hosts.find(h => h.id === detail.incident.agent_id);
  const providersPending = providersLoading && !providers.length && !providersError;

  // Latest completed investigation defines the active hypothesis and its citations.
  const activeHypothesis = detail?.investigations.find(x => x.status === "completed" && x.result_json?.probable_cause) ?? null;
  const evidenceById = useMemo(() => new Map((detail?.evidence ?? []).map(e => [e.id, e])), [detail?.evidence]);
  // Relevance is the default ordering once a hypothesis exists; otherwise chronological.
  const sortMode: EvidenceSort = evidenceSort ?? (activeHypothesis ? "relevance" : "chronological");
  const sortedEvidence = useMemo(() => detail ? sortEvidence(detail.evidence, sortMode) : [], [detail, sortMode]);

  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
  }, []);

  /** Scrolls to, highlights and focuses an evidence card from a citation pill. */
  function focusEvidence(id: string) {
    const card = evidenceRefs.current.get(id);
    if (!card) return;
    setHighlightedEvidence(id);
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.focus({ preventScroll: true });
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedEvidence(current => (current === id ? null : current)), 2600);
  }

  if (!selected) {
    const first = (!drift && selection?.href === "/incidents" ? selection.id : null)
      ?? visibleIncidents.find(i => i.status === "open")?.id ?? visibleIncidents[0]?.id;
    if (first) setSelected(first);
  }
  if (!selectedProvider) {
    const next = providers.find(p => p.enabled);
    if (providerId !== (next?.id ?? "")) {
      setProviderId(next?.id ?? "");
      setModel(next?.defaultModel ?? "");
    }
  }

  const chooseIncident = useCallback((id: string) => {
    if (id === selected) return;
    setDetail(null);
    setDetailError("");
    setSelected(id);
    setResolution("");
  }, [selected]);

  useEffect(() => {
    if (drift || selection?.href !== "/incidents") return;
    chooseIncident(selection.id);
    setFocusDetail(selection.id);
    consumeSelection(selection);
  }, [drift, selection, chooseIncident, consumeSelection]);

  useEffect(() => {
    if (focusDetail !== selected || !incidentHeading.current) return;
    setFocusDetail(null);
    incidentHeading.current.focus();
  }, [focusDetail, selected, detail]);

  const loadDetail = useCallback(async (id: string) => {
    const read = detailRead.current;
    if (read?.id !== id || read.signal.aborted) return;
    try {
      const result = await getIncidentDetail<Incident>(id, read.signal);
      if (!read.signal.aborted) {
        setDetail(result);
        setDetailError("");
      }
    } catch (cause) {
      if (!read.signal.aborted && !(cause instanceof ApiError && cause.status === 401)) setDetailError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    detailRead.current = { id: selected, signal: controller.signal };
    void loadDetail(selected);
    const timer = setInterval(() => void loadDetail(selected), 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [selected, loadDetail]);

  function refreshView() {
    return Promise.all([refresh(), refreshProviders()]);
  }

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refreshView();
      if (selected) await loadDetail(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function investigate(event: FormEvent) {
    event.preventDefault();
    if (!detail || !selectedProvider?.hasApiKey || !encryptionConfigured || providersLoading || providersError || busy || providerReviewRequired || !model.trim() || detail.incident.status !== "open") return;
    setBusy(true); setInvestigationError(""); setError("");
    try {
      await api(`/incidents/${detail.incident.id}/investigate`, "POST", { providerId: selectedProvider.id, providerRevision: selectedProvider.revision, model: model.trim() });
      await loadDetail(detail.incident.id);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "provider_changed") {
        setProviderReviewRequired(true);
        setInvestigationError("Provider configuration changed. Refresh and review the current destination and model before investigating again. Nothing was automatically resubmitted.");
        await refreshProviders();
      } else setInvestigationError(cause instanceof Error ? cause.message : "Unable to start the investigation.");
    } finally { setBusy(false); }
  }

  return <>
    <WorkspaceHeader
      title={drift ? "Configuration drift" : "From signal to resolution."}
      description={drift ? "Recorded configuration hash changes. Correlation is not causation." : "Review measured evidence, investigate, and record what fixed the incident."}
      summary={{ open: visibleOpen }} onRefresh={() => void refreshView()} actionError={{ error, dismiss: () => setError("") }}
      actions={!drift && <a className="workspace-action-link" href="#create-incident"><WorkspaceIcon name="add" />Create incident</a>}
    />
    <div className="incident-workspace">
      <section className="incident-queue" aria-labelledby="incidents-title">
        <h2 id="incidents-title">{drift ? "Recorded hash changes" : "Needs attention"}</h2>
        <div className="list">
          {visibleOpen === null ? incidentsError ? <p className="empty">Incident records are unavailable. Retry the incident refresh to load them.</p> : <AsciiLoading label="Loading incident records…" lines={3} /> : <>
            {visibleOpen === 0 && <p className="empty">No open {drift ? "drift records" : "incidents"} in the latest 100 records.</p>}
            {(["open", "resolved"] as const).map(status => {
              const records = visibleIncidents.filter(i => i.status === status);
              if (!records.length) return null;
              return <div className={`incident-group incident-group--${status}`} key={status}>
                {status === "resolved" && <h3>Recently resolved</h3>}
                {records.map(i => <Button key={i.id} className="incident" aria-pressed={selected === i.id} onClick={() => { setFocusDetail(null); chooseIncident(i.id); }}>
                  <span className="incident-card-top"><span>{categoryLabel(i.category)}</span><span>{i.status}</span></span>
                  <strong>{i.title}</strong>
                  <small>{i.hostname} · <time dateTime={i.resolved_at ?? i.created_at}>{new Date(i.resolved_at ?? i.created_at).toLocaleString()}</time></small>
                </Button>)}
              </div>;
            })}
          </>}
        </div>
        {!drift && <form id="create-incident" className="panel-footer" onSubmit={e => { e.preventDefault(); void act(async () => { const x = await api("/incidents", "POST", { agentId: hostId, title }); chooseIncident(x.id); }); }}>
          <h3>Create a test incident</h3>
          <Field id="incident-host" label="Server" required><Select id="incident-host" value={hostId} onChange={e => setHostId(e.target.value)} required><option value="">Choose a server</option>{hosts.map(h => <option key={h.id} value={h.id}>{h.hostname}</option>)}</Select></Field>
          <Field id="incident-title" label="Incident title" required><Input id="incident-title" value={title} onChange={e => setTitle(e.target.value)} required minLength={3} /></Field>
          <Button type="submit" loading={busy} disabled={!hostId || title.length < 3}>Create incident</Button>
        </form>}
      </section>
      {!detail && <Panel className="incident-placeholder">
        {detailError ? <Notice tone="warning" role="alert">Incident detail unavailable: {detailError}</Notice>
          : selected ? <AsciiLoading label="Loading incident detail…" lines={3} />
            : <p className="muted">Select an incident to review measured evidence and investigation activity.</p>}
      </Panel>}
      {detail && detail.incident.id === selected && (
        <Panel className="detail" role="region" aria-labelledby="incident-detail-title">
          <div className="panel-head"><div><h2 id="incident-detail-title" ref={incidentHeading} tabIndex={-1}>{detail.incident.title}</h2><p>{detail.incident.hostname} · {categoryLabel(detail.incident.category)}</p></div><Badge tone={detail.incident.status === "open" ? "danger" : "neutral"}>{detail.incident.status}</Badge></div>
          {detailError && <Notice tone="warning" role="alert">Incident detail refresh failed: {detailError}. Showing the last loaded record.</Notice>}
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
              <div className="evidence-head">
                <div>
                  <h3>Measured Signals</h3>
                  <p className="muted small">Collected host/agent evidence. The relevance score is a deterministic ranking, not a confidence level.</p>
                </div>
                {detail.evidence.length > 0 && <div className="evidence-sort" role="group" aria-label="Sort evidence">
                  <Button size="sm" variant={sortMode === "relevance" ? "primary" : "secondary"} aria-pressed={sortMode === "relevance"} onClick={() => setEvidenceSort("relevance")}>Relevance</Button>
                  <Button size="sm" variant={sortMode === "chronological" ? "primary" : "secondary"} aria-pressed={sortMode === "chronological"} onClick={() => setEvidenceSort("chronological")}>Chronological</Button>
                </div>}
              </div>
              {detail.evidence.length === 0 ? <p className="muted">No evidence collected for this incident yet.</p> : <ol className="evidence-list">
                {sortedEvidence.map(e => (
                  <li
                    key={e.id}
                    id={`evidence-${e.id}`}
                    ref={card => { if (card) evidenceRefs.current.set(e.id, card); else evidenceRefs.current.delete(e.id); }}
                    tabIndex={-1}
                    aria-label={`Evidence ${e.source} ${shortId(e.id)}${e.relevance?.cited ? ", cited by AI hypothesis" : ""}`}
                    className={`evidence evidence-card${highlightedEvidence === e.id ? " evidence-card--highlighted" : ""}`}
                  >
                    <div className="evidence-card-head">
                      <strong>{e.source}</strong>
                      <span className="evidence-badges">
                        {e.relevance && <Badge tone="info">Score {e.relevance.score}</Badge>}
                        {e.relevance?.cited && <Badge tone="warning">Cited</Badge>}
                      </span>
                    </div>
                    <code>{e.content}</code>
                    <div className="evidence-meta">
                      <small>ID: {e.id} · <time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString()}</time></small>
                      {e.relevance && e.relevance.matchedSignals.length > 0 && <span className="signal-chips" aria-label="Matched signals">
                        {e.relevance.matchedSignals.map(signal => <span className="signal-chip" key={signal} title={signal}>{SIGNAL_LABELS[signal] ?? signal}</span>)}
                      </span>}
                    </div>
                  </li>
                ))}
              </ol>}
              <h3 className="timeline-heading">Activity timeline</h3>
              <ol className="incident-timeline">
                {detail.incident.resolved_at && <li><time dateTime={detail.incident.resolved_at}>{new Date(detail.incident.resolved_at).toLocaleString()}</time><div>Human-confirmed resolution recorded</div></li>}
                <li><time dateTime={detail.incident.created_at}>{new Date(detail.incident.created_at).toLocaleString()}</time><div>Incident opened</div></li>
              </ol>
            </div>
            <div>
              <h3>AI Hypothesis</h3>
              <Notice tone="info" className="investigation-notice">AI output is an unverified hypothesis — never a confirmed root cause. Review the cited measured signals before taking action.</Notice>
              {providersError && <Notice tone="danger" role="alert">{providersError} Provider metadata may be stale. Investigate is disabled until a successful refresh. <Button size="sm" disabled={providersLoading} onClick={() => void refreshProviders()}>Retry provider refresh</Button></Notice>}
              {!providersLoading && !providersError && !encryptionConfigured && <Notice tone="warning">AI is unavailable until the server administrator configures AI_PROVIDER_ENCRYPTION_KEY on the Hub and Worker.</Notice>}
              {investigationError && <Notice tone="danger" role="alert">{investigationError}</Notice>}
              {providersPending ? <AsciiLoading label="Loading provider metadata…" /> : <form className="investigation-form" onSubmit={investigate}>
                <Field id="ai-provider" label="AI provider" hint={providersLoading ? "Refreshing provider metadata…" : "Only enabled connections are available."} required>
                  <Select id="ai-provider" value={providerId} aria-describedby="ai-provider-hint" required disabled={providersLoading || !!providersError || !encryptionConfigured || busy || !providers.some(p => p.enabled)} onChange={e => { const connection = providers.find(p => p.id === e.target.value); setProviderId(e.target.value); setModel(connection?.defaultModel ?? ""); }}>
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
              </form>}
              {detail.investigations.length === 0 ? <p className="muted">Investigation has not been started.</p> : detail.investigations.map(x => {
                const result = x.result_json;
                const citedIds = (result?.evidence_ids ?? []).filter(id => evidenceById.has(id));
                const invalidCitations = (result?.evidence_ids ?? []).length - citedIds.length;
                const usage = result ? usageLine(result) : null;
                return (
                <div className="finding" key={x.id}>
                  <div className="finding-head"><div><strong>{x.provider.name}</strong><span className="finding-provider-meta">{x.provider.protocol} · {x.provider.model ?? "Model not recorded (legacy)"}</span>{x.provider.baseUrl && <span className="finding-provider-meta">{x.provider.baseUrl}</span>}</div><Badge tone={x.status === "failed" ? "danger" : x.status === "completed" ? "info" : "warning"}>{x.status}</Badge></div>
                  {result ? <>
                    <p><strong>AI hypothesis (unverified): {result.probable_cause}</strong></p>
                    <p>Confidence: {result.confidence ?? "unknown"}</p>
                    <div className="citation-block">
                      <span className="citation-label">Cited evidence:</span>
                      {citedIds.length === 0
                        ? <Notice tone="warning" className="citation-empty">No verified evidence citations — confidence capped at low</Notice>
                        : <span className="citation-pills">
                            {citedIds.map(id => {
                              const evidence = evidenceById.get(id);
                              if (!evidence) return null;
                              return <button type="button" key={id} className="citation-pill" onClick={() => focusEvidence(id)} aria-label={`Jump to cited evidence ${evidence.source} ${shortId(id)}`}>
                                [{evidence.source} · {shortId(id)}]
                              </button>;
                            })}
                          </span>}
                      {invalidCitations > 0 && <p className="muted small">{invalidCitations} cited ID{invalidCitations === 1 ? "" : "s"} did not match collected evidence and {invalidCitations === 1 ? "was" : "were"} ignored.</p>}
                    </div>
                    {usage && <p className="usage-line">{usage}</p>}
                    {result.recommended_checks && <ul>{result.recommended_checks.map((c, k) => <li key={k}>{c}</li>)}</ul>}
                  </> : x.error ? <Notice tone="danger">{x.error}</Notice> : <p className="muted">Queued or running. Refresh in a few seconds.</p>}
                </div>
                );
              })}
              {detail.incident.status === "open" ? (
                <form className="resolution-form" onSubmit={e => { e.preventDefault(); void act(() => api(`/incidents/${detail.incident.id}/resolve`, "POST", { resolution })); }}>
                  <h3>Human-Confirmed Resolution</h3>
                  <p className="muted small">Only an operator-entered resolution is treated as confirmed; it is saved to incident memory.</p>
                  <Field id="incident-resolution" label="Confirmed resolution" hint="Describe what actually fixed this incident. Minimum 8 characters." required><Textarea id="incident-resolution" value={resolution} onChange={e => setResolution(e.target.value)} aria-describedby="incident-resolution-hint" rows={3} required minLength={8} /></Field>
                  <Button type="submit" loading={busy} disabled={resolution.trim().length < 8}>Mark resolved</Button>
                </form>
              ) : <Notice tone="success"><strong>Human-confirmed resolution</strong><p>{detail.incident.resolution}</p></Notice>}
            </div>
          </div>
        </Panel>
      )}
    </div>
  </>;
}
