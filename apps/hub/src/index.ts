import type {
  DiagnosticTool,
  Host,
  HostList,
  HostMetric,
  ProviderProtocol,
} from "@opspilot/contracts";
import { parseInvestigateRequest } from "@opspilot/contracts";
import { decryptProviderKey, ProviderCredentialError, readProviderMasterKey } from "@opspilot/ai/credentials";
import {
  agentOnline,
  authenticateAgent,
  createEnrollmentToken,
  enrollAgent,
  requestDiagnostics,
  socketClosed,
  socketMessage,
  socketOpened,
  type SocketData,
} from "./agents";
import {
  checkPassword,
  createSession,
  isAuthDisabled,
  isAuthed,
  logoutCookie,
  sessionCookie,
} from "./auth";
import { audit, db } from "./db";
import { createIncident, hostThresholds } from "./incidents";
import { readAgentInstallConfig } from "./agent-install";
import { aiOrigin, apiError, body, HttpError, invalid, j, jsonBody, urlUUID } from "./http";
import { providerRoutes } from "./providers";
import { serviceRoutes } from "./services";

const agentInstallerUrl = new URL("../../../infra/install/agent.sh", import.meta.url);

const port = Number(process.env.PORT || 3001);
if (process.env.NODE_ENV === "production" && !process.env.ADMIN_PASSWORD_HASH) {
  throw new Error("ADMIN_PASSWORD_HASH required in production");
}
if (isAuthDisabled()) {
  console.warn("WARNING: Admin login is disabled (DISABLE_AUTH=true, non-production only)");
}


type HostRow = Omit<
  Host,
  "status" | "last_seen_at" | "created_at" | "sampled_at"
> & {
  last_seen_at: Date | null;
  created_at: Date;
  sampled_at: Date | null;
};

type HostMetricRow = Omit<HostMetric, "sampled_at"> & { sampled_at: Date };

async function router(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  const method = req.method.toUpperCase();

  if (path === "/healthz") {
    try {
      await db`SELECT 1`;
      return j({ ok: true, db: true });
    } catch {
      return j({ ok: false, db: false }, 503);
    }
  }

  if (method === "POST" || method === "PATCH" || method === "DELETE") {
    const origin = req.headers.get("origin");
    if (
      origin &&
      origin !== (process.env.ALLOWED_ORIGIN || "http://localhost:3000")
    ) {
      return apiError("Forbidden origin", "forbidden_origin", 403);
    }
  }

  if (path === "/api/auth/login" && method === "POST") {
    if (isAuthDisabled()) {
      return j({ ok: true, authDisabled: true });
    }
    const data = await body(req);
    const password = String(data.password || "");
    if (password.length > 256) {
      return invalid("Invalid credentials", 401);
    }
    if (!(await checkPassword(password))) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return invalid("Invalid credentials", 401);
    }
    await audit("admin.login", null);
    return j({ ok: true }, 200, { "Set-Cookie": sessionCookie(createSession()) });
  }

  if (!isAuthed(req)) {
    return invalid("Unauthorized", 401);
  }
  const providerResponse = await providerRoutes(req, path, method);
  if (providerResponse) return providerResponse;
  const serviceResponse = await serviceRoutes(req, path, method);
  if (serviceResponse) return serviceResponse;


  if (path === "/api/auth/me" && method === "GET") {
    return j({ authenticated: true, role: "admin", authDisabled: isAuthDisabled() });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    return j({ ok: true }, 200, isAuthDisabled() ? {} : { "Set-Cookie": logoutCookie() });
  }


  if (path === "/api/agents/enrollment-token" && method === "POST") {
    return j(await createEnrollmentToken(), 201);
  }

  if (path === "/api/agents/install-config" && method === "GET") {
    const config = readAgentInstallConfig(process.env);
    return config ? j(config) : invalid("Agent installation is not configured", 503);
  }

  if (path === "/api/hosts" && method === "GET") {
    const limit = 100;
    const [fleet, rows] = await Promise.all([
      db<{ id: string }[]>`SELECT id FROM agents`,
      db<HostRow[]>`SELECT a.id,a.hostname,a.version,a.last_seen_at,a.created_at, m.cpu_percent,m.memory_percent,m.disk_percent, m.sampled_at
        FROM agents a LEFT JOIN LATERAL (SELECT cpu_percent,memory_percent,disk_percent,sampled_at FROM metric_samples WHERE agent_id=a.id ORDER BY sampled_at DESC LIMIT 1) m ON true ORDER BY a.created_at DESC,a.id LIMIT ${limit}`,
    ]);
    const hosts: Host[] = rows.map((row) => ({
      ...row,
      status: agentOnline(row.id) ? "online" : "offline",
      last_seen_at: row.last_seen_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
      sampled_at: row.sampled_at?.toISOString() ?? null,
    }));
    const result: HostList = {
      hosts,
      total: fleet.length,
      online: fleet.reduce(
        (count, host) => count + Number(agentOnline(host.id)),
        0,
      ),
      limit,
      observed_at: new Date().toISOString(),
      stale_after_seconds: 60,
      thresholds: hostThresholds(),
    };
    return j(result);
  }

  let match = path.match(/^\/api\/hosts\/([^/]+)\/metrics$/);
  if (match && method === "GET") {
    if (!urlUUID(match[1])) {
      return invalid("Invalid host id");
    }
    const host =
      await db<{ id: string }[]>`SELECT id FROM agents WHERE id=${match[1]}`;
    if (!host.length) {
      return invalid("Host not found", 404);
    }
    const rows =
      await db<HostMetricRow[]>`SELECT sampled_at,cpu_percent,memory_percent,disk_percent,network_rx_bytes::double precision AS network_rx_bytes,network_tx_bytes::double precision AS network_tx_bytes FROM metric_samples WHERE agent_id=${match[1]} ORDER BY sampled_at DESC LIMIT 120`;
    const metrics: HostMetric[] = rows.map((row) => ({
      ...row,
      sampled_at: row.sampled_at.toISOString(),
    }));
    return j(metrics);
  }

  if (path === "/api/incidents" && method === "GET") {
    return j(
      await db`SELECT i.*,a.hostname FROM incidents i JOIN agents a ON a.id=i.agent_id ORDER BY i.created_at DESC LIMIT 100`,
    );
  }

  if (path === "/api/incidents" && method === "POST") {
    const data = await body(req);
    if (
      !urlUUID(String(data.agentId || "")) ||
      typeof data.title !== "string" ||
      data.title.length < 3 ||
      data.title.length > 160
    ) {
      return invalid("agentId and title (3-160 chars) required");
    }
    const host = await db`SELECT id FROM agents WHERE id=${data.agentId}`;
    if (!host.length) {
      return invalid("Host not found", 404);
    }
    const id = await createIncident(
      data.agentId,
      "manual",
      data.title.trim(),
      "manual",
      "Created by administrator; investigate to collect live evidence.",
    );
    return j({ id }, 201);
  }

  match = path.match(/^\/api\/incidents\/([^/]+)$/);
  if (match && method === "GET") {
    if (!urlUUID(match[1])) {
      return invalid("Invalid incident id");
    }
    const incident =
      await db`SELECT i.*,a.hostname FROM incidents i JOIN agents a ON a.id=i.agent_id WHERE i.id=${match[1]}`;
    if (!incident.length) {
      return invalid("Not found", 404);
    }
    const evidence =
      await db`SELECT id,source,content,created_at FROM evidence WHERE incident_id=${match[1]} ORDER BY created_at DESC LIMIT 50`;
    const rows = await db<{
      id: string;
      provider_id: string | null;
      provider_name: string;
      provider_protocol: ProviderProtocol;
      provider_base_url: string | null;
      provider_model: string | null;
      status: string;
      result_json: unknown;
      error: string | null;
      created_at: Date;
      completed_at: Date | null;
    }[]>`SELECT id,provider_id,provider_name,provider_protocol,provider_base_url,provider_model,status,result_json,error,created_at,completed_at
      FROM investigations WHERE incident_id=${match[1]} ORDER BY created_at DESC LIMIT 10`;
    const investigations = rows.map((row) => ({
      id: row.id,
      provider: {
        id: row.provider_id,
        name: row.provider_name,
        protocol: row.provider_protocol,
        baseUrl: row.provider_base_url,
        model: row.provider_model,
      },
      status: row.status,
      result_json: row.result_json,
      error: row.error,
      created_at: row.created_at,
      completed_at: row.completed_at,
    }));
    return j({ incident: incident[0], evidence, investigations });
  }

  match = path.match(/^\/api\/incidents\/([^/]+)\/investigate$/);
  if (match && method === "POST") {
    const forbidden = aiOrigin(req);
    if (forbidden) return forbidden;
    if (!urlUUID(match[1])) return apiError("Invalid incident id", "invalid_request");
    const data = parseInvestigateRequest(await jsonBody(req));
    if (!data) return apiError("Invalid investigation request", "invalid_request");
    const masterKey = readProviderMasterKey(process.env);
    if (!masterKey) return apiError("Provider credentials unavailable", "credential_unavailable", 503);
    const providerCheck = await db.begin(async (tx) => {
      const [provider] = await tx<{
        id: string;
        enabled: boolean;
        revision: number;
        api_key_ciphertext: string;
      }[]>`SELECT id,enabled,revision,api_key_ciphertext FROM ai_providers WHERE id=${data.providerId} FOR UPDATE`;
      if (!provider) return apiError("Provider unavailable", "provider_unavailable", 404);
      if (!provider.enabled) return apiError("Provider is disabled", "provider_disabled", 409);
      if (provider.revision !== data.providerRevision) return apiError("Provider configuration changed; review the latest configuration", "provider_changed", 409);
      try {
        decryptProviderKey(provider.id, provider.api_key_ciphertext, masterKey);
      } catch (error) {
        if (error instanceof ProviderCredentialError) return apiError("Provider credentials unavailable", "credential_unavailable", 503);
        throw error;
      }
      return null;
    });
    if (providerCheck) return providerCheck;
    const rows = await db<{ agent_id: string; category: string; status: string }[]>`
      SELECT agent_id,category,status FROM incidents WHERE id=${match[1]}`;
    if (!rows.length) return apiError("Incident not found", "invalid_request", 404);
    if (rows[0].status !== "open") return apiError("Incident is resolved", "invalid_request", 409);
    const id = match[1];
    const agentId = rows[0].agent_id;
    const tools: Array<[DiagnosticTool, string?]> =
      rows[0].category === "disk"
        ? [["disk_usage"]]
        : [
            ["disk_usage"],
            ["listening_ports"],
            ["service_status", "nginx"],
            ["docker_status"],
          ];
    if (agentOnline(agentId)) {
      await Promise.allSettled(
        tools.map(([tool, service]) =>
          requestDiagnostics(agentId, id, tool, service),
        ),
      );
    }
    return await db.begin(async (tx) => {
      const [provider] = await tx<{
        id: string;
        enabled: boolean;
        revision: number;
        name: string;
        protocol: ProviderProtocol;
        base_url: string;
      }[]>`SELECT id,enabled,revision,name,protocol,base_url FROM ai_providers WHERE id=${data.providerId} FOR UPDATE`;
      if (!provider || provider.revision !== data.providerRevision) {
        return apiError("Provider configuration changed; review the latest configuration", "provider_changed", 409);
      }
      if (!provider.enabled) return apiError("Provider is disabled", "provider_disabled", 409);
      const [incident] = await tx<{ status: string }[]>`SELECT status FROM incidents WHERE id=${id} FOR UPDATE`;
      if (!incident) return apiError("Incident not found", "invalid_request", 404);
      if (incident.status !== "open") return apiError("Incident is resolved", "invalid_request", 409);
      const [queued] = await tx<{ id: string }[]>`INSERT INTO investigations(
        incident_id,provider_id,provider_revision,provider_name,provider_protocol,provider_base_url,provider_model
      ) VALUES(${id},${provider.id},${provider.revision},${provider.name},${provider.protocol},${provider.base_url},${data.model}) RETURNING id`;
      await audit("investigation.queued", queued.id, {
        incidentId: id,
        providerId: provider.id,
        revision: provider.revision,
        protocol: provider.protocol,
      }, tx);
      return j({ id: queued.id, status: "queued", liveAgent: agentOnline(agentId) }, 202);
    });
  }

  match = path.match(/^\/api\/incidents\/([^/]+)\/resolve$/);
  if (match && method === "POST") {
    if (!urlUUID(match[1])) {
      return invalid("Invalid incident id");
    }
    const data = await body(req);
    const resolution = String(data.resolution || "").trim();
    if (resolution.length < 8 || resolution.length > 3000) {
      return invalid("Resolution must be 8-3000 characters");
    }
    const incident =
      await db`UPDATE incidents SET status='resolved',resolution=${resolution},resolved_at=NOW() WHERE id=${match[1]} AND status='open' RETURNING id,title`;
    if (!incident.length) {
      return invalid("Not found or already resolved", 404);
    }
    await db`INSERT INTO incident_memory(incident_id,summary,resolution) VALUES(${match[1]},${incident[0].title},${resolution}) ON CONFLICT(incident_id) DO UPDATE SET resolution=excluded.resolution`;
    await audit("incident.resolved", match[1]);
    return j({ ok: true });
  }

  if (path === "/api/memory" && method === "GET") {
    const q = new URL(req.url).searchParams.get("q")?.slice(0, 100) || "";
    if (q) {
      return j(
        await db`SELECT id,incident_id,summary,resolution,created_at FROM incident_memory WHERE to_tsvector('simple',summary || ' ' || resolution) @@ plainto_tsquery('simple',${q}) ORDER BY created_at DESC LIMIT 20`,
      );
    }
    return j(
      await db`SELECT id,incident_id,summary,resolution,created_at FROM incident_memory ORDER BY created_at DESC LIMIT 20`,
    );
  }

  return invalid("Not found", 404);
}

const server = Bun.serve<SocketData>({
  port,
  hostname: "0.0.0.0",
  maxRequestBodySize: 64 * 1024,
  async fetch(req, server) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/agents/install.sh") {
        if (req.method !== "GET") {
          return j({ error: "Method not allowed" }, 405, { Allow: "GET" });
        }
        const agentInstaller = Bun.file(agentInstallerUrl);
        if (!(await agentInstaller.exists()) || agentInstaller.size === 0) {
          return invalid("Agent installer is unavailable", 500);
        }
        return new Response(agentInstaller, {
          headers: {
            "Content-Type": "text/x-shellscript; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (url.pathname === "/api/agents/enroll" && req.method === "POST") {
        const origin = req.headers.get("origin");
        if (origin) {
          return invalid("Agent requests must not have browser origin", 403);
        }
        const data = await body(req);
        if (
          typeof data.token !== "string" ||
          typeof data.hostname !== "string" ||
          data.hostname.length > 100 ||
          !data.hostname.length
        ) {
          return invalid("Bad enrollment request");
        }
        const result = await enrollAgent(
          data.token,
          data.hostname,
          String(data.version || "dev"),
        );
        return result ? j(result, 201) : invalid("Invalid/expired token", 401);
      }

      if (url.pathname === "/api/agents/connect") {
        const origin = req.headers.get("origin");
        if (origin) {
          return invalid("Browser WebSocket not allowed", 403);
        }
        const agentId = await authenticateAgent(req);
        if (!agentId) {
          return invalid("Invalid agent identity", 401);
        }
        if (server.upgrade(req, { data: { agentId } })) {
          return;
        }
        return invalid("Upgrade failed", 400);
      }

      return await router(req);
    } catch (error: unknown) {
      const aiRequest = url.pathname.startsWith("/api/ai/providers") || /^\/api\/incidents\/[^/]+\/investigate$/.test(url.pathname);
      if (error instanceof HttpError) return apiError(error.message, "invalid_request", error.status);
      if (error instanceof SyntaxError) {
        return aiRequest ? apiError("Invalid JSON body", "invalid_request") : invalid("Invalid JSON body", 400);
      }
      if (error instanceof Error && error.message === "Body too large") {
        return aiRequest ? apiError("Body too large", "invalid_request", 413) : invalid("Body too large", 413);
      }
      console.error("Request failed");
      return aiRequest ? apiError("Internal error", "provider_unavailable", 500) : invalid("Internal error", 500);
    }
  },
  websocket: {
    maxPayloadLength: 64 * 1024,
    open(ws) {
      socketOpened(ws);
    },
    message(ws, msg) {
      void socketMessage(ws, msg).catch((e) =>
        console.error("WS message failed", e),
      );
    },
    close(ws) {
      socketClosed(ws);
    },
  },
});

console.log(`OpsPilot Hub listening on http://localhost:${server.port}`);
