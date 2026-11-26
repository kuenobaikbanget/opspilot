import type {
  ChangeEvent,
  ChangeEventKind,
  IncidentTimelineResponse,
  LinkIncidentChangeRequest,
  TimelineChangeEventRow,
  TimelineInvestigationRow,
  TimelineLinkRow,
  TimelineSnapshotRow,
} from "@opspilot/contracts";
import {
  CHANGE_EVENT_KINDS,
  TIMELINE_CAUSATION_NOTICE,
  TIMELINE_DEFAULT_AFTER_MINUTES,
  TIMELINE_DEFAULT_BEFORE_MINUTES,
  TIMELINE_MAX_AFTER_MINUTES,
  TIMELINE_MAX_BEFORE_MINUTES,
  TIMELINE_MIN_AFTER_MINUTES,
  TIMELINE_MIN_BEFORE_MINUTES,
  buildIncidentTimeline,
  parseCreateChangeEvent,
  parseLinkIncidentChange,
} from "@opspilot/contracts";
import { redact } from "@opspilot/ai";
import { audit, db } from "./db";
import { aiOrigin, apiError, j, jsonBody, urlUUID } from "./http";

/** Query bound for change/config candidates pulled from the database per timeline read. */
const TIMELINE_QUERY_LIMIT = 500;
/** Default and maximum page size for GET /api/changes. */
const CHANGES_DEFAULT_LIMIT = 50;
const CHANGES_MAX_LIMIT = 100;

type ChangeEventRow = Omit<ChangeEvent, "occurred_at" | "created_at"> & {
  occurred_at: Date;
  created_at: Date;
};

function changeEventDto(row: ChangeEventRow & { hostname?: string }): ChangeEvent {
  return {
    id: row.id,
    agent_id: row.agent_id,
    ...(row.hostname !== undefined ? { hostname: row.hostname } : {}),
    kind: row.kind,
    title: row.title,
    service_name: row.service_name,
    version: row.version,
    summary: row.summary,
    source: row.source,
    occurred_at: row.occurred_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

function parseLimit(raw: string | null): number | null {
  if (raw === null) return CHANGES_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > CHANGES_MAX_LIMIT) return null;
  return parsed;
}

function parseWindowMinutes(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

/** Correlated subquery: checksum of the previous snapshot of the same file on the same host. */
const PREVIOUS_CHECKSUM = `(
  SELECT p.checksum_sha256 FROM config_snapshots p
  WHERE p.agent_id = s.agent_id AND p.file_path = s.file_path
    AND (p.captured_at, p.id) < (s.captured_at, s.id)
  ORDER BY p.captured_at DESC, p.id DESC
  LIMIT 1
) AS previous_checksum_sha256`;

type SnapshotRow = {
  id: string;
  agent_id: string;
  file_path: string;
  checksum_sha256: string;
  previous_checksum_sha256: string | null;
  captured_at: Date;
};

type ChangeEventDbRow = Omit<TimelineChangeEventRow, "occurred_at" | "created_at"> & {
  occurred_at: Date;
  created_at: Date;
};

type InvestigationDbRow = Omit<TimelineInvestigationRow, "created_at"> & { created_at: Date };

type LinkRow = {
  id: string;
  change_event_id: string | null;
  config_snapshot_id: string | null;
  status: "linked" | "dismissed";
  note: string | null;
};

type IncidentRow = {
  id: string;
  agent_id: string;
  title: string;
  status: string;
  created_at: Date;
  resolved_at: Date | null;
  resolution: string | null;
};

/** Merges duplicate candidate rows (window query + linked query) by id, keeping the first. */
function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

async function readTimeline(req: Request, incidentId: string): Promise<Response> {
  if (!urlUUID(incidentId)) return apiError("Invalid incident id", "invalid_request");
  const [incident] = await db<IncidentRow[]>`SELECT id,agent_id,title,status,created_at,resolved_at,resolution FROM incidents WHERE id=${incidentId}`;
  if (!incident) return apiError("Incident not found", "not_found", 404);

  const params = new URL(req.url).searchParams;
  const beforeMinutes = parseWindowMinutes(params.get("beforeMinutes"), TIMELINE_DEFAULT_BEFORE_MINUTES, TIMELINE_MIN_BEFORE_MINUTES, TIMELINE_MAX_BEFORE_MINUTES);
  const afterMinutes = parseWindowMinutes(params.get("afterMinutes"), TIMELINE_DEFAULT_AFTER_MINUTES, TIMELINE_MIN_AFTER_MINUTES, TIMELINE_MAX_AFTER_MINUTES);
  if (beforeMinutes === null) return apiError(`beforeMinutes must be an integer between ${TIMELINE_MIN_BEFORE_MINUTES} and ${TIMELINE_MAX_BEFORE_MINUTES}`, "invalid_request");
  if (afterMinutes === null) return apiError(`afterMinutes must be an integer between ${TIMELINE_MIN_AFTER_MINUTES} and ${TIMELINE_MAX_AFTER_MINUTES}`, "invalid_request");

  const incidentCreatedMs = incident.created_at.getTime();
  const windowStart = new Date(incidentCreatedMs - beforeMinutes * 60_000).toISOString();
  const windowEnd = new Date(incidentCreatedMs + afterMinutes * 60_000).toISOString();
  const agentId = incident.agent_id;

  const [evidence, investigations, links, windowSnapshots, linkedSnapshots, windowEvents, linkedEvents] = await Promise.all([
    db<{ id: string; source: string; content: string; created_at: Date }[]>`
      SELECT id,source,content,created_at FROM evidence WHERE incident_id=${incidentId}
      ORDER BY created_at DESC, id DESC LIMIT 100`,
    db<InvestigationDbRow[]>`
      SELECT id,status,provider_name,provider_model,created_at FROM investigations WHERE incident_id=${incidentId}
      ORDER BY created_at DESC, id DESC LIMIT 50`,
    db<LinkRow[]>`
      SELECT id,change_event_id,config_snapshot_id,status,note FROM incident_change_links WHERE incident_id=${incidentId}
      ORDER BY created_at DESC, id DESC LIMIT ${TIMELINE_QUERY_LIMIT}`,
    db<SnapshotRow[]>`
      SELECT s.id,s.agent_id,s.file_path,s.checksum_sha256,s.captured_at,${db.unsafe(PREVIOUS_CHECKSUM)}
      FROM config_snapshots s
      WHERE s.agent_id=${agentId} AND s.captured_at >= ${windowStart}::timestamptz AND s.captured_at <= ${windowEnd}::timestamptz
      ORDER BY s.captured_at DESC, s.id DESC LIMIT ${TIMELINE_QUERY_LIMIT}`,
    db<SnapshotRow[]>`
      SELECT s.id,s.agent_id,s.file_path,s.checksum_sha256,s.captured_at,${db.unsafe(PREVIOUS_CHECKSUM)}
      FROM incident_change_links l JOIN config_snapshots s ON s.id = l.config_snapshot_id
      WHERE l.incident_id=${incidentId} AND l.config_snapshot_id IS NOT NULL
      ORDER BY s.captured_at DESC, s.id DESC LIMIT ${TIMELINE_QUERY_LIMIT}`,
    db<ChangeEventDbRow[]>`
      SELECT id,agent_id,kind,title,service_name,version,summary,source,occurred_at,created_at
      FROM change_events
      WHERE agent_id=${agentId} AND occurred_at >= ${windowStart}::timestamptz AND occurred_at <= ${windowEnd}::timestamptz
      ORDER BY occurred_at DESC, id DESC LIMIT ${TIMELINE_QUERY_LIMIT}`,
    db<ChangeEventDbRow[]>`
      SELECT c.id,c.agent_id,c.kind,c.title,c.service_name,c.version,c.summary,c.source,c.occurred_at,c.created_at
      FROM incident_change_links l JOIN change_events c ON c.id = l.change_event_id
      WHERE l.incident_id=${incidentId} AND l.change_event_id IS NOT NULL
      ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${TIMELINE_QUERY_LIMIT}`,
  ]);

  const snapshots: TimelineSnapshotRow[] = dedupeById([...windowSnapshots, ...linkedSnapshots]).map((row) => ({
    ...row,
    captured_at: row.captured_at.toISOString(),
  }));
  const changeEvents: TimelineChangeEventRow[] = dedupeById([...windowEvents, ...linkedEvents]).map((row) => ({
    ...row,
    occurred_at: row.occurred_at.toISOString(),
    created_at: row.created_at.toISOString(),
  }));

  const { entries, dismissed_count } = buildIncidentTimeline({
    incident: {
      id: incident.id,
      agent_id: incident.agent_id,
      title: incident.title,
      status: incident.status,
      created_at: incident.created_at.toISOString(),
      resolved_at: incident.resolved_at?.toISOString() ?? null,
      resolution: incident.resolution,
    },
    evidence: evidence.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
    investigations: investigations.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
    snapshots,
    changeEvents,
    links: links as TimelineLinkRow[],
    windowStart,
    windowEnd,
    redact,
  });

  const response: IncidentTimelineResponse = {
    incident_id: incident.id,
    agent_id: incident.agent_id,
    incident_created_at: incident.created_at.toISOString(),
    window_before_minutes: beforeMinutes,
    window_after_minutes: afterMinutes,
    causation_notice: TIMELINE_CAUSATION_NOTICE,
    entries,
    dismissed_count,
  };
  return j(response);
}

async function createChange(req: Request): Promise<Response> {
  const forbidden = aiOrigin(req);
  if (forbidden) return forbidden;
  const data = parseCreateChangeEvent(await jsonBody(req));
  if (!data) return apiError("Invalid change event request", "invalid_request");
  const host = await db<{ id: string }[]>`SELECT id FROM agents WHERE id=${data.agentId}`;
  if (!host.length) return apiError("Host not found", "not_found", 404);
  // Strip accidental tokens/secrets from operator-supplied text before storing.
  const title = redact(data.title);
  const summary = data.summary === null ? null : redact(data.summary);
  const [row] = await db<ChangeEventRow[]>`INSERT INTO change_events(agent_id,kind,title,service_name,version,summary,source,occurred_at)
    VALUES(${data.agentId},${data.kind},${title},${data.serviceName},${data.version},${summary},${data.source},COALESCE(${data.occurredAt}::timestamptz, NOW()))
    RETURNING id,agent_id,kind,title,service_name,version,summary,source,occurred_at,created_at`;
  // Audit records non-secret metadata only: never title/summary/note text.
  await audit("change.recorded", row.id, {
    agentId: data.agentId,
    kind: data.kind,
    serviceName: data.serviceName,
    version: data.version,
    source: data.source,
  });
  return j({ change: changeEventDto(row) }, 201);
}

async function linkChange(incidentId: string, req: Request): Promise<Response> {
  const forbidden = aiOrigin(req);
  if (forbidden) return forbidden;
  if (!urlUUID(incidentId)) return apiError("Invalid incident id", "invalid_request");
  const data: LinkIncidentChangeRequest | null = parseLinkIncidentChange(await jsonBody(req));
  if (!data) return apiError("Invalid link request", "invalid_request");

  const [incident] = await db<{ id: string; agent_id: string }[]>`SELECT id,agent_id FROM incidents WHERE id=${incidentId}`;
  if (!incident) return apiError("Incident not found", "not_found", 404);

  const target =
    data.targetType === "change_event"
      ? await db<{ id: string; agent_id: string }[]>`SELECT id,agent_id FROM change_events WHERE id=${data.targetId}`
      : await db<{ id: string; agent_id: string }[]>`SELECT id,agent_id FROM config_snapshots WHERE id=${data.targetId}`;
  if (!target.length) return apiError("Change target not found", "not_found", 404);
  // Host isolation: a link may only connect an incident to a change on the same host.
  if (target[0].agent_id !== incident.agent_id) {
    return apiError("Change target belongs to a different host", "cross_host", 409);
  }

  const status = data.action === "link" ? "linked" : "dismissed";
  const note = data.note === null ? null : redact(data.note);
  const changeEventId = data.targetType === "change_event" ? data.targetId : null;
  const configSnapshotId = data.targetType === "config_snapshot" ? data.targetId : null;

  const linkResult = await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(73460714, hashtext(${incidentId}))`;
    const existing = await tx<{ id: string }[]>`SELECT id FROM incident_change_links
      WHERE incident_id=${incidentId}
        AND ((${changeEventId}::uuid IS NOT NULL AND change_event_id=${changeEventId})
          OR (${configSnapshotId}::uuid IS NOT NULL AND config_snapshot_id=${configSnapshotId}))
      LIMIT 1`;
    if (existing.length) {
      await tx`UPDATE incident_change_links SET status=${status},note=${note},created_at=NOW() WHERE id=${existing[0].id}`;
      return { id: existing[0].id, inserted: false };
    }
    const [inserted] = await tx<{ id: string }[]>`INSERT INTO incident_change_links(incident_id,change_event_id,config_snapshot_id,status,note)
      VALUES(${incidentId},${changeEventId},${configSnapshotId},${status},${note}) RETURNING id`;
    return { id: inserted.id, inserted: true };
  });
  const linkId = linkResult.id;

  const action = data.action === "link" ? "incident.change_linked" : "incident.change_dismissed";
  await audit(action, incidentId, {
    targetType: data.targetType,
    targetId: data.targetId,
    linkId,
    status,
  });
  const [row] = await db<{ id: string; status: string; note: string | null; created_at: Date }[]>`
    SELECT id,status,note,created_at FROM incident_change_links WHERE id=${linkId}`;
  return j({
    link: {
      id: row.id,
      incident_id: incidentId,
      target_type: data.targetType,
      target_id: data.targetId,
      status: row.status,
      note: row.note,
      created_at: row.created_at.toISOString(),
    },
  }, linkResult.inserted ? 201 : 200);
}

/** Change-event and incident-timeline routes; called only behind the admin auth guard. */
export async function changeRoutes(req: Request, path: string, method: string): Promise<Response | null> {
  if (path === "/api/changes" && method === "GET") {
    const params = new URL(req.url).searchParams;
    const limit = parseLimit(params.get("limit"));
    if (limit === null) return apiError(`limit must be an integer between 1 and ${CHANGES_MAX_LIMIT}`, "invalid_request");
    let agentId: string | null = null;
    const agentParam = params.get("agentId");
    if (agentParam !== null) {
      if (!urlUUID(agentParam)) return apiError("Invalid host id", "invalid_request");
      agentId = agentParam;
    }
    let kind: string | null = null;
    const kindParam = params.get("kind");
    if (kindParam !== null) {
      if (!(CHANGE_EVENT_KINDS as readonly string[]).includes(kindParam)) {
        return apiError("Invalid kind", "invalid_request");
      }
      kind = kindParam;
    }
    const rows = await db<(ChangeEventRow & { hostname: string })[]>`
      SELECT c.id,c.agent_id,a.hostname,c.kind,c.title,c.service_name,c.version,c.summary,c.source,c.occurred_at,c.created_at
      FROM change_events c JOIN agents a ON a.id = c.agent_id
      WHERE (${agentId}::uuid IS NULL OR c.agent_id = ${agentId})
        AND (${kind}::text IS NULL OR c.kind = ${kind})
      ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${limit}`;
    return j({ changes: rows.map(changeEventDto), limit });
  }

  if (path === "/api/changes" && method === "POST") {
    return createChange(req);
  }

  const timelineMatch = path.match(/^\/api\/incidents\/([^/]+)\/timeline$/);
  if (timelineMatch && method === "GET") {
    return readTimeline(req, timelineMatch[1]);
  }

  const linkMatch = path.match(/^\/api\/incidents\/([^/]+)\/changes$/);
  if (linkMatch && method === "POST") {
    return linkChange(linkMatch[1], req);
  }

  const unlinkMatch = path.match(/^\/api\/incidents\/([^/]+)\/changes\/([^/]+)$/);
  if (unlinkMatch && method === "DELETE") {
    const forbidden = aiOrigin(req);
    if (forbidden) return forbidden;
    const [, incidentId, linkId] = unlinkMatch;
    if (!urlUUID(incidentId)) return apiError("Invalid incident id", "invalid_request");
    if (!urlUUID(linkId)) return apiError("Invalid link id", "invalid_request");
    const deleted = await db<{ id: string }[]>`
      DELETE FROM incident_change_links WHERE id=${linkId} AND incident_id=${incidentId} RETURNING id`;
    if (!deleted.length) return apiError("Link not found", "not_found", 404);
    await audit("incident.change_unlinked", incidentId, { linkId });
    return j({ ok: true });
  }

  return null;
}
