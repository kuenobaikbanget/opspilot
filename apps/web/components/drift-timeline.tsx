"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DriftDetailResponse, DriftTimelineEntry, Host, SemanticDiffChange } from "@opspilot/contracts";
import { AsciiLoading } from "./ascii-card-reveal";
import { Badge, Button, Input, Notice, Panel, Select } from "./ui";
import { WorkspaceIcon } from "./workspace-shell";
import { ApiError, getDriftDetail, getDriftTimeline } from "../lib/api";

type DriftTimelineProps = {
  hosts: Host[];
  onOpenIncident: (id: string) => void;
  onViewIncidents: () => void;
  onRefresh?: () => void;
};

function statusBadge(entry: DriftTimelineEntry) {
  switch (entry.diff_status) {
    case "diff_available":
      return <Badge tone="info">Redacted diff available</Badge>;
    case "unavailable":
      return <Badge tone="warning">Unavailable ({entry.unavailable_reason ?? "unknown"})</Badge>;
    default:
      return <Badge tone="neutral">Hash only</Badge>;
  }
}

function kindTone(kind: SemanticDiffChange["kind"]): "success" | "danger" | "warning" {
  return kind === "added" ? "success" : kind === "removed" ? "danger" : "warning";
}

function shortHash(hash: string | null): string {
  return hash ? `${hash.slice(0, 12)}…` : "—";
}

/** Chronological drift timeline with redacted semantic diffs. Correlation is not causation. */
export function DriftTimeline({ hosts, onOpenIncident, onViewIncidents, onRefresh }: DriftTimelineProps) {
  const [entries, setEntries] = useState<DriftTimelineEntry[] | null>(null);
  const [error, setError] = useState("");
  const [agentId, setAgentId] = useState("");
  const [pathFilter, setPathFilter] = useState("");
  const [appliedPath, setAppliedPath] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DriftDetailResponse | null>(null);
  const [detailError, setDetailError] = useState("");
  const [showUnified, setShowUnified] = useState(false);
  const reads = useRef<AbortController | null>(null);

  // Debounce the free-text path filter so typing does not spam the API.
  useEffect(() => {
    const timer = setTimeout(() => setAppliedPath(pathFilter.trim()), 300);
    return () => clearTimeout(timer);
  }, [pathFilter]);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const data = await getDriftTimeline(
        { agentId: agentId || undefined, pathContains: appliedPath || undefined, limit: 100 },
        signal,
      );
      if (signal.aborted) return;
      setEntries(data.entries);
      setError("");
    } catch (cause) {
      if (!signal.aborted && !(cause instanceof ApiError && cause.status === 401)) {
        setError(cause instanceof Error ? cause.message : "Drift timeline could not be loaded.");
      }
    }
  }, [agentId, appliedPath]);

  useEffect(() => {
    const controller = new AbortController();
    reads.current = controller;
    void load(controller.signal);
    const timer = setInterval(() => void load(controller.signal), 10_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const data = await getDriftDetail(id);
      setDetail(data);
      setDetailError("");
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 401)) {
        setDetailError(cause instanceof Error ? cause.message : "Drift detail could not be loaded.");
      }
    }
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    setDetail(null);
    setDetailError("");
    setShowUnified(false);
    void loadDetail(selected);
  }, [selected, loadDetail]);

  const selectedEntry = useMemo(() => entries?.find((e) => e.id === selected) ?? null, [entries, selected]);
  const changes = detail?.semantic_diff_json?.changes ?? [];

  return <>
    <div className="drift-filters" role="group" aria-label="Drift timeline filters">
      <label className="drift-filter">
        <span>Host</span>
        <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Filter by host">
          <option value="">All hosts</option>
          {hosts.map((h) => <option key={h.id} value={h.id}>{h.hostname}</option>)}
        </Select>
      </label>
      <label className="drift-filter drift-filter--path">
        <span>Path contains</span>
        <Input value={pathFilter} onChange={(e) => setPathFilter(e.target.value)} placeholder="/etc/…" aria-label="Filter by file path" />
      </label>
      <Button size="sm" onClick={() => { const c = reads.current; void load(c!.signal); onRefresh?.(); }}><WorkspaceIcon name="refresh" />Refresh</Button>
      <Button size="sm" variant="secondary" onClick={onViewIncidents}>Drift incidents</Button>
    </div>
    <Notice tone="info" className="drift-notice">
      Config snapshots are opt-in, allowlisted, redacted on the agent and re-redacted by the Hub.
      Drift entries show correlation only — <strong>correlation is not causation</strong>: a config
      change near an incident is not proof that it caused the incident.
    </Notice>
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
    <div className="drift-layout">
      <section aria-labelledby="drift-timeline-title" className="drift-timeline-panel">
        <h2 id="drift-timeline-title">Drift timeline</h2>
        {!entries ? <AsciiLoading label="Loading drift timeline…" lines={3} /> : <>
          {entries.length === 0 && <p className="empty">No drift snapshots recorded yet. Agents record SHA-256 hashes of allowlisted config files; with OPSPILOT_CONFIG_DIFFS=true they also send redacted snapshots.</p>}
          <ol className="drift-list">
            {entries.map((entry) => <li key={entry.id}>
              <button
                type="button"
                className={`drift-entry${selected === entry.id ? " drift-entry--selected" : ""}`}
                aria-pressed={selected === entry.id}
                onClick={() => setSelected(entry.id)}
              >
                <span className="drift-entry-top">
                  <strong>{entry.hostname}</strong>
                  <time dateTime={entry.captured_at}>{new Date(entry.captured_at).toLocaleString()}</time>
                </span>
                <code className="drift-entry-path">{entry.file_path}</code>
                <span className="drift-entry-hash" title={`${entry.previous_checksum_sha256 ?? "none"} → ${entry.checksum_sha256}`}>
                  {shortHash(entry.previous_checksum_sha256)} → {shortHash(entry.checksum_sha256)}
                </span>
                <span className="drift-entry-badges">
                  {statusBadge(entry)}
                  {entry.redaction_count > 0 && <Badge tone="warning">{entry.redaction_count} secret{entry.redaction_count === 1 ? "" : "s"} redacted</Badge>}
                  {entry.diff_status === "diff_available" && <Badge tone="neutral">+{entry.change_counts.added} ~{entry.change_counts.modified} -{entry.change_counts.removed}</Badge>}
                </span>
              </button>
            </li>)}
          </ol>
        </>}
      </section>
      <section aria-labelledby="drift-detail-title" className="drift-detail-panel">
        {!selectedEntry && <Panel className="drift-placeholder"><p className="muted">Select a drift entry to inspect its redacted semantic diff.</p></Panel>}
        {selectedEntry && <>
          <div className="panel-head">
            <div>
              <h2 id="drift-detail-title">Drift detail</h2>
              <p>{selectedEntry.hostname} · <code>{selectedEntry.file_path}</code></p>
            </div>
            {statusBadge(selectedEntry)}
          </div>
          {detailError && <Notice tone="warning" role="alert">Detail refresh failed: {detailError}. Showing the timeline record.</Notice>}
          {!detail && !detailError && <AsciiLoading label="Loading drift detail…" lines={3} />}
          {detail && detail.id === selected && <>
            <dl className="drift-meta">
              <div><dt>Captured</dt><dd><time dateTime={detail.captured_at}>{new Date(detail.captured_at).toLocaleString()}</time></dd></div>
              <div><dt>Hash transition</dt><dd><code title={`${detail.previous_checksum_sha256 ?? "none"} → ${detail.checksum_sha256}`}>{shortHash(detail.previous_checksum_sha256)} → {shortHash(detail.checksum_sha256)}</code></dd></div>
              <div><dt>Redactions</dt><dd>{detail.redaction_count} secret{detail.redaction_count === 1 ? "" : "s"} redacted{detail.content_truncated ? " · content truncated" : ""}</dd></div>
              <div><dt>Format</dt><dd>{detail.content_format ?? "hash only"}</dd></div>
              {detail.incident_id && <div><dt>Linked incident</dt><dd><Button size="sm" onClick={() => onOpenIncident(detail.incident_id!)}>View config_drift incident</Button></dd></div>}
            </dl>
            {detail.diff_summary && <p className="drift-summary">{detail.diff_summary}</p>}
            {!detail.semantic_diff_json && <p className="muted">No semantic diff computed for this transition (hash-only or first baseline snapshot). Content is stored redacted for the next comparison.</p>}
            {detail.semantic_diff_json && <>
              <h3>Semantic changes</h3>
              {changes.length === 0 ? <p className="muted">No key-level changes detected.</p> : <table className="drift-changes">
                <thead><tr><th scope="col">Change</th><th scope="col">Key</th><th scope="col">Section</th><th scope="col">Before → after (redacted)</th></tr></thead>
                <tbody>
                  {changes.map((change, i) => <tr key={`${change.kind}:${change.key}:${i}`}>
                    <td><Badge tone={kindTone(change.kind)}>{change.kind}</Badge></td>
                    <td><code>{change.key}</code></td>
                    <td>{change.section ? <code>{change.section}</code> : <span className="muted">—</span>}</td>
                    <td className="drift-values">
                      {change.kind === "added" ? <code className="drift-after">+ {change.after ?? ""}</code>
                        : change.kind === "removed" ? <code className="drift-before">− {change.before ?? ""}</code>
                        : <><code className="drift-before">− {change.before ?? ""}</code><br /><code className="drift-after">+ {change.after ?? ""}</code></>}
                    </td>
                  </tr>)}
                </tbody>
              </table>}
              {detail.semantic_diff_json.truncated && <p className="muted small">Diff output was truncated to its bounded size.</p>}
              <div className="drift-unified-toggle">
                <Button size="sm" variant="secondary" aria-pressed={showUnified} onClick={() => setShowUnified((v) => !v)}>
                  {showUnified ? "Hide unified diff" : "Show redacted unified diff"}
                </Button>
                <span className="muted small">+{detail.semantic_diff_json.addedLines} / -{detail.semantic_diff_json.removedLines} lines</span>
              </div>
              {showUnified && <pre className="drift-unified" tabIndex={0}><code>{detail.semantic_diff_json.unifiedDiff}</code></pre>}
            </>}
            <Notice tone="info" className="drift-notice">All values above are redacted. Correlation is not causation — this diff describes what changed, not what caused any incident.</Notice>
          </>}
        </>}
      </section>
    </div>
  </>;
}
