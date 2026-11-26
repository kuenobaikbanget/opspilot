import type { SQL } from "bun";
import { probeEndpointTarget, type EndpointProbeResult } from "@opspilot/ai/endpoint-probe";
import {
  ENDPOINT_RUNS_LIMIT,
  ENDPOINT_RUNS_RETENTION,
  parseCreateEndpointMonitorRequest,
  parseUpdateEndpointMonitorRequest,
  validateEndpointTargetUrl,
  type EndpointMonitor,
  type EndpointMonitorRun,
  type EndpointRunsPayload,
  type ServicesPayload,
} from "@opspilot/contracts";
import { agentSession } from "./agents";
import { audit, db } from "./db";
import { aiOrigin, apiError, j, jsonBody, urlUUID } from "./http";
import { readSystemdStatus } from "./systemd";
import { readHostWorkloads, readWorkloadList } from "./workloads";

type EndpointMonitorRow = Omit<EndpointMonitor, "last_checked_at" | "run_counts"> & {
  last_checked_at: Date | null;
  runs_total: number;
  runs_up: number;
  runs_down: number;
};

type EndpointRunRow = Omit<EndpointMonitorRun, "started_at" | "finished_at" | "created_at"> & {
  started_at: Date;
  finished_at: Date;
  created_at: Date;
};

/** Server-side named probe location; never client-supplied. */
const probeLocation = (process.env.OPSPILOT_PROBE_LOCATION || "hub-local").slice(0, 80);

// Run counts are scoped to each monitor row via LATERAL, never fleet-wide.
const ENDPOINT_SELECT = `SELECT m.id,m.agent_id,m.service_name,m.name,m.target_url,m.expected_status,m.probe_location,
  m.enabled,m.check_interval_seconds,m.last_status,m.last_http_status,m.last_latency_ms,m.last_error,m.last_checked_at,
  COALESCE(r.total,0)::int AS runs_total,COALESCE(r.up,0)::int AS runs_up,COALESCE(r.down,0)::int AS runs_down
  FROM endpoint_monitors m
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status='up') AS up,
      COUNT(*) FILTER (WHERE status='down') AS down
    FROM endpoint_monitor_runs r WHERE r.monitor_id=m.id
  ) r ON true`;

const ENDPOINT_RETURNING = `id,agent_id,service_name,name,target_url,expected_status,probe_location,enabled,check_interval_seconds,
  last_status,last_http_status,last_latency_ms,last_error,last_checked_at`;

function endpointDto(row: EndpointMonitorRow): EndpointMonitor {
  const { last_checked_at, runs_total, runs_up, runs_down, ...rest } = row;
  return {
    ...rest,
    last_checked_at: last_checked_at?.toISOString() ?? null,
    run_counts: { total: Number(runs_total), up: Number(runs_up), down: Number(runs_down) },
  };
}

function runDto(row: EndpointRunRow): EndpointMonitorRun {
  return {
    ...row,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

async function selectEndpoint(id: string): Promise<EndpointMonitorRow | undefined> {
  const rows = await db<EndpointMonitorRow[]>`${db.unsafe(ENDPOINT_SELECT)} WHERE m.id=${id}`;
  return rows[0];
}

function allowLoopbackMock(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.OPSPILOT_ALLOW_LOOPBACK_PROBES === "true"
  );
}

/** Persists one probe outcome as a run row plus last_* state, pruning bounded history. */
async function recordProbeRun(
  tx: SQL,
  monitorId: string,
  location: string,
  result: EndpointProbeResult,
  startedAt: Date,
  finishedAt: Date,
): Promise<void> {
  await tx`INSERT INTO endpoint_monitor_runs(
      monitor_id,probe_location,status,http_status,latency_ms,error,started_at,finished_at
    ) VALUES(
      ${monitorId},${location},${result.status},${result.httpStatus},${result.latencyMs},${result.error},${startedAt},${finishedAt}
    )`;
  await tx`UPDATE endpoint_monitors SET
      last_status=${result.status},
      last_http_status=${result.httpStatus},
      last_latency_ms=${result.latencyMs},
      last_error=${result.error},
      last_checked_at=NOW()
    WHERE id=${monitorId}`;
  await tx`DELETE FROM endpoint_monitor_runs
    WHERE monitor_id=${monitorId} AND id NOT IN (
      SELECT id FROM endpoint_monitor_runs WHERE monitor_id=${monitorId}
      ORDER BY started_at DESC, id DESC LIMIT ${ENDPOINT_RUNS_RETENTION}
    )`;
}

async function agentExists(agentId: string): Promise<boolean> {
  const host = await db<{ id: string }[]>`SELECT id FROM agents WHERE id=${agentId}`;
  return host.length > 0;
}

/** Serves bounded service inventory and endpoint monitor routes behind the admin auth guard. */
export async function serviceRoutes(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  const hostMatch = path.match(/^\/api\/hosts\/([^/]+)\/services$/);
  if (hostMatch && method === "GET") {
    const id = hostMatch[1];
    if (!urlUUID(id)) return apiError("Invalid host id", "invalid_request");
    const status = await readSystemdStatus(id, agentSession);
    return status ? j(status) : apiError("Host not found", "not_found", 404);
  }

  const workloadMatch = path.match(/^\/api\/hosts\/([^/]+)\/workloads$/);
  if (workloadMatch && method === "GET") {
    const id = workloadMatch[1];
    if (!urlUUID(id)) return apiError("Invalid host id", "invalid_request");
    const workloads = await readHostWorkloads(id, agentSession);
    return workloads ? j(workloads) : apiError("Host not found", "not_found", 404);
  }

  if (path === "/api/workloads" && method === "GET") {
    return j(await readWorkloadList(agentSession));
  }

  if (path === "/api/services" && method === "GET") {
    const endpoints = await db<EndpointMonitorRow[]>`${db.unsafe(ENDPOINT_SELECT)} ORDER BY m.created_at DESC,m.id LIMIT 100`;
    const payload: ServicesPayload = { endpoints: endpoints.map(endpointDto) };
    return j(payload);
  }

  if (path === "/api/endpoints" && method === "POST") {
    const forbidden = aiOrigin(req);
    if (forbidden) return forbidden;
    const data = parseCreateEndpointMonitorRequest(await jsonBody(req));
    if (!data) return apiError("Invalid endpoint monitor payload", "invalid_request");
    if (data.agentId !== null && !urlUUID(data.agentId)) {
      return apiError("Invalid host id", "invalid_request");
    }
    const targetUrl = validateEndpointTargetUrl(data.targetUrl, { allowLoopbackMock: allowLoopbackMock() });
    if (!targetUrl) {
      return apiError("Target URL rejected by egress policy", "invalid_target");
    }
    if (data.agentId !== null && !(await agentExists(data.agentId))) {
      return apiError("Host not found", "invalid_request", 404);
    }

    const [inserted] = await db<{ id: string }[]>`INSERT INTO endpoint_monitors(
        agent_id,service_name,name,target_url,expected_status,probe_location,enabled,check_interval_seconds
      ) VALUES(${data.agentId},${data.serviceName},${data.name},${targetUrl},${data.expectedStatus},${probeLocation},${data.enabled},${data.checkIntervalSeconds})
      RETURNING id`;
    const row = await selectEndpoint(inserted.id);
    if (!row) return apiError("Endpoint not found", "not_found", 404);
    // Audit never includes the target URL (secret-minimization policy).
    await audit("endpoint.created", row.id, {
      name: data.name,
      serviceName: data.serviceName,
      agentId: data.agentId,
      expectedStatus: data.expectedStatus,
      checkIntervalSeconds: data.checkIntervalSeconds,
      enabled: data.enabled,
      probeLocation,
    });
    return j({ endpoint: endpointDto(row) }, 201);
  }

  const endpointMatch = path.match(/^\/api\/endpoints\/([^/]+)$/);
  if (endpointMatch && method === "DELETE") {
    const forbidden = aiOrigin(req);
    if (forbidden) return forbidden;
    const id = endpointMatch[1];
    if (!urlUUID(id)) return apiError("Invalid endpoint id", "invalid_request");
    const deleted = await db<{ id: string; name: string }[]>`
      DELETE FROM endpoint_monitors WHERE id=${id} RETURNING id,name`;
    if (!deleted.length) return apiError("Endpoint not found", "not_found", 404);
    await audit("endpoint.deleted", id, { name: deleted[0].name });
    return j({ ok: true });
  }

  if (endpointMatch && method === "PATCH") {
    const forbidden = aiOrigin(req);
    if (forbidden) return forbidden;
    const id = endpointMatch[1];
    if (!urlUUID(id)) return apiError("Invalid endpoint id", "invalid_request");
    const patch = parseUpdateEndpointMonitorRequest(await jsonBody(req));
    if (!patch) return apiError("Invalid endpoint monitor payload", "invalid_request");
    const [existing] = await db<Omit<EndpointMonitorRow, "runs_total" | "runs_up" | "runs_down">[]>`
      SELECT ${db.unsafe(ENDPOINT_RETURNING)} FROM endpoint_monitors WHERE id=${id}`;
    if (!existing) return apiError("Endpoint not found", "not_found", 404);

    let targetUrl = existing.target_url;
    if (patch.targetUrl !== undefined) {
      const validated = validateEndpointTargetUrl(patch.targetUrl, { allowLoopbackMock: allowLoopbackMock() });
      if (!validated) return apiError("Target URL rejected by egress policy", "invalid_target");
      targetUrl = validated;
    }
    let agentId = existing.agent_id;
    if (patch.agentId !== undefined) {
      if (patch.agentId !== null && !urlUUID(patch.agentId)) {
        return apiError("Invalid host id", "invalid_request");
      }
      if (patch.agentId !== null && !(await agentExists(patch.agentId))) {
        return apiError("Host not found", "invalid_request", 404);
      }
      agentId = patch.agentId;
    }

    await db`UPDATE endpoint_monitors SET
        agent_id=${agentId},
        service_name=${patch.serviceName !== undefined ? patch.serviceName : existing.service_name},
        name=${patch.name ?? existing.name},
        target_url=${targetUrl},
        expected_status=${patch.expectedStatus ?? existing.expected_status},
        enabled=${patch.enabled ?? existing.enabled},
        check_interval_seconds=${patch.checkIntervalSeconds ?? existing.check_interval_seconds}
      WHERE id=${id}`;
    const row = await selectEndpoint(id);
    if (!row) return apiError("Endpoint not found", "not_found", 404);
    // Audit records changed field names and non-secret values only; never the target URL.
    await audit("endpoint.updated", id, {
      changed: Object.keys(patch),
      name: row.name,
      serviceName: row.service_name,
      agentId: row.agent_id,
      expectedStatus: row.expected_status,
      checkIntervalSeconds: row.check_interval_seconds,
      enabled: row.enabled,
    });
    return j({ endpoint: endpointDto(row) });
  }

  const runsMatch = path.match(/^\/api\/endpoints\/([^/]+)\/runs$/);
  if (runsMatch && method === "GET") {
    const id = runsMatch[1];
    if (!urlUUID(id)) return apiError("Invalid endpoint id", "invalid_request");
    const [existing] = await db<{ id: string }[]>`SELECT id FROM endpoint_monitors WHERE id=${id}`;
    if (!existing) return apiError("Endpoint not found", "not_found", 404);
    const runs = await db<EndpointRunRow[]>`SELECT id,monitor_id,probe_location,status,http_status,latency_ms,error,started_at,finished_at,created_at
      FROM endpoint_monitor_runs WHERE monitor_id=${id}
      ORDER BY started_at DESC,id DESC LIMIT ${ENDPOINT_RUNS_LIMIT}`;
    const payload: EndpointRunsPayload = { runs: runs.map(runDto), limit: ENDPOINT_RUNS_LIMIT };
    return j(payload);
  }

  const checkMatch = path.match(/^\/api\/endpoints\/([^/]+)\/check$/);
  if (checkMatch && method === "POST") {
    const forbidden = aiOrigin(req);
    if (forbidden) return forbidden;
    if (!urlUUID(checkMatch[1])) {
      return apiError("Invalid endpoint id", "invalid_request");
    }
    const [existing] = await db<{ id: string; target_url: string; expected_status: number; probe_location: string }[]>`
      SELECT id,target_url,expected_status,probe_location FROM endpoint_monitors WHERE id=${checkMatch[1]}`;
    if (!existing) {
      return apiError("Endpoint not found", "not_found", 404);
    }
    const startedAt = new Date();
    const result = await probeEndpointTarget(existing.target_url, existing.expected_status);
    const finishedAt = new Date();
    await db.begin(async (tx) => {
      await recordProbeRun(tx, existing.id, existing.probe_location, result, startedAt, finishedAt);
      await audit("endpoint.probe", existing.id, {
        manual: true,
        status: result.status,
        httpStatus: result.httpStatus,
        error: result.error,
      }, tx);
    });
    const row = await selectEndpoint(existing.id);
    if (!row) return apiError("Endpoint not found", "not_found", 404);
    return j({ endpoint: endpointDto(row) });
  }

  return null;
}
