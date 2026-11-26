import type {
  AlertCondition,
  DiagnosticTool,
  Host,
  HostList,
  HostMetric,
  HostThresholds,
  InvestigationMemoryAttribution,
  ProviderProtocol,
} from "@opspilot/contracts";
import { parseEnrollRequest, parseInvestigateRequest, parseMergeMemoryRequest, parseThresholdsUpdate } from "@opspilot/contracts";
import { decryptProviderKey, ProviderCredentialError, readProviderMasterKey } from "@opspilot/ai/credentials";
import { scoreEvidenceRelevance } from "@opspilot/ai/evidence-scoring";
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
import { createIncident, effectiveThresholds, hostThresholds } from "./incidents";
import { listCanonicalMemories, MemoryMergeError, mergeMemories, recordResolvedIncidentMemory } from "./memory-dedup";
import { isDevLoopbackInstallEnabled, loadHttpsAgentInstaller, readAgentInstallConfig } from "./agent-install";
import { aiOrigin, apiError, body, HttpError, invalid, j, jsonBody, urlUUID } from "./http";
import { providerRoutes } from "./providers";
import { serviceRoutes } from "./services";

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

/**
 * Deterministic deduplication key for active investigations: at most one queued/running
 * investigation per (incident, provider, revision, model). Terminal rows never collide
 * because the partial unique index only covers queued/running rows.
 */
function investigationDedupeKey(incidentId: string, providerId: string, providerRevision: number, model: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${incidentId}\n${providerId}\n${providerRevision}\n${model}`)
    .digest("hex");
}

/** PostgreSQL unique violation (SQLSTATE 23505) on the active-dedupe index. */
function isDedupeViolation(error: unknown): boolean {
  const pg = error as { errno?: unknown; constraint?: unknown } | null;
  return !!pg && (pg.errno === 23505 || pg.errno === "23505" || pg.constraint === "idx_investigations_dedupe_active");
}

/** Normalizes `investigations.retrieved_memories_json` (jsonb may arrive as a JSON string). */
function parseRetrievedMemories(value: InvestigationMemoryAttribution[] | string | null): InvestigationMemoryAttribution[] | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as InvestigationMemoryAttribution[]) : null;
    } catch {
      return null;
    }
  }
  return Array.isArray(value) ? value : null;
}

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
    return installConfig ? j(installConfig) : invalid("Agent installation is not configured", 503);
  }

  if (path === "/api/hosts" && method === "GET") {
    const limit = 100;
    const [fleet, rows] = await Promise.all([
      db<{ id: string }[]>`SELECT id FROM agents`,
      db<HostRow[]>`SELECT a.id,a.hostname,a.version,a.protocol_version,a.capabilities,a.last_seen_at,a.created_at, m.cpu_percent,m.memory_percent,m.disk_percent, m.sampled_at
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
    const params = new URL(req.url).searchParams;
    const resolutionParam = params.get("resolution") ?? "auto";
    if (!["auto", "raw", "hourly"].includes(resolutionParam)) {
      return invalid("resolution must be auto, raw or hourly");
    }
    let limit = 120;
    const limitParam = params.get("limit");
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2000) {
        return invalid("limit must be an integer between 1 and 2000");
      }
      limit = parsed;
    }
    const fromParam = params.get("from");
    const toParam = params.get("to");
    let from: Date | null = null;
    let to: Date | null = null;
    if (fromParam !== null || toParam !== null) {
      const fromMs = fromParam === null ? NaN : Date.parse(fromParam);
      const toMs = toParam === null ? NaN : Date.parse(toParam);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
        return invalid("from and to must be ISO timestamps with from before to");
      }
      if (toMs - fromMs > 366 * 86_400_000) {
        return invalid("range too large (max 366 days)");
      }
      from = new Date(fromMs);
      to = new Date(toMs);
    }
    // auto uses hourly rollups once the requested span leaves the raw retention window.
    const rawRetentionHours = (() => {
      const value = Number(process.env.METRIC_RAW_RETENTION_HOURS || 168);
      return Number.isFinite(value) && value >= 1 && value <= 8760 ? value : 168;
    })();
    const resolution =
      resolutionParam === "auto"
        ? from && to && to.getTime() - from.getTime() > rawRetentionHours * 3_600_000
          ? "hourly"
          : "raw"
        : resolutionParam;

    let rows: HostMetricRow[];
    if (resolution === "hourly" && from && to) {
      rows =
        await db<HostMetricRow[]>`SELECT hour AS sampled_at,
          cpu_avg AS cpu_percent, memory_avg AS memory_percent, disk_avg AS disk_percent,
          network_rx_bytes::double precision AS network_rx_bytes, network_tx_bytes::double precision AS network_tx_bytes
          FROM metric_samples_hourly
          WHERE agent_id=${match[1]} AND hour >= date_trunc('hour', ${from}::timestamptz) AND hour < ${to}::timestamptz
          ORDER BY hour DESC LIMIT ${limit}`;
    } else if (resolution === "hourly") {
      rows =
        await db<HostMetricRow[]>`SELECT hour AS sampled_at,
          cpu_avg AS cpu_percent, memory_avg AS memory_percent, disk_avg AS disk_percent,
          network_rx_bytes::double precision AS network_rx_bytes, network_tx_bytes::double precision AS network_tx_bytes
          FROM metric_samples_hourly
          WHERE agent_id=${match[1]}
          ORDER BY hour DESC LIMIT ${limit}`;
    } else if (from && to) {
      rows =
        await db<HostMetricRow[]>`SELECT sampled_at,cpu_percent,memory_percent,disk_percent,network_rx_bytes::double precision AS network_rx_bytes,network_tx_bytes::double precision AS network_tx_bytes
          FROM metric_samples WHERE agent_id=${match[1]} AND sampled_at >= ${from}::timestamptz AND sampled_at < ${to}::timestamptz
          ORDER BY sampled_at DESC LIMIT ${limit}`;
    } else {
      rows =
        await db<HostMetricRow[]>`SELECT sampled_at,cpu_percent,memory_percent,disk_percent,network_rx_bytes::double precision AS network_rx_bytes,network_tx_bytes::double precision AS network_tx_bytes FROM metric_samples WHERE agent_id=${match[1]} ORDER BY sampled_at DESC LIMIT ${limit}`;
    }
    const metrics: HostMetric[] = rows.map((row) => ({
      ...row,
      sampled_at: row.sampled_at.toISOString(),
    }));
    return j(metrics);
  }

  match = path.match(/^\/api\/hosts\/([^/]+)\/thresholds$/);
  if (match) {
    const hostId = match[1];
    if (!urlUUID(hostId)) {
      return invalid("Invalid host id");
    }
    const host =
      await db<{ id: string }[]>`SELECT id FROM agents WHERE id=${hostId}`;
    if (!host.length) {
      return invalid("Host not found", 404);
    }

    if (method === "GET") {
      const thresholds = await effectiveThresholds(hostId);
      const conditions =
        await db<(Omit<AlertCondition, "cooldown_until" | "updated_at"> & {
          cooldown_until: Date | null;
          updated_at: Date;
        })[]>`SELECT agent_id,metric,state,consecutive,cooldown_until,incident_id,updated_at FROM alert_conditions WHERE agent_id=${hostId} ORDER BY metric`;
      const payload: { thresholds: HostThresholds; conditions: AlertCondition[] } = {
        thresholds,
        conditions: conditions.map((row) => ({
          ...row,
          cooldown_until: row.cooldown_until?.toISOString() ?? null,
          updated_at: row.updated_at.toISOString(),
        })),
      };
      return j(payload);
    }

    if (method === "PUT") {
      const data = await jsonBody(req);
      const update = parseThresholdsUpdate(data);
      if (!update) {
        return apiError("Thresholds must be null or finite numbers in 0-100", "invalid_request");
      }
      const thresholds = await effectiveThresholds(hostId);
      const next: HostThresholds = {
        cpu_percent: "cpu_percent" in update ? update.cpu_percent! : thresholds.cpu_percent,
        memory_percent: "memory_percent" in update ? update.memory_percent! : thresholds.memory_percent,
        disk_percent: "disk_percent" in update ? update.disk_percent! : thresholds.disk_percent,
      };
      await db`INSERT INTO alert_thresholds(agent_id,cpu_percent,memory_percent,disk_percent,updated_at)
        VALUES(${hostId},${next.cpu_percent},${next.memory_percent},${next.disk_percent},NOW())
        ON CONFLICT (agent_id) DO UPDATE SET
          cpu_percent=excluded.cpu_percent,memory_percent=excluded.memory_percent,
          disk_percent=excluded.disk_percent,updated_at=NOW()`;
      await db`UPDATE alert_conditions SET state='ok',consecutive=0,cooldown_until=NULL,incident_id=NULL,updated_at=NOW() WHERE agent_id=${hostId}`;
      await audit("thresholds.updated", hostId, { thresholds: next });
      return j({ thresholds: next });
    }

    if (method === "DELETE") {
      await db`DELETE FROM alert_thresholds WHERE agent_id=${hostId}`;
      await db`UPDATE alert_conditions SET state='ok',consecutive=0,cooldown_until=NULL,incident_id=NULL,updated_at=NOW() WHERE agent_id=${hostId}`;
      await audit("thresholds.reset", hostId);
      return j({ thresholds: await effectiveThresholds(hostId) });
    }

    return invalid("Method not allowed", 405);
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
    const evidence = await db<{ id: string; source: string; content: string; created_at: Date }[]>`SELECT id,source,content,created_at FROM evidence WHERE incident_id=${match[1]} ORDER BY created_at DESC LIMIT 50`;
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
      attempts: number;
      max_attempts: number;
      next_retry_at: Date | null;
      lease_expires_at: Date | null;
      input_tokens: number | null;
      output_tokens: number | null;
      thinking_tokens: number | null;
      total_tokens: number | null;
      estimated_cost_usd: string | null;
      retrieved_memories_json: InvestigationMemoryAttribution[] | string | null;
      created_at: Date;
      completed_at: Date | null;
    }[]>`SELECT id,provider_id,provider_name,provider_protocol,provider_base_url,provider_model,status,result_json,error,attempts,max_attempts,next_retry_at,lease_expires_at,input_tokens,output_tokens,thinking_tokens,total_tokens,estimated_cost_usd,retrieved_memories_json,created_at,completed_at
      FROM investigations WHERE incident_id=${match[1]} ORDER BY created_at DESC LIMIT 10`;

    // Cited IDs come from the latest completed investigation's diagnosis, when present.
    const citedIds: string[] = rows
      .filter((row) => row.status === "completed")
      .map((row) => (row.result_json as { evidence_ids?: unknown } | null)?.evidence_ids)
      .filter((ids): ids is string[] => Array.isArray(ids) && ids.every((id) => typeof id === "string"))
      .at(0) ?? [];
    const scored = scoreEvidenceRelevance(
      { title: incident[0].title, category: incident[0].category },
      evidence.map((item) => ({ ...item, created_at: item.created_at.toISOString() })),
      citedIds,
    );

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
      attempts: row.attempts,
      max_attempts: row.max_attempts,
      next_retry_at: row.next_retry_at,
      lease_expires_at: row.lease_expires_at,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      thinking_tokens: row.thinking_tokens,
      total_tokens: row.total_tokens,
      estimated_cost_usd: row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd),
      // Bounded snapshot of which prior memories this investigation retrieved (null for legacy/active rows).
      retrieved_memories: parseRetrievedMemories(row.retrieved_memories_json),
      created_at: row.created_at,
      completed_at: row.completed_at,
    }));
    // Backwards-compatible: evidence items keep all existing fields, with relevance added.
    return j({
      incident: incident[0],
      evidence: scored,
      investigations,
    });
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
    // Deduplicate active investigations before dispatching any agent diagnostics:
    // same incident + provider + revision + model already queued/running returns that row.
    const dedupeKey = investigationDedupeKey(id, data.providerId, data.providerRevision, data.model);
    const [active] = await db<{ id: string; status: string }[]>`SELECT id,status FROM investigations
      WHERE dedupe_key=${dedupeKey} AND status IN ('queued','running')
      ORDER BY created_at DESC,id DESC LIMIT 1`;
    if (active) {
      return j({ id: active.id, status: active.status, deduplicated: true, liveAgent: agentOnline(agentId) }, 202);
    }
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
    try {
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
          incident_id,provider_id,provider_revision,provider_name,provider_protocol,provider_base_url,provider_model,dedupe_key
        ) VALUES(${id},${provider.id},${provider.revision},${provider.name},${provider.protocol},${provider.base_url},${data.model},${dedupeKey}) RETURNING id`;
        await audit("investigation.queued", queued.id, {
          incidentId: id,
          providerId: provider.id,
          revision: provider.revision,
          protocol: provider.protocol,
        }, tx);
        return j({ id: queued.id, status: "queued", deduplicated: false, liveAgent: agentOnline(agentId) }, 202);
      });
    } catch (error: unknown) {
      // A concurrent identical request won the insert: the partial unique index on
      // dedupe_key (active rows only) is the atomic arbiter. Return the existing row.
      if (isDedupeViolation(error)) {
        const [existing] = await db<{ id: string; status: string }[]>`SELECT id,status FROM investigations
          WHERE dedupe_key=${dedupeKey} AND status IN ('queued','running')
          ORDER BY created_at DESC,id DESC LIMIT 1`;
        if (existing) {
          return j({ id: existing.id, status: existing.status, deduplicated: true, liveAgent: agentOnline(agentId) }, 202);
        }
      }
      throw error;
    }
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
    // Resolve + memory dedup in one transaction: a repeat root cause merges into the
    // existing canonical memory (occurrence_count grows) with full source provenance.
    const result = await db.begin(async (tx) => {
      const incident = await tx<{ id: string; title: string; agent_id: string; category: string; resolved_at: Date }[]>`
        UPDATE incidents SET status='resolved',resolution=${resolution},resolved_at=NOW()
        WHERE id=${match[1]} AND status='open'
        RETURNING id,title,agent_id,category,resolved_at`;
      if (!incident.length) return null;
      await audit("incident.resolved", match[1], {}, tx);
      return await recordResolvedIncidentMemory(tx, incident[0], resolution);
    });
    if (!result) {
      return invalid("Not found or already resolved", 404);
    }
    return j({ ok: true, memoryId: result.memoryId, deduplicated: result.deduplicated, occurrenceCount: result.occurrenceCount });
  }

  if (path === "/api/memory" && method === "GET") {
    const q = new URL(req.url).searchParams.get("q")?.slice(0, 100) || "";
    return j(await listCanonicalMemories(db, q, 20));
  }

  if (path === "/api/memory/merge" && method === "POST") {
    const data = await jsonBody(req);
    const parsed = parseMergeMemoryRequest(data);
    if (!parsed) {
      return apiError("sourceMemoryId and targetMemoryId must be distinct UUIDs", "invalid_request");
    }
    try {
      const memory = await mergeMemories(db, parsed.sourceMemoryId, parsed.targetMemoryId);
      return j({ ok: true, memory });
    } catch (error) {
      if (error instanceof MemoryMergeError) {
        return apiError(error.message, error.code, error.status);
      }
      throw error;
    }
  }

  return invalid("Not found", 404);
}

const server = Bun.serve<SocketData>({
  port,
  hostname: isDevLoopbackInstallEnabled(process.env) ? "127.0.0.1" : "0.0.0.0",
  maxRequestBodySize: 64 * 1024,
  async fetch(req, server) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/agents/install.sh") {
        if (req.method !== "GET") {
          return j({ error: "Method not allowed" }, 405, { Allow: "GET" });
        }
        if (installConfig?.mode !== "https") return invalid("HTTPS agent installation is not configured", 503);
        const agentInstaller = await (httpsInstaller ?? loadHttpsAgentInstaller(installConfig));
        if (!agentInstaller) return invalid("Agent installer is unavailable", 500);
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
        const enrollment = parseEnrollRequest(data);
        if (!enrollment) {
          return invalid("Bad enrollment request");
        }
        const result = await enrollAgent(
          enrollment.token,
          enrollment.hostname,
          enrollment.version,
          enrollment.protocolVersion,
          enrollment.capabilities,
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
        if (server.upgrade(req, { data: { agentId, sessionId: crypto.randomUUID() } })) {
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

const installConfig = readAgentInstallConfig(process.env, server.port);
const httpsInstaller =
  installConfig?.mode === "https" && process.env.NODE_ENV === "production"
    ? loadHttpsAgentInstaller(installConfig)
    : null;

console.log(`OpsPilot Hub listening on http://localhost:${server.port}`);
