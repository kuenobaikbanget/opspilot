"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  ChangeEventKind,
  IncidentTimelineEntry,
  IncidentTimelineResponse,
} from "@opspilot/contracts";
import { CHANGE_EVENT_KINDS } from "@opspilot/contracts";
import { Badge, Button, Field, Input, Notice, Select, Textarea } from "./ui";
import {
  ApiError,
  createChangeEvent,
  deleteIncidentChangeLink,
  getIncidentTimeline,
  linkIncidentChange,
} from "../lib/api";

const KIND_LABELS: Record<ChangeEventKind, string> = {
  deployment: "Deployment",
  config_change: "Config change",
  service_restart: "Service restart",
  maintenance: "Maintenance",
};

const ENTRY_LABELS: Record<IncidentTimelineEntry["type"], string> = {
  incident_opened: "Incident opened",
  incident_resolved: "Incident resolved",
  evidence: "Measured signal",
  investigation: "AI investigation",
  change_event: "Change",
  config_snapshot: "Config change",
};

/** Human relative offset, e.g. "12m before incident" / "4m after incident". */
function offsetLabel(offsetSeconds: number): string {
  const abs = Math.abs(offsetSeconds);
  const side = offsetSeconds < 0 ? "before incident" : offsetSeconds > 0 ? "after incident" : "at incident time";
  if (abs < 60) return `${abs}s ${side}`;
  const minutes = Math.floor(abs / 60);
  if (minutes < 60) return `${minutes}m ${side}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${side}`;
}

function entryBadges(entry: IncidentTimelineEntry) {
  switch (entry.type) {
    case "incident_opened":
      return <Badge tone="neutral">Incident lifecycle</Badge>;
    case "incident_resolved":
      return <Badge tone="success">Incident lifecycle</Badge>;
    case "evidence":
      return <Badge tone="info">Measured signal</Badge>;
    case "investigation":
      return <Badge tone="warning">AI hypothesis</Badge>;
    case "config_snapshot":
      return <Badge tone="info">Config change</Badge>;
    case "change_event":
      return <Badge tone="info">{KIND_LABELS[entry.kind]}</Badge>;
  }
}

function relationBadge(entry: Extract<IncidentTimelineEntry, { type: "change_event" | "config_snapshot" }>) {
  return entry.relation === "operator_linked"
    ? <Badge tone="warning">Operator linked · not proven causal</Badge>
    : <Badge tone="neutral">Observed nearby · correlation only</Badge>;
}

type Props = { incidentId: string; agentId: string };

/** Unified incident timeline: lifecycle, measured signals, AI investigations and same-host changes. */
export function IncidentTimeline({ incidentId, agentId }: Props) {
  const [timeline, setTimeline] = useState<IncidentTimelineResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showRecord, setShowRecord] = useState(false);
  const [kind, setKind] = useState<ChangeEventKind>("deployment");
  const [title, setTitle] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [version, setVersion] = useState("");
  const [summary, setSummary] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await getIncidentTimeline(incidentId);
      setTimeline(result);
      setError("");
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 401)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, [incidentId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function curate(entry: Extract<IncidentTimelineEntry, { type: "change_event" | "config_snapshot" }>) {
    const targetType = entry.type === "change_event" ? "change_event" : "config_snapshot";
    if (entry.link_id) {
      return act(() => deleteIncidentChangeLink(incidentId, entry.link_id!));
    }
    return act(() => linkIncidentChange(incidentId, { targetType, targetId: entry.id, action: "dismiss", note: null }));
  }

  function record(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    void act(async () => {
      await createChangeEvent({
        agentId,
        kind,
        title: title.trim(),
        serviceName: serviceName.trim() || null,
        version: version.trim() || null,
        summary: summary.trim() || null,
        source: "operator",
        occurredAt: null,
      });
      setTitle("");
      setServiceName("");
      setVersion("");
      setSummary("");
      setShowRecord(false);
    });
  }

  return (
    <div className="incident-timeline-wrap">
      <Notice tone="info" className="timeline-notice">
        {timeline?.causation_notice ?? "Nearby deployments and configuration changes are temporal context only — correlation does not establish root cause."}
      </Notice>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
      {!timeline && !error && <p className="muted">Loading timeline…</p>}
      {timeline && <>
        {timeline.entries.length === 0 && <p className="muted">No activity recorded for this incident yet.</p>}
        <ol className="incident-timeline">
          {timeline.entries.map((entry) => (
            <li key={`${entry.type}-${entry.id}`}>
              <time dateTime={entry.occurred_at}>{new Date(entry.occurred_at).toLocaleString()}</time>
              <div className="timeline-entry">
                <div className="timeline-entry-head">
                  <strong>{ENTRY_LABELS[entry.type]}</strong>
                  <span className="timeline-badges">
                    {entryBadges(entry)}
                    {entry.type === "change_event" || entry.type === "config_snapshot" ? relationBadge(entry) : null}
                  </span>
                </div>
                {entry.type === "incident_opened" || entry.type === "incident_resolved" ? (
                  <p>{entry.title}{entry.detail ? ` — ${entry.detail}` : ""}</p>
                ) : null}
                {entry.type === "evidence" && <code className="timeline-preview">{entry.preview}</code>}
                {entry.type === "investigation" && (
                  <p className="muted small">{entry.provider_name}{entry.provider_model ? ` · ${entry.provider_model}` : ""} · {entry.status}</p>
                )}
                {entry.type === "change_event" && (
                  <>
                    <p><strong>{entry.title}</strong>{entry.version ? ` · ${entry.version}` : ""}{entry.service_name ? ` · ${entry.service_name}` : ""}</p>
                    {entry.summary && <p className="muted small">{entry.summary}</p>}
                    <p className="muted small">{offsetLabel(entry.offset_seconds)} · source: {entry.source}{entry.note ? ` · note: ${entry.note}` : ""}</p>
                  </>
                )}
                {entry.type === "config_snapshot" && (
                  <>
                    <p><strong>{entry.file_path}</strong></p>
                    <p className="muted small">
                      {offsetLabel(entry.offset_seconds)} · {entry.previous_checksum_sha256 ? "hash changed" : "initial observation"} · {entry.checksum_sha256.slice(0, 12)}…
                      {entry.note ? ` · note: ${entry.note}` : ""}
                    </p>
                  </>
                )}
                {(entry.type === "change_event" || entry.type === "config_snapshot") && (
                  <div className="timeline-actions">
                    <Button size="sm" variant="ghost" loading={busy} onClick={() => curate(entry)}>
                      {entry.link_id ? "Unlink" : "Dismiss"}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        {timeline.dismissed_count > 0 && <p className="muted small">{timeline.dismissed_count} nearby change{timeline.dismissed_count === 1 ? " is" : "s are"} dismissed for this incident.</p>}
      </>}
      <details className="change-record" open={showRecord}>
        <summary onClick={(e) => { e.preventDefault(); setShowRecord(!showRecord); }}>
          Record deployment / change on this host
        </summary>
        <form className="change-record-form" onSubmit={record}>
          <Field id="change-kind" label="Kind" required>
            <Select id="change-kind" value={kind} onChange={(e) => setKind(e.target.value as ChangeEventKind)}>
              {CHANGE_EVENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </Select>
          </Field>
          <Field id="change-title" label="Title" hint="3-160 characters." required>
            <Input id="change-title" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={160} />
          </Field>
          <Field id="change-service" label="Service (optional)"><Input id="change-service" value={serviceName} onChange={(e) => setServiceName(e.target.value)} maxLength={80} placeholder="api.service" /></Field>
          <Field id="change-version" label="Version (optional)"><Input id="change-version" value={version} onChange={(e) => setVersion(e.target.value)} maxLength={80} placeholder="2.0.1" /></Field>
          <Field id="change-summary" label="Summary (optional)" hint="Secrets are redacted server-side before storing.">
            <Textarea id="change-summary" value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} maxLength={1000} />
          </Field>
          <p className="muted small">Recorded changes appear in this incident timeline as temporal context only — they are never treated as a proven cause.</p>
          <Button type="submit" variant="primary" loading={busy} disabled={title.trim().length < 3}>Record change</Button>
        </form>
      </details>
    </div>
  );
}
