import type { ServerWebSocket } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  MAX_CONFIG_SNAPSHOT_BYTES,
  MAX_SYSTEMD_REPORT_BYTES,
  MAX_WS_MESSAGE_BYTES,
  MAX_WORKLOAD_INVENTORY_BYTES,
  PROTOCOL_VERSION,
  WS_CLOSE_AGENT_REVOKED,
  WS_CLOSE_CREDENTIAL_ROTATED,
  WS_CLOSE_SUPERSEDED,
  negotiateCapabilities,
  parseAgentHello,
  parseConfigSnapshot,
  parseSystemdReport,
  parseTelemetry,
  parseWorkloadInventory,
  type AgentCapability,
  type DiagnosticResult,
  type DiagnosticTool,
  type HelloAck,
} from "@opspilot/contracts";
import { db, hashSecret, audit } from "./db";
import { checkThresholds, checkConfigHashes, addEvidence } from "./incidents";
import { storeConfigSnapshot } from "./drift";
import { storeSystemdReport } from "./systemd";
import { storeWorkloadInventory } from "./workloads";

/** Per-connection metadata attached to authenticated agent WebSockets. */
export type SocketData = { agentId: string; sessionId: string };

type PendingDiagnostic = {
  agentId: string;
  incidentId: string;
  tool: string;
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

const connections = new Map<string, ServerWebSocket<SocketData>>();
const writingSystemdReports = new Set<string>();
const writingWorkloadReports = new Set<string>();
const writingConfigSnapshots = new Set<string>();
const pending = new Map<string, PendingDiagnostic>();

const secret = () => randomBytes(32).toString("base64url");

// Capability names come from a fixed allowlist, so a plain Postgres array literal is safe to bind.
const capsLiteral = (caps: readonly string[]) => `{${caps.join(",")}}`;

/** Consumes a single-use enrollment token and registers a new agent credential. */
export async function enrollAgent(
  token: string,
  hostname: string,
  version: string,
  protocolVersion = 1,
  capabilities: AgentCapability[] = [],
) {
  const hash = hashSecret(token);
  const claimed =
    await db`UPDATE enrollment_tokens SET used_at=NOW() WHERE token_hash=${hash} AND used_at IS NULL AND expires_at>NOW() RETURNING id`;
  if (!claimed.length) {
    return null;
  }

  const agentSecret = secret();
  const rows =
    await db`INSERT INTO agents(hostname,token_hash,version,protocol_version,capabilities)
      VALUES(${hostname.slice(0, 100)},${hashSecret(agentSecret)},${version.slice(0, 40)},${protocolVersion},${capsLiteral(capabilities)}::text[])
      RETURNING id`;
  await audit("agent.enrolled", rows[0].id, { hostname, protocolVersion, capabilities });
  return { agentId: rows[0].id as string, agentSecret };
}

/**
 * Authenticates an agent request using `x-opspilot-agent-id` and a Bearer secret.
 * Revoked agents (`revoked_at IS NOT NULL`) are always rejected; the stored
 * SHA-256 hash is compared in constant time after the row lookup.
 */
export async function authenticateAgent(req: Request): Promise<string | null> {
  const id = req.headers.get("x-opspilot-agent-id") || "";
  const bearer = req.headers.get("authorization") || "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    !bearer.startsWith("Bearer ")
  ) {
    return null;
  }

  const rows =
    await db<{ id: string; token_hash: string; revoked_at: Date | null }[]>`
      SELECT id,token_hash,revoked_at FROM agents WHERE id=${id}`;
  const row = rows[0];
  if (!row || row.revoked_at !== null) {
    return null;
  }
  const expected = Buffer.from(row.token_hash, "utf8");
  const actual = Buffer.from(hashSecret(bearer.slice(7)), "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  return row.id;
}

/** Immediately closes the active WebSocket for an agent, if any. */
export function closeAgentSocket(agentId: string, code: number, reason: string): boolean {
  const socket = connections.get(agentId);
  if (!socket) return false;
  try {
    socket.close(code, reason);
  } catch {
    // already closed
  }
  return true;
}

/**
 * Revokes an agent credential: marks it revoked, closes any active WebSocket and
 * audits the action. Revoked agents fail all future HTTP/WS auth attempts.
 * Returns false when the agent does not exist or was already revoked.
 */
export async function revokeAgent(agentId: string): Promise<boolean> {
  const rows =
    await db<{ id: string }[]>`UPDATE agents SET revoked_at=NOW() WHERE id=${agentId} AND revoked_at IS NULL RETURNING id`;
  if (!rows.length) return false;
  closeAgentSocket(agentId, WS_CLOSE_AGENT_REVOKED, "Agent revoked");
  await audit("agent.revoked", agentId, { at: new Date().toISOString() });
  return true;
}

/**
 * Rotates an agent credential (immediate swap): issues a new secret, updates
 * token_hash, records last_rotated_at, disconnects stale WebSocket sessions and
 * audits the rotation. The revoked flag is deliberately NOT cleared — a revoked
 * agent stays revoked until explicitly re-enrolled. Returns the new secret
 * exactly once, or null when the agent does not exist.
 */
export async function rotateAgentCredential(agentId: string): Promise<{ agentSecret: string } | null> {
  const agentSecret = secret();
  const rows =
    await db<{ id: string }[]>`UPDATE agents SET token_hash=${hashSecret(agentSecret)},last_rotated_at=NOW() WHERE id=${agentId} RETURNING id`;
  if (!rows.length) return null;
  closeAgentSocket(agentId, WS_CLOSE_CREDENTIAL_ROTATED, "Credential rotated; reconnect with the new secret");
  await audit("agent.rotated", agentId, { at: new Date().toISOString() });
  return { agentSecret };
}

/** Issues a single-use agent enrollment token expiring in 10 minutes. */
export async function createEnrollmentToken() {
  const token = secret();
  await db`INSERT INTO enrollment_tokens(token_hash,expires_at) VALUES(${hashSecret(token)}, NOW()+INTERVAL '10 minutes')`;
  await audit("enrollment.created", null);
  return { token, expiresInSeconds: 600 };
}

/** Registers an active agent WebSocket and marks the agent online. */
export function socketOpened(ws: ServerWebSocket<SocketData>) {
  const existing = connections.get(ws.data.agentId);
  if (existing && existing !== ws) {
    existing.close(WS_CLOSE_SUPERSEDED, "Superseded by new session");
  }
  connections.set(ws.data.agentId, ws);
  void db`UPDATE agents SET status='online',last_seen_at=NOW() WHERE id=${ws.data.agentId}`
    .execute()
    .catch(console.error);
}

/** Unregisters a closing agent WebSocket if it is still the active session. */
export function socketClosed(ws: ServerWebSocket<SocketData>) {
  if (connections.get(ws.data.agentId) === ws) {
    connections.delete(ws.data.agentId);
    void db`UPDATE agents SET status='offline' WHERE id=${ws.data.agentId}`
      .execute()
      .catch(console.error);
  }
}

/** Processes bounded telemetry, systemd status, workload inventory, and diagnostic results from an agent WebSocket. */
export async function socketMessage(
  ws: ServerWebSocket<SocketData>,
  message: string | Buffer,
) {
  const bytes = typeof message === "string" ? Buffer.byteLength(message) : message.length;
  if (bytes > MAX_WS_MESSAGE_BYTES) {
    ws.close(1009, "Message too large");
    return;
  }

  let msg: unknown;
  try {
    msg = JSON.parse(typeof message === "string" ? message : message.toString());
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;

  const agentId = ws.data.agentId;
  if (msg.type === "hello") {
    // Refuse agents speaking a newer wire protocol instead of silently misreading them.
    const advertised = "protocolVersion" in msg ? msg.protocolVersion : undefined;
    if (typeof advertised === "number" && Number.isSafeInteger(advertised) && advertised > PROTOCOL_VERSION) {
      ws.close(4000, "Unsupported protocol version");
      return;
    }
    const hello = parseAgentHello(msg);
    if (!hello || connections.get(agentId) !== ws) return;
    const negotiated = negotiateCapabilities(hello.capabilities);
    await db`UPDATE agents SET version=${hello.agentVersion},protocol_version=${hello.protocolVersion},capabilities=${capsLiteral(negotiated)}::text[],last_seen_at=NOW(),status='online' WHERE id=${agentId}`;
    const ack: HelloAck = { type: "hello_ack", protocolVersion: PROTOCOL_VERSION, capabilities: negotiated };
    ws.send(JSON.stringify(ack));
  } else if (msg.type === "systemd_status") {
    if (bytes > MAX_SYSTEMD_REPORT_BYTES || connections.get(agentId) !== ws || writingSystemdReports.has(agentId)) return;
    const report = parseSystemdReport(msg);
    if (!report) return;
    writingSystemdReports.add(agentId);
    try {
      await storeSystemdReport(agentId, ws.data.sessionId, report);
    } finally {
      writingSystemdReports.delete(agentId);
    }
  } else if (msg.type === "workload_inventory") {
    if (bytes > MAX_WORKLOAD_INVENTORY_BYTES || connections.get(agentId) !== ws || writingWorkloadReports.has(agentId)) return;
    const report = parseWorkloadInventory(msg);
    if (!report) return;
    writingWorkloadReports.add(agentId);
    try {
      await storeWorkloadInventory(agentId, ws.data.sessionId, report);
    } finally {
      writingWorkloadReports.delete(agentId);
    }
  } else if (msg.type === "config_snapshot") {
    // Strict contract validation: bounded size, active socket identity, exact frame schema.
    if (bytes > MAX_CONFIG_SNAPSHOT_BYTES || connections.get(agentId) !== ws || writingConfigSnapshots.has(agentId)) return;
    const frame = parseConfigSnapshot(msg);
    if (!frame) return;
    writingConfigSnapshots.add(agentId);
    try {
      await storeConfigSnapshot(agentId, frame);
    } finally {
      writingConfigSnapshots.delete(agentId);
    }
  } else if (msg.type === "telemetry") {
    // Strict contract validation: finite bounded metrics, sane timestamp, bounded config hashes.
    const m = parseTelemetry(msg);
    if (!m || connections.get(agentId) !== ws) return;

    await db`INSERT INTO metric_samples(agent_id,cpu_percent,memory_percent,disk_percent,network_rx_bytes,network_tx_bytes,uptime_seconds) VALUES(${agentId},${m.cpuPercent},${m.memoryPercent},${m.diskPercent},${m.networkRxBytes},${m.networkTxBytes},${m.uptimeSeconds})`;
    await db`UPDATE agents SET last_seen_at=NOW(),status='online' WHERE id=${agentId}`;
    await checkThresholds(agentId, m);
    await checkConfigHashes(agentId, m.configHashes);
  } else if (msg.type === "diagnostic_result") {
    const r = msg as DiagnosticResult;
    const p = pending.get(r.requestId);
    if (!p || p.agentId !== agentId || p.tool !== r.tool) {
      return;
    }

    clearTimeout(p.timer);
    pending.delete(r.requestId);
    await addEvidence(
      p.incidentId,
      `tool:${r.tool}`,
      `success=${Boolean(r.ok)}; output=${String(r.content).slice(0, 5000)}`,
    );
    p.resolve(Boolean(r.ok));
  }
}

/** Returns true if an agent currently holds an active WebSocket connection on this hub. */
export function agentOnline(id: string): boolean {
  return connections.has(id);
}

/** Returns the opaque current connection identity for the systemd read model. */
export function agentSession(id: string): string | undefined {
  return connections.get(id)?.data.sessionId;
}

/** Sends a bounded diagnostic request to a connected agent with a 6-second timeout. */
export async function requestDiagnostics(
  agentId: string,
  incidentId: string,
  tool: DiagnosticTool,
  service?: string,
): Promise<boolean> {
  const socket = connections.get(agentId);
  if (!socket) {
    return false;
  }

  const requestId = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(false);
    }, 6000);
    pending.set(requestId, { agentId, incidentId, tool, resolve, timer });
    try {
      socket.send(
        JSON.stringify({
          type: "diagnostic_request",
          requestId,
          tool,
          ...(service ? { service } : {}),
        }),
      );
    } catch {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(false);
    }
  });
}
