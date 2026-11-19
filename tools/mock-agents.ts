import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import type { AgentTelemetry, SystemdReport } from "../packages/contracts/src/index";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SAMPLE_INTERVAL_MS = 15_000;
const LOCK_ID = 73460712;

export function assertMockSafety(
  env: NodeJS.ProcessEnv = process.env,
  hubUrlInput = env.MOCK_HUB_URL || "http://127.0.0.1:3001",
) {
  if (env.NODE_ENV === "production") {
    throw new Error("Mock agent seeding is disabled in production");
  }
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required");
  }
  let parsedDb: URL;
  try {
    parsedDb = new URL(dbUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid URL");
  }
  if (!LOOPBACK_HOSTS.has(parsedDb.hostname)) {
    throw new Error("Mock agent seeding requires a loopback PostgreSQL connection");
  }
  let parsedHub: URL;
  try {
    parsedHub = new URL(hubUrlInput);
  } catch {
    throw new Error("MOCK_HUB_URL must be a valid URL");
  }
  if ((parsedHub.protocol !== "http:" && parsedHub.protocol !== "https:") || !LOOPBACK_HOSTS.has(parsedHub.hostname)) {
    throw new Error("Mock agent connections require a loopback HTTP(S) Hub URL");
  }
  return { dbUrl, hubUrl: parsedHub };
}

function mockId(group: number, index: number) {
  return `f100${group.toString(16).padStart(4, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

type SystemdSpec =
  | { kind: "observed"; unit: string; state: "running" | "stopped" | "failed" | "unknown" }
  | { kind: "disabled" }
  | { kind: "unsupported"; unit: string };

type HostSpec = {
  id: string;
  hostname: string;
  connect: boolean;
  streamTelemetry: boolean;
  ageMs: number;
  usage: readonly [number, number, number] | null;
  systemd: SystemdSpec | null;
};

const hostSpecs: readonly HostSpec[] = [
  {
    id: mockId(1, 1),
    hostname: "mock-edge-01",
    connect: true,
    streamTelemetry: true,
    ageMs: 0,
    usage: [96.4, 81.2, 51.0],
    systemd: { kind: "observed", unit: "mock-storefront.service", state: "failed" },
  },
  {
    id: mockId(1, 2),
    hostname: "mock-near-limit-01",
    connect: true,
    streamTelemetry: true,
    ageMs: 0,
    usage: [92.5, 49.5, 42.0],
    systemd: { kind: "observed", unit: "mock-edge-proxy.service", state: "running" },
  },
  {
    id: mockId(1, 3),
    hostname: "mock-db-01",
    connect: true,
    streamTelemetry: true,
    ageMs: 0,
    usage: [31.5, 55.0, 87.2],
    systemd: { kind: "observed", unit: "postgresql.service", state: "running" },
  },
  {
    id: mockId(1, 4),
    hostname: "mock-safe-01",
    connect: true,
    streamTelemetry: true,
    ageMs: 0,
    usage: [34.0, 46.2, 38.4],
    systemd: { kind: "disabled" },
  },
  {
    id: mockId(1, 5),
    hostname: "mock-worker-01",
    connect: true,
    streamTelemetry: false,
    ageMs: 180_000,
    usage: [41.0, 66.0, 61.0],
    systemd: { kind: "unsupported", unit: "mock-worker.service" },
  },
  {
    id: mockId(1, 6),
    hostname: "mock-legacy-01",
    connect: false,
    streamTelemetry: false,
    ageMs: 900_000,
    usage: [58.0, 63.0, 72.0],
    systemd: { kind: "observed", unit: "mock-legacy-web.service", state: "running" },
  },
  {
    id: mockId(1, 7),
    hostname: "mock-new-01",
    connect: true,
    streamTelemetry: false,
    ageMs: 0,
    usage: null,
    systemd: null,
  },
];

function hashSecret(secret: string) {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

function buildSample(usage: readonly [number, number, number], step: number) {
  const [cpu, memory, disk] = usage;
  const wave = Math.sin(step / 3) * 1.4;
  return {
    cpuPercent: Number(Math.min(100, Math.max(0, cpu + (cpu >= 95 ? Math.abs(wave) * 0.4 : wave))).toFixed(1)),
    memoryPercent: Number(Math.min(100, Math.max(0, memory + Math.cos(step / 4) * 1.1)).toFixed(1)),
    diskPercent: Number(Math.min(100, Math.max(0, disk + (step % 4) * 0.1)).toFixed(1)),
    networkRxBytes: 4_200_000 + step * 35_000,
    networkTxBytes: 1_800_000 + step * 12_000,
    uptimeSeconds: 86_400 + step * 15,
  };
}

function buildSystemdReport(spec: SystemdSpec, observedAt: string): SystemdReport {
  switch (spec.kind) {
    case "observed":
      return { type: "systemd_status", version: 1, observedAt, status: "observed", unit: spec.unit, state: spec.state };
    case "disabled":
      return { type: "systemd_status", version: 1, observedAt, status: "disabled" };
    case "unsupported":
      return { type: "systemd_status", version: 1, observedAt, status: "unsupported", unit: spec.unit };
  }
}

async function seedMockDatabase(sql: SQL, seedOnly: boolean) {
  const secrets = new Map<string, string>();
  const nowMs = Math.floor(Date.now() / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS;

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;

    for (const host of hostSpecs) {
      const secret = randomBytes(32).toString("base64url");
      secrets.set(host.id, secret);
      const existing = await tx<{ hostname: string; version: string }[]>`
        SELECT hostname, version FROM agents WHERE id=${host.id}`;
      if (existing.length && existing[0].version !== "mock-agent") {
        throw new Error(`Reserved mock identity ${host.id} belongs to another record; aborting`);
      }

      const lastSeen = host.usage || host.connect ? new Date(nowMs - host.ageMs) : null;
      await tx`
        INSERT INTO agents(id, hostname, token_hash, version, created_at, last_seen_at, status)
        VALUES(${host.id}, ${host.hostname}, ${hashSecret(secret)}, 'mock-agent', ${new Date(nowMs - 86_400_000)}, ${lastSeen}, 'offline')
        ON CONFLICT (id) DO UPDATE SET
          hostname=excluded.hostname,
          token_hash=excluded.token_hash,
          last_seen_at=COALESCE(excluded.last_seen_at, agents.last_seen_at)
      `;

      const existingSamples = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM metric_samples WHERE agent_id=${host.id}`;
      if (host.usage && existingSamples[0].count === 0) {
        const baseline = nowMs - host.ageMs;
        for (let i = 31; i >= 0; i--) {
          if (i >= 9 && i <= 14) continue; // Keep a deliberate collection gap for chart verification.
          const sampledAt = new Date(baseline - i * SAMPLE_INTERVAL_MS);
          const s = buildSample(host.usage, 31 - i);
          await tx`
            INSERT INTO metric_samples(agent_id, sampled_at, cpu_percent, memory_percent, disk_percent, network_rx_bytes, network_tx_bytes, uptime_seconds)
            VALUES(${host.id}, ${sampledAt}, ${s.cpuPercent}, ${s.memoryPercent}, ${s.diskPercent}, ${s.networkRxBytes}, ${s.networkTxBytes}, ${s.uptimeSeconds})
          `;
        }
      }

      if (host.systemd && (seedOnly || !host.connect)) {
        const observedAt = new Date(nowMs - host.ageMs);
        const status = host.systemd.kind;
        await tx`
          INSERT INTO host_systemd_reports(agent_id, session_id, status, observed_at)
          VALUES(${host.id}, ${mockId(8, Number(host.id.slice(-2)))}, ${status}, ${observedAt})
          ON CONFLICT (agent_id) DO UPDATE SET
            status=excluded.status,
            observed_at=GREATEST(host_systemd_reports.observed_at, excluded.observed_at)
        `;
        if (host.systemd.kind === "observed") {
          await tx`
            INSERT INTO host_services(agent_id, name, runtime, state, source, observed_at)
            VALUES(${host.id}, ${host.systemd.unit}, 'systemd', ${host.systemd.state}, 'agent_systemd', ${observedAt})
            ON CONFLICT (agent_id, name) DO UPDATE SET
              state=excluded.state,
              source=excluded.source,
              observed_at=GREATEST(host_services.observed_at, excluded.observed_at)
          `;
        }
      }
    }

    await tx`DELETE FROM endpoint_monitors WHERE id IN (${mockId(9, 2)}, ${mockId(9, 3)})`;
    await tx`
      INSERT INTO endpoint_monitors(id, agent_id, service_name, name, target_url, expected_status, probe_location, last_status, last_http_status, last_latency_ms, last_error, last_checked_at)
      VALUES(${mockId(9, 1)}, ${hostSpecs[0].id}, 'mock-storefront', 'Mock storefront /health', 'https://storefront.example.invalid/health', 200, 'mock-fixture', 'down', 503, 48, NULL, ${new Date(nowMs - 30_000)})
      ON CONFLICT (id) DO NOTHING
    `;

    const cpuIncidentId = mockId(2, 1);
    const driftIncidentId = mockId(2, 2);
    const resolvedIncidentId = mockId(2, 3);
    const cpuEvidenceId = mockId(3, 1);
    const driftEvidenceId = mockId(3, 2);
    const resolvedEvidenceId = mockId(3, 3);

    await tx`
      INSERT INTO incidents(id, agent_id, title, category, status, created_at)
      VALUES(${cpuIncidentId}, ${hostSpecs[0].id}, 'Mock CPU pressure on edge', 'cpu', 'open', ${new Date(nowMs - 300_000)})
      ON CONFLICT (id) DO UPDATE SET created_at=excluded.created_at
    `;
    await tx`
      INSERT INTO evidence(id, incident_id, source, content, created_at)
      VALUES(${cpuEvidenceId}, ${cpuIncidentId}, 'threshold', 'Mock sample: CPU reached 96.4% against a 95% threshold.', ${new Date(nowMs - 300_000)})
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO investigations(id, incident_id, provider_id, provider_revision, provider_name, provider_protocol, provider_base_url, provider_model, status, result_json, created_at, started_at, completed_at)
      VALUES(
        ${mockId(4, 1)},
        ${cpuIncidentId},
        NULL,
        NULL,
        'Mock AI connection',
        'openai-compatible',
        'https://ai.example.invalid/v1',
        'mock-model',
        'completed',
        ${{
          probable_cause: "Mock hypothesis: background work may be competing for CPU.",
          confidence: 0.65,
          evidence_ids: [cpuEvidenceId],
          recommended_checks: ["Compare process usage with the mock workload schedule."],
        }}::jsonb,
        ${new Date(nowMs - 240_000)},
        ${new Date(nowMs - 235_000)},
        ${new Date(nowMs - 220_000)}
      )
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO incidents(id, agent_id, title, category, status, created_at)
      VALUES(${driftIncidentId}, ${hostSpecs[2].id}, 'Mock database config change', 'config_drift', 'open', ${new Date(nowMs - 600_000)})
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO evidence(id, incident_id, source, content, created_at)
      VALUES(${driftEvidenceId}, ${driftIncidentId}, 'config_drift', 'Mock drift: /etc/postgresql/16/main/postgresql.conf SHA-256 changed.', ${new Date(nowMs - 600_000)})
      ON CONFLICT (id) DO NOTHING
    `;

    const resolvedAt = new Date(nowMs - 3_300_000);
    const resolutionText = "Mock resolution: removed obsolete cache files and confirmed disk usage fell.";
    await tx`
      INSERT INTO incidents(id, agent_id, title, category, status, created_at, resolved_at, resolution)
      VALUES(${resolvedIncidentId}, ${hostSpecs[5].id}, 'Mock legacy disk pressure', 'disk', 'resolved', ${new Date(nowMs - 3_600_000)}, ${resolvedAt}, ${resolutionText})
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO evidence(id, incident_id, source, content, created_at)
      VALUES(${resolvedEvidenceId}, ${resolvedIncidentId}, 'threshold', 'Mock sample: disk utilization reached 92% on /var/cache.', ${new Date(nowMs - 3_600_000)})
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO incident_memory(id, incident_id, summary, resolution, created_at)
      VALUES(${mockId(5, 1)}, ${resolvedIncidentId}, 'Mock legacy disk pressure', ${resolutionText}, ${resolvedAt})
      ON CONFLICT (incident_id) DO NOTHING
    `;

    await tx`
      INSERT INTO audit_events(action, target_id, data)
      VALUES('mock.agents.seed', 'local-mock-v1', ${{ hosts: hostSpecs.length, seedOnly, synthetic: true }}::jsonb)
    `;
  });

  return secrets;
}

function connectMockAgent(hubUrl: URL, host: HostSpec, secret: string) {
  const wsUrl = new URL("/api/agents/connect", hubUrl);
  wsUrl.protocol = hubUrl.protocol === "https:" ? "wss:" : "ws:";

  let step = 32;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let socket: WebSocket | null = null;

  const pushState = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (host.systemd) {
      socket.send(JSON.stringify(buildSystemdReport(host.systemd, new Date().toISOString())));
    }
    if (host.streamTelemetry && host.usage) {
      const sample = buildSample(host.usage, step++);
      const payload: AgentTelemetry = {
        type: "telemetry",
        timestamp: new Date().toISOString(),
        ...sample,
        configHashes: {},
      };
      socket.send(JSON.stringify(payload));
    }
  };

  const openSocket = () => {
    if (closed) return;
    socket = new WebSocket(wsUrl.toString(), {
      headers: {
        "x-opspilot-agent-id": host.id,
        authorization: `Bearer ${secret}`,
      },
    } as never);

    socket.addEventListener("open", () => {
      pushState();
      if (timer) clearInterval(timer);
      timer = setInterval(pushState, SAMPLE_INTERVAL_MS);
    });

    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg?.type === "diagnostic_request" && typeof msg.requestId === "string" && typeof msg.tool === "string") {
          socket?.send(JSON.stringify({
            type: "diagnostic_result",
            requestId: msg.requestId,
            tool: msg.tool,
            ok: false,
            content: "Diagnostic tools are disabled on mock agents.",
          }));
        }
      } catch {
        // Ignore malformed messages from mock stream.
      }
    });

    socket.addEventListener("close", () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (!closed) {
        reconnectTimer = setTimeout(openSocket, 3_000);
      }
    });

    socket.addEventListener("error", () => {
      // Close event handles reconnect.
    });
  };

  openSocket();

  return () => {
    closed = true;
    if (timer) clearInterval(timer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}

if (import.meta.main) {
  const seedOnly = process.argv.includes("--seed-only");
  const { dbUrl, hubUrl } = assertMockSafety();
  const sql = new SQL(dbUrl);
  let secrets: Map<string, string>;
  try {
    secrets = await seedMockDatabase(sql, seedOnly);
  } finally {
    await sql.close();
  }

  console.log(
    `Seeded ${hostSpecs.length} mock hosts, 1 endpoint monitor, 3 incidents (with AI hypothesis & memory), and systemd fixtures into PostgreSQL.`,
  );

  if (!seedOnly) {
    const connected = hostSpecs.filter((host) => host.connect);
    const cleanups = connected.map((host) => connectMockAgent(hubUrl, host, secrets.get(host.id)!));
    console.log(
      `Connected ${connected.length} mock agents (${connected.map((h) => h.hostname).join(", ")}) to ${hubUrl.origin}. Press Ctrl+C to disconnect.`,
    );
    const shutdown = () => {
      for (const stop of cleanups) stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}
