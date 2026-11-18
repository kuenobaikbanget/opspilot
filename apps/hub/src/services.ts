import { probeEndpointTarget } from "@opspilot/ai/endpoint-probe";
import {
  validateEndpointTargetUrl,
  type EndpointMonitor,
  type HostService,
  type ServicesPayload,
} from "@opspilot/contracts";
import { audit, db } from "./db";
import { aiOrigin, apiError, j, jsonBody, urlUUID } from "./http";

type HostServiceRow = Omit<HostService, "observed_at"> & { observed_at: Date };
type EndpointMonitorRow = Omit<EndpointMonitor, "last_checked_at"> & {
  last_checked_at: Date | null;
};

function serviceDto(row: HostServiceRow): HostService {
  return { ...row, observed_at: row.observed_at.toISOString() };
}

function endpointDto(row: EndpointMonitorRow): EndpointMonitor {
  return {
    ...row,
    last_checked_at: row.last_checked_at?.toISOString() ?? null,
  };
}

/** Serves bounded service inventory and endpoint check routes behind the admin auth guard. */
export async function serviceRoutes(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  if (path === "/api/services" && method === "GET") {
    const [services, endpoints] = await Promise.all([
      db<HostServiceRow[]>`SELECT id,agent_id,name,runtime,state,source,observed_at
        FROM host_services ORDER BY agent_id,name LIMIT 100`,
      db<EndpointMonitorRow[]>`SELECT id,agent_id,service_name,name,target_url,expected_status,probe_location,
        last_status,last_http_status,last_latency_ms,last_error,last_checked_at
        FROM endpoint_monitors ORDER BY created_at DESC,id LIMIT 100`,
    ]);
    const payload: ServicesPayload = {
      services: services.map(serviceDto),
      endpoints: endpoints.map(endpointDto),
    };
    return j(payload);
  }

  if (path === "/api/endpoints" && method === "POST") {
    const forbidden = aiOrigin(req);
    if (forbidden) return forbidden;
    const data = await jsonBody(req);
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const rawUrl = typeof data.targetUrl === "string" ? data.targetUrl.trim() : "";
    const expectedStatus =
      data.expectedStatus === undefined ? 200 : Number(data.expectedStatus);
    const agentId =
      data.agentId === undefined || data.agentId === null || data.agentId === ""
        ? null
        : String(data.agentId);
    const serviceName =
      typeof data.serviceName === "string" && data.serviceName.trim()
        ? data.serviceName.trim().slice(0, 80)
        : null;

    if (!name || name.length > 80) {
      return apiError("Endpoint name (1-80 chars) required", "invalid_request");
    }
    if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
      return apiError("Invalid expected HTTP status", "invalid_request");
    }
    if (agentId !== null && !urlUUID(agentId)) {
      return apiError("Invalid host id", "invalid_request");
    }
    const allowLoopbackMock =
      process.env.NODE_ENV !== "production" &&
      process.env.OPSPILOT_ALLOW_LOOPBACK_PROBES === "true";
    const targetUrl = validateEndpointTargetUrl(rawUrl, { allowLoopbackMock });
    if (!targetUrl) {
      return apiError("Target URL rejected by egress policy", "invalid_target");
    }

    if (agentId !== null) {
      const host = await db<{ id: string }[]>`SELECT id FROM agents WHERE id=${agentId}`;
      if (!host.length) {
        return apiError("Host not found", "invalid_request", 404);
      }
    }

    const [row] = await db<EndpointMonitorRow[]>`INSERT INTO endpoint_monitors(
        agent_id,service_name,name,target_url,expected_status,probe_location
      ) VALUES(${agentId},${serviceName},${name},${targetUrl},${expectedStatus},'hub-local')
      RETURNING id,agent_id,service_name,name,target_url,expected_status,probe_location,
        last_status,last_http_status,last_latency_ms,last_error,last_checked_at`;
    await audit("endpoint.created", row.id, { agentId, expectedStatus });
    return j({ endpoint: endpointDto(row) }, 201);
  }

  const checkMatch = path.match(/^\/api\/endpoints\/([^/]+)\/check$/);
  if (checkMatch && method === "POST") {
    const forbidden = aiOrigin(req);
    if (forbidden) return forbidden;
    if (!urlUUID(checkMatch[1])) {
      return apiError("Invalid endpoint id", "invalid_request");
    }
    const [existing] = await db<{ id: string; target_url: string; expected_status: number }[]>`
      SELECT id,target_url,expected_status FROM endpoint_monitors WHERE id=${checkMatch[1]}`;
    if (!existing) {
      return apiError("Endpoint not found", "not_found", 404);
    }
    const result = await probeEndpointTarget(existing.target_url, existing.expected_status);
    const [updated] = await db<EndpointMonitorRow[]>`UPDATE endpoint_monitors SET
        last_status=${result.status},
        last_http_status=${result.httpStatus},
        last_latency_ms=${result.latencyMs},
        last_error=${result.error},
        last_checked_at=NOW()
      WHERE id=${existing.id}
      RETURNING id,agent_id,service_name,name,target_url,expected_status,probe_location,
        last_status,last_http_status,last_latency_ms,last_error,last_checked_at`;
    return j({ endpoint: endpointDto(updated) });
  }

  return null;
}
