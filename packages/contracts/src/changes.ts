/**
 * Change events and incident-timeline linking contracts.
 *
 * Core invariant: deployments, config changes, service restarts and maintenance
 * windows shown near an incident are temporal context only. Every change entry
 * carries `causation_claimed: false` and a non-causal `relation`; correlation is
 * never presented as root cause.
 */

/** Kinds of operator/agent-recorded change events on a host. */
export const CHANGE_EVENT_KINDS = ["deployment", "config_change", "service_restart", "maintenance"] as const;
export type ChangeEventKind = (typeof CHANGE_EVENT_KINDS)[number];

/** One recorded change on a host (deployment, config change, restart, maintenance). */
export type ChangeEvent = {
  id: string;
  agent_id: string;
  hostname?: string;
  kind: ChangeEventKind;
  title: string;
  service_name: string | null;
  version: string | null;
  summary: string | null;
  source: string;
  occurred_at: string;
  created_at: string;
};

/** How a change entry relates to the incident: never causal. */
export type IncidentChangeRelation = "observed_nearby" | "operator_linked";

export const CHANGE_EVENT_TITLE_MIN = 3;
export const CHANGE_EVENT_TITLE_MAX = 160;
export const CHANGE_EVENT_SERVICE_NAME_MAX = 80;
export const CHANGE_EVENT_VERSION_MAX = 80;
export const CHANGE_EVENT_SUMMARY_MAX = 1000;
export const CHANGE_EVENT_SOURCE_MAX = 60;
export const CHANGE_EVENT_NOTE_MAX = 300;
/** Maximum future clock skew accepted on a client-supplied occurredAt. */
export const CHANGE_EVENT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Maximum age accepted on a client-supplied occurredAt. */
export const CHANGE_EVENT_MAX_PAST_MS = 365 * 24 * 60 * 60 * 1000;

/** Service names are unit/container-style identifiers, not free text. */
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@/-]{0,79}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_LIKE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Body accepted by `POST /api/changes`. */
export type CreateChangeEventRequest = {
  agentId: string;
  kind: ChangeEventKind;
  title: string;
  serviceName: string | null;
  version: string | null;
  summary: string | null;
  source: string;
  /** ISO timestamp; null lets the server use NOW(). */
  occurredAt: string | null;
};

function requestObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/**
 * Nullable bounded string field. Returns `null` when absent/null, the trimmed
 * bounded string when valid, and `false` when the type or bounds are invalid
 * (callers must reject `false`, not silently treat it as absent).
 */
function optionalString(value: unknown, max: number): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : false;
}

/**
 * Strict parser for `POST /api/changes`. Unknown keys and invalid types reject.
 * `occurredAt` must be a valid ISO timestamp no more than 5 minutes in the future
 * and no more than 365 days in the past; absent means server NOW().
 */
export function parseCreateChangeEvent(value: unknown, now = Date.now()): CreateChangeEventRequest | null {
  if (!requestObject(value)) return null;
  const allowed = ["agentId", "kind", "title", "serviceName", "version", "summary", "source", "occurredAt"];
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !allowed.includes(key))) return null;

  if (typeof value.agentId !== "string" || !UUID_PATTERN.test(value.agentId)) return null;
  if (typeof value.kind !== "string" || !(CHANGE_EVENT_KINDS as readonly string[]).includes(value.kind)) return null;
  const title = trimmedString(value.title, CHANGE_EVENT_TITLE_MAX);
  if (title === null || title.length < CHANGE_EVENT_TITLE_MIN) return null;

  const serviceName = optionalString(value.serviceName, CHANGE_EVENT_SERVICE_NAME_MAX);
  if (serviceName === false) return null;
  if (serviceName !== null && !SERVICE_NAME_PATTERN.test(serviceName)) return null;
  const version = optionalString(value.version, CHANGE_EVENT_VERSION_MAX);
  if (version === false) return null;
  const summary = optionalString(value.summary, CHANGE_EVENT_SUMMARY_MAX);
  if (summary === false) return null;
  const sourceRaw = value.source === undefined ? "operator" : value.source;
  const source = typeof sourceRaw === "string" ? trimmedString(sourceRaw, CHANGE_EVENT_SOURCE_MAX) : false;
  if (source === false || source === null) return null;

  let occurredAt: string | null = null;
  if (value.occurredAt !== undefined && value.occurredAt !== null) {
    if (typeof value.occurredAt !== "string" || !ISO_LIKE_PATTERN.test(value.occurredAt)) return null;
    const time = Date.parse(value.occurredAt);
    if (!Number.isFinite(time)) return null;
    if (time > now + CHANGE_EVENT_MAX_FUTURE_SKEW_MS) return null;
    if (time < now - CHANGE_EVENT_MAX_PAST_MS) return null;
    occurredAt = new Date(time).toISOString();
  }

  return {
    agentId: value.agentId,
    kind: value.kind as ChangeEventKind,
    title,
    serviceName,
    version,
    summary,
    source,
    occurredAt,
  };
}

/** Body accepted by `POST /api/incidents/:id/changes`. */
export type LinkIncidentChangeRequest = {
  targetType: "change_event" | "config_snapshot";
  targetId: string;
  action: "link" | "dismiss";
  note: string | null;
};

/** Strict parser for link/dismiss requests; unknown keys and invalid types reject. */
export function parseLinkIncidentChange(value: unknown): LinkIncidentChangeRequest | null {
  if (!requestObject(value)) return null;
  const allowed = ["targetType", "targetId", "action", "note"];
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !allowed.includes(key))) return null;
  if (value.targetType !== "change_event" && value.targetType !== "config_snapshot") return null;
  if (typeof value.targetId !== "string" || !UUID_PATTERN.test(value.targetId)) return null;
  if (value.action !== "link" && value.action !== "dismiss") return null;
  const note = optionalString(value.note, CHANGE_EVENT_NOTE_MAX);
  if (note === false) return null;
  return { targetType: value.targetType, targetId: value.targetId, action: value.action, note };
}

/** One unified incident-timeline entry. Change entries always carry `causation_claimed: false`. */
export type IncidentTimelineEntry =
  | { type: "incident_opened" | "incident_resolved"; id: string; occurred_at: string; title: string; detail?: string | null }
  | { type: "evidence"; id: string; occurred_at: string; source: string; preview: string }
  | { type: "investigation"; id: string; occurred_at: string; status: string; provider_name: string; provider_model: string | null }
  | {
      type: "change_event";
      id: string;
      link_id: string | null;
      occurred_at: string;
      offset_seconds: number;
      relation: IncidentChangeRelation;
      causation_claimed: false;
      kind: ChangeEventKind;
      title: string;
      service_name: string | null;
      version: string | null;
      summary: string | null;
      source: string;
      note: string | null;
    }
  | {
      type: "config_snapshot";
      id: string;
      link_id: string | null;
      occurred_at: string;
      offset_seconds: number;
      relation: IncidentChangeRelation;
      causation_claimed: false;
      file_path: string;
      checksum_sha256: string;
      previous_checksum_sha256: string | null;
      note: string | null;
    };

/** Unified incident timeline response. Correlation is never causation. */
export type IncidentTimelineResponse = {
  incident_id: string;
  agent_id: string;
  incident_created_at: string;
  window_before_minutes: number;
  window_after_minutes: number;
  causation_notice: string;
  /** Newest first (occurred_at descending, id descending as tie-break). */
  entries: IncidentTimelineEntry[];
  dismissed_count: number;
};

/** Notice attached to every timeline response and rendered in the UI. */
export const TIMELINE_CAUSATION_NOTICE =
  "Nearby deployments and configuration changes are temporal context only. Correlation does not establish root cause.";

export const TIMELINE_DEFAULT_BEFORE_MINUTES = 120;
export const TIMELINE_DEFAULT_AFTER_MINUTES = 30;
export const TIMELINE_MIN_BEFORE_MINUTES = 5;
export const TIMELINE_MAX_BEFORE_MINUTES = 1440;
export const TIMELINE_MIN_AFTER_MINUTES = 0;
export const TIMELINE_MAX_AFTER_MINUTES = 720;
/** Evidence previews in the timeline are redacted and capped to this length. */
export const TIMELINE_EVIDENCE_PREVIEW_MAX = 240;

/** Row shapes consumed by the pure timeline builder (already host-scoped by the caller). */
export type TimelineIncident = {
  id: string;
  agent_id: string;
  title: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolution?: string | null;
};
export type TimelineEvidenceRow = { id: string; source: string; content: string; created_at: string };
export type TimelineInvestigationRow = { id: string; status: string; provider_name: string; provider_model: string | null; created_at: string };
export type TimelineSnapshotRow = {
  id: string;
  agent_id: string;
  file_path: string;
  checksum_sha256: string;
  previous_checksum_sha256: string | null;
  captured_at: string;
};
export type TimelineChangeEventRow = {
  id: string;
  agent_id: string;
  kind: ChangeEventKind;
  title: string;
  service_name: string | null;
  version: string | null;
  summary: string | null;
  source: string;
  occurred_at: string;
  created_at: string;
};
export type TimelineLinkRow = {
  id: string;
  change_event_id: string | null;
  config_snapshot_id: string | null;
  status: "linked" | "dismissed";
  note: string | null;
};

const offsetSeconds = (occurredAt: string, incidentCreatedAt: string): number =>
  Math.round((Date.parse(occurredAt) - Date.parse(incidentCreatedAt)) / 1000);

/**
 * Pure merge of one incident's lifecycle, evidence, investigations and same-host
 * change candidates into a unified timeline, newest first. Change candidates are
 * included when manually linked (any time) or observed inside the window;
 * dismissed links hide their target; window config snapshots are included only
 * when they are an initial observation or a checksum change. Every change entry
 * is emitted with `causation_claimed: false`. Rows from other hosts are dropped
 * defensively even if the caller failed to scope them.
 */
export function buildIncidentTimeline(input: {
  incident: TimelineIncident;
  evidence?: TimelineEvidenceRow[];
  investigations?: TimelineInvestigationRow[];
  snapshots?: TimelineSnapshotRow[];
  changeEvents?: TimelineChangeEventRow[];
  links?: TimelineLinkRow[];
  windowStart: string;
  windowEnd: string;
  previewMax?: number;
  /** Optional redactor applied to evidence previews and resolution detail (e.g. redact() from @opspilot/ai). */
  redact?: (text: string) => string;
}): { entries: IncidentTimelineEntry[]; dismissed_count: number } {
  const { incident } = input;
  const redact = input.redact ?? ((text: string) => text);
  const previewMax = input.previewMax ?? TIMELINE_EVIDENCE_PREVIEW_MAX;
  const windowStartMs = Date.parse(input.windowStart);
  const windowEndMs = Date.parse(input.windowEnd);
  const inWindow = (occurredAt: string): boolean => {
    const time = Date.parse(occurredAt);
    return time >= windowStartMs && time <= windowEndMs;
  };

  const changeEventLinks = new Map<string, TimelineLinkRow>();
  const snapshotLinks = new Map<string, TimelineLinkRow>();
  let dismissedCount = 0;
  for (const link of input.links ?? []) {
    if (link.status === "dismissed") dismissedCount += 1;
    if (link.change_event_id) changeEventLinks.set(link.change_event_id, link);
    if (link.config_snapshot_id) snapshotLinks.set(link.config_snapshot_id, link);
  }
  const dismissedEventIds = new Set(
    [...changeEventLinks.values()].filter((l) => l.status === "dismissed").map((l) => l.change_event_id!),
  );
  const dismissedSnapshotIds = new Set(
    [...snapshotLinks.values()].filter((l) => l.status === "dismissed").map((l) => l.config_snapshot_id!),
  );

  const entries: IncidentTimelineEntry[] = [];

  entries.push({
    type: "incident_opened",
    id: incident.id,
    occurred_at: incident.created_at,
    title: incident.title,
    detail: null,
  });
  if (incident.status === "resolved" && incident.resolved_at) {
    entries.push({
      type: "incident_resolved",
      id: incident.id,
      occurred_at: incident.resolved_at,
      title: incident.title,
      detail: incident.resolution ? redact(incident.resolution) : null,
    });
  }

  for (const row of input.evidence ?? []) {
    entries.push({
      type: "evidence",
      id: row.id,
      occurred_at: row.created_at,
      source: row.source,
      preview: redact(row.content).slice(0, previewMax),
    });
  }

  for (const row of input.investigations ?? []) {
    entries.push({
      type: "investigation",
      id: row.id,
      occurred_at: row.created_at,
      status: row.status,
      provider_name: row.provider_name,
      provider_model: row.provider_model,
    });
  }

  for (const row of input.snapshots ?? []) {
    if (row.agent_id !== incident.agent_id) continue; // host isolation, defensive
    if (dismissedSnapshotIds.has(row.id)) continue;
    const link = snapshotLinks.get(row.id);
    const changed = row.previous_checksum_sha256 === null || row.previous_checksum_sha256 !== row.checksum_sha256;
    if (!link && !(inWindow(row.captured_at) && changed)) continue;
    entries.push({
      type: "config_snapshot",
      id: row.id,
      link_id: link?.id ?? null,
      occurred_at: row.captured_at,
      offset_seconds: offsetSeconds(row.captured_at, incident.created_at),
      relation: link && link.status === "linked" ? "operator_linked" : "observed_nearby",
      causation_claimed: false,
      file_path: row.file_path,
      checksum_sha256: row.checksum_sha256,
      previous_checksum_sha256: row.previous_checksum_sha256,
      note: link?.note ?? null,
    });
  }

  for (const row of input.changeEvents ?? []) {
    if (row.agent_id !== incident.agent_id) continue; // host isolation, defensive
    if (dismissedEventIds.has(row.id)) continue;
    const link = changeEventLinks.get(row.id);
    if (!link && !inWindow(row.occurred_at)) continue;
    entries.push({
      type: "change_event",
      id: row.id,
      link_id: link?.id ?? null,
      occurred_at: row.occurred_at,
      offset_seconds: offsetSeconds(row.occurred_at, incident.created_at),
      relation: link && link.status === "linked" ? "operator_linked" : "observed_nearby",
      causation_claimed: false,
      kind: row.kind,
      title: row.title,
      service_name: row.service_name,
      version: row.version,
      summary: row.summary,
      source: row.source,
      note: link?.note ?? null,
    });
  }

  entries.sort((a, b) => {
    const aTime = Date.parse(a.occurred_at);
    const bTime = Date.parse(b.occurred_at);
    if (aTime !== bTime) return bTime - aTime; // newest first
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  return { entries, dismissed_count: dismissedCount };
}
