import { expect, test } from "bun:test";
import type { SQL } from "bun";
import type { AlertCondition, HostList, HostMetric, HostThresholds } from "../packages/contracts/src/index";
import { runMetricRetention } from "../apps/worker/src/jobs";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

const integration = providerTestDatabaseAvailable ? test : test.skip;
const root = new URL("../", import.meta.url).pathname;
const password = "disposable-monitoring-integration";

type Identity = { agentId: string; agentSecret: string };

async function eventually<T>(read: () => Promise<T>, accept: (result: T) => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  do {
    const result = await read();
    if (accept(result)) return result;
    await Bun.sleep(35);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

type Hub = {
  base: string;
  socketUrl: string;
  api: (path: string, init?: { method?: string; body?: unknown; auth?: boolean }) => Promise<Response>;
  stop: () => Promise<void>;
};

async function startHub(databaseUrl: string): Promise<Hub> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    const serve = Bun.serve;
    Bun.serve = options => serve({...options, hostname: "127.0.0.1"});
    await import("./apps/hub/src/index.ts");
  `], {
    cwd: root, stdout: "pipe", stderr: "inherit",
    env: { DATABASE_URL: databaseUrl, PORT: "0", NODE_ENV: "development", ADMIN_PASSWORD: password,
      SESSION_SECRET: "disposable-monitoring-integration-cookie", COOKIE_SECURE: "false" },
  });
  const stdout = child.stdout.getReader();
  const startup = await stdout.read();
  await stdout.cancel();
  const port = new TextDecoder().decode(startup.value).match(/localhost:(\d+)/)?.[1];
  if (!port) throw new Error("Hub did not announce its test port");
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  const api = (path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) => {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    return fetch(base + path, {
      signal: AbortSignal.timeout(3000),
      headers: { "content-type": "application/json", ...(init.auth !== false && cookie ? { cookie } : {}) },
      method,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };
  const login = await api("/api/auth/login", { body: { password } });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  return {
    base,
    socketUrl: `ws://127.0.0.1:${port}/api/agents/connect`,
    api,
    stop: async () => { child.kill(); await child.exited; },
  };
}

async function migrate(databaseUrl: string) {
  const migration = Bun.spawnSync([process.execPath, "--no-env-file", "tools/migrate.ts"], {
    cwd: root, env: { DATABASE_URL: databaseUrl }, timeout: 15_000,
  });
  if (!migration.success) throw new Error(`Migration failed: ${migration.stderr.toString()}`);
}

async function token(hub: Hub): Promise<string> {
  const response = await hub.api("/api/agents/enrollment-token", { body: {} });
  expect(response.status).toBe(201);
  return (await response.json()).token as string;
}

async function enroll(hub: Hub, hostname: string, extra: Record<string, unknown> = {}): Promise<Identity> {
  const response = await hub.api("/api/agents/enroll", { body: { token: await token(hub), hostname, version: "0.1.0", ...extra }, auth: false });
  expect(response.status).toBe(201);
  return response.json() as Promise<Identity>;
}

function openSocket(hub: Hub, id: Identity): Promise<WebSocket> {
  const socket = new WebSocket(hub.socketUrl, { headers: {
    "x-opspilot-agent-id": id.agentId, authorization: `Bearer ${id.agentSecret}`,
  } });
  const signal = AbortSignal.timeout(5000);
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  socket.addEventListener("open", () => resolve(socket), { once: true, signal });
  socket.addEventListener("error", () => reject(new Error("upgrade failed")), { once: true, signal });
  return promise;
}

const send = (socket: WebSocket, value: unknown) => socket.send(JSON.stringify(value));
const telemetry = (overrides: Record<string, unknown> = {}) => ({
  type: "telemetry",
  timestamp: new Date().toISOString(),
  cpuPercent: 10, memoryPercent: 20, diskPercent: 30,
  networkRxBytes: 1000, networkTxBytes: 500, uptimeSeconds: 60,
  configHashes: {},
  ...overrides,
});

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const signal = AbortSignal.timeout(3000);
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true, signal });
  socket.addEventListener("error", () => reject(new Error("socket error")), { once: true, signal });
  return promise;
}

integration("hello negotiates protocol/capabilities, telemetry validation is strict, thresholds persist across restart", async () => {
  await withProviderTestDb(async (db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      // --- enrollment with protocol + capabilities, and negative enroll bodies ---
      const bogus = await hub.api("/api/agents/enroll", { body: { token: await token(hub), hostname: "monitored-host", protocolVersion: 2, capabilities: ["telemetry", "bogus"] }, auth: false });
      expect(bogus.status).toBe(400); // unknown capability rejects the whole enroll
      const bad = await hub.api("/api/agents/enroll", { body: { token: await token(hub), hostname: "x", capabilities: ["nope"] }, auth: false });
      expect(bad.status).toBe(400);
      const ok = await enroll(hub, "monitored-host", { protocolVersion: 2, capabilities: ["telemetry", "systemd_status", "diagnostics"] });
      const id = ok.agentId;

      // --- hello negotiation over the socket ---
      const socket = await openSocket(hub, ok);
      send(socket, { type: "hello", protocolVersion: 2, agentVersion: "0.1.0", capabilities: ["telemetry", "systemd_status", "diagnostics", "shell"] });
      const ack = await nextMessage(socket);
      expect(ack).toEqual({ type: "hello_ack", protocolVersion: 2, capabilities: ["telemetry", "systemd_status", "diagnostics"] });
      const listed = await eventually(async () => (await hub.api("/api/hosts")).json() as Promise<HostList>, fleet => {
        const host = fleet.hosts.find(h => h.id === id);
        return host?.protocol_version === 2 && host.capabilities.includes("diagnostics");
      }, "host protocol/capabilities in list");
      expect(listed.hosts.find(h => h.id === id)?.capabilities).not.toContain("shell");

      // Newer protocol version is refused with close code 4000 (separate agent: a second
      // socket for the same agent would supersede the first with 4001).
      const futureIdentity = await enroll(hub, "future-host", { protocolVersion: 2, capabilities: ["telemetry"] });
      const future = await openSocket(hub, futureIdentity);
      const closed = Promise.withResolvers<number>();
      future.addEventListener("close", (event) => closed.resolve(event.code), { once: true });
      send(future, { type: "hello", protocolVersion: 99, agentVersion: "9.9.9", capabilities: [] });
      expect(await closed.promise).toBe(4000);
      future.close();

      // --- strict telemetry validation: only valid frames reach metric_samples ---
      const before = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM metric_samples WHERE agent_id=${id}`;
      for (const badFrame of [
        telemetry({ cpuPercent: 101 }),
        telemetry({ memoryPercent: -1 }),
        telemetry({ diskPercent: NaN }),
        telemetry({ networkRxBytes: -5 }),
        telemetry({ networkTxBytes: 1.5 }),
        telemetry({ uptimeSeconds: Number.MAX_SAFE_INTEGER + 1 }),
        telemetry({ timestamp: new Date(Date.now() - 10 * 60_000).toISOString() }),
        telemetry({ timestamp: "not-a-time" }),
        telemetry({ extra: true }),
        telemetry({ configHashes: { "relative": "a".repeat(64) } }),
        { type: "telemetry" },
      ]) {
        send(socket, badFrame);
      }
      send(socket, telemetry());
      send(socket, telemetry({ cpuPercent: 12.5 }));
      await eventually(async () => {
        const rows = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM metric_samples WHERE agent_id=${id}`;
        return rows[0].count;
      }, count => count === before[0].count + 2, "only the two valid telemetry frames stored");
      socket.close();

      // --- thresholds API: auth, validation negatives, persistence across restart ---
      expect((await hub.api(`/api/hosts/${id}/thresholds`, { auth: false })).status).toBe(401);
      expect((await hub.api("/api/hosts/not-a-uuid/thresholds")).status).toBe(400);
      expect((await hub.api(`/api/hosts/${crypto.randomUUID()}/thresholds`)).status).toBe(404);
      // (NaN/Infinity serialize to JSON null, which is a valid "disable" value; unit tests cover them.)
      for (const body of [{}, { cpu_percent: 101 }, { cpu_percent: -1 }, { cpu_percent: "90" }, { bogus: 1 }, []]) {
        const response = await hub.api(`/api/hosts/${id}/thresholds`, { method: "PUT", body });
        expect(response.status).toBe(400);
      }
      const put = await hub.api(`/api/hosts/${id}/thresholds`, { method: "PUT", body: { cpu_percent: 50, disk_percent: null } });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ thresholds: { cpu_percent: 50, memory_percent: 90, disk_percent: null } });
      const read = await hub.api(`/api/hosts/${id}/thresholds`);
      expect(read.status).toBe(200);
      const payload = await read.json() as { thresholds: HostThresholds; conditions: AlertCondition[] };
      expect(payload.thresholds).toEqual({ cpu_percent: 50, memory_percent: 90, disk_percent: null });
      expect(Array.isArray(payload.conditions)).toBe(true);

      // Single breaching sample followed by normal value resets to ok (not cooldown).
      const socket2 = await openSocket(hub, ok);
      send(socket2, telemetry({ cpuPercent: 80 }));
      await eventually(async () => {
        const rows = await db<{ state: string; consecutive: number }[]>`
          SELECT state,consecutive FROM alert_conditions WHERE agent_id=${id} AND metric='cpu'`;
        return rows[0];
      }, row => row?.state === "breaching" && row.consecutive === 1, "single breaching sample");
      send(socket2, telemetry({ cpuPercent: 10 }));
      await eventually(async () => {
        const rows = await db<{ state: string; cooldown_until: Date | null }[]>`
          SELECT state,cooldown_until FROM alert_conditions WHERE agent_id=${id} AND metric='cpu'`;
        return rows[0];
      }, row => row?.state === "ok" && row.cooldown_until === null, "reset from breaching to ok without cooldown");

      // Breach twice -> incident + persisted breached condition.
      send(socket2, telemetry({ cpuPercent: 80 }));
      send(socket2, telemetry({ cpuPercent: 80 }));
      await eventually(async () => {
        const rows = await db<{ state: string; consecutive: number; incident_id: string | null }[]>`
          SELECT state,consecutive,incident_id FROM alert_conditions WHERE agent_id=${id} AND metric='cpu'`;
        return rows[0];
      }, row => row?.state === "breached" && row.consecutive >= 2 && row.incident_id !== null, "persisted breached condition");
      const incidents = await db<{ id: string; category: string }[]>`SELECT id,category FROM incidents WHERE agent_id=${id}`;
      expect(incidents.some(row => row.category === "cpu")).toBe(true);
      socket2.close();

      // Hub restart keeps thresholds and condition state.
      await hub.stop();
      const hub2 = await startHub(databaseUrl);
      try {
        const after = await hub2.api(`/api/hosts/${id}/thresholds`);
        const payload2 = await after.json() as { thresholds: HostThresholds; conditions: AlertCondition[] };
        expect(payload2.thresholds.cpu_percent).toBe(50);
        expect(payload2.conditions.find(c => c.metric === "cpu")?.state).toBe("breached");
        // Recovery moves the condition to cooldown without a new incident.
        const socket3 = await openSocket(hub2, ok);
        send(socket3, telemetry({ cpuPercent: 10 }));
        await eventually(async () => {
          const rows = await db<{ state: string }[]>`SELECT state FROM alert_conditions WHERE agent_id=${id} AND metric='cpu'`;
          return rows[0].state;
        }, state => state === "cooldown", "cooldown after restart");
        const incidentCount = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM incidents WHERE agent_id=${id} AND category='cpu'`;
        expect(incidentCount[0].count).toBe(1);
        socket3.close();
        // DELETE resets to environment defaults.
        const del = await hub2.api(`/api/hosts/${id}/thresholds`, { method: "DELETE" });
        expect(del.status).toBe(200);
        expect((await del.json() as { thresholds: HostThresholds }).thresholds.cpu_percent).toBe(95);
      } finally {
        await hub2.stop();
      }
    } finally {
      await hub.stop();
    }
  });
}, 120_000);

integration("retention rolls up and deletes raw samples; metrics API serves hourly history", async () => {
  await withProviderTestDb(async (db: SQL, databaseUrl: string) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      const identity = await enroll(hub, "retention-host");
      const id = identity.agentId;
      const socket = await openSocket(hub, identity);
      send(socket, telemetry());
      await eventually(async () => {
        const rows = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM metric_samples WHERE agent_id=${id}`;
        return rows[0].count;
      }, count => count >= 1, "telemetry stored");
      socket.close();

      // Backfill old raw samples across two hours, plus one recent sample.
      const oldBase = new Date(Date.now() - 200 * 3_600_000);
      await db`INSERT INTO metric_samples(agent_id,sampled_at,cpu_percent,memory_percent,disk_percent,network_rx_bytes,network_tx_bytes,uptime_seconds)
        SELECT ${id}, ${oldBase}::timestamptz + (n || ' minutes')::interval, 10 + n, 20, 30, 1000 + n, 500 + n, 60
        FROM generate_series(0, 119) AS n`;
      await db`INSERT INTO metric_samples(agent_id,cpu_percent,memory_percent,disk_percent,network_rx_bytes,network_tx_bytes,uptime_seconds)
        VALUES(${id}, 11, 22, 33, 2000, 1000, 60)`;

      // Small raw window so the backfill leaves it: 1 hour.
      process.env.METRIC_RAW_RETENTION_HOURS = "1";
      process.env.METRIC_ROLLUP_RETENTION_DAYS = "90";
      try {
        let didWork = false;
        for (let i = 0; i < 40; i++) {
          if (await runMetricRetention(db)) didWork = true;
        }
        expect(didWork).toBe(true);
      } finally {
        delete process.env.METRIC_RAW_RETENTION_HOURS;
        delete process.env.METRIC_ROLLUP_RETENTION_DAYS;
      }

      const rawLeft = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM metric_samples WHERE agent_id=${id} AND sampled_at < NOW() - INTERVAL '1 hour'`;
      expect(rawLeft[0].count).toBe(0);
      const rawRecent = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM metric_samples WHERE agent_id=${id}`;
      expect(rawRecent[0].count).toBeGreaterThanOrEqual(1);
      const rollups = await db<{ hour: Date; sample_count: number; cpu_avg: number; cpu_max: number; network_rx_bytes: number }[]>`
        SELECT hour,sample_count,cpu_avg,cpu_max,network_rx_bytes FROM metric_samples_hourly WHERE agent_id=${id} ORDER BY hour`;
      expect(rollups.length).toBeGreaterThanOrEqual(2);
      expect(rollups.reduce((sum, row) => sum + row.sample_count, 0)).toBe(120);
      expect(rollups[0].cpu_max).toBeGreaterThanOrEqual(rollups[0].cpu_avg);

      // Partial hour at the retention horizon must not be split or dropped.
      const partialHourStart = new Date(Date.UTC(2026, 0, 10, 10, 0, 0));
      await db`INSERT INTO metric_samples(agent_id,sampled_at,cpu_percent,memory_percent,disk_percent,network_rx_bytes,network_tx_bytes,uptime_seconds)
        VALUES
          (${id}, ${new Date(partialHourStart.getTime() + 10 * 60_000)}, 40, 20, 30, 100, 50, 60),
          (${id}, ${new Date(partialHourStart.getTime() + 30 * 60_000)}, 60, 20, 30, 200, 100, 60)`;
      process.env.METRIC_RAW_RETENTION_HOURS = "1";
      process.env.METRIC_ROLLUP_RETENTION_DAYS = "3650";
      try {
        // At 11:25, raw cutoff is 10:25 -> truncated horizon is 10:00, so 10:00-11:00 stays raw.
        await runMetricRetention(db, new Date(Date.UTC(2026, 0, 10, 11, 25, 0)));
        const midHourRaw = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM metric_samples
          WHERE agent_id=${id} AND sampled_at >= ${partialHourStart} AND sampled_at < ${new Date(partialHourStart.getTime() + 3_600_000)}`;
        expect(midHourRaw[0].count).toBe(2);
        // At 12:05, raw cutoff is 11:05 -> truncated horizon is 11:00, so the full 10:00 hour rolls up together.
        await runMetricRetention(db, new Date(Date.UTC(2026, 0, 10, 12, 5, 0)));
        const afterHourRaw = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM metric_samples
          WHERE agent_id=${id} AND sampled_at >= ${partialHourStart} AND sampled_at < ${new Date(partialHourStart.getTime() + 3_600_000)}`;
        expect(afterHourRaw[0].count).toBe(0);
        const [fullHourRollup] = await db<{ sample_count: number; cpu_avg: number }[]>`
          SELECT sample_count,cpu_avg FROM metric_samples_hourly WHERE agent_id=${id} AND hour=${partialHourStart}`;
        expect(fullHourRollup).toEqual({ sample_count: 2, cpu_avg: 50 });
      } finally {
        delete process.env.METRIC_RAW_RETENTION_HOURS;
        delete process.env.METRIC_ROLLUP_RETENTION_DAYS;
      }

      // Metrics API: raw recent range, hourly historical range, and hourly without from/to.
      const nowIso = new Date().toISOString();
      const fromIso = new Date(Date.now() - 300 * 24 * 3_600_000).toISOString();
      const rawRange = await hub.api(`/api/hosts/${id}/metrics?from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&to=${encodeURIComponent(nowIso)}&resolution=raw`) as Response;
      const rawRows = await rawRange.json() as HostMetric[];
      expect(rawRows.length).toBeGreaterThanOrEqual(1);
      const hourly = await hub.api(`/api/hosts/${id}/metrics?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(nowIso)}&resolution=hourly`) as Response;
      const hourlyRows = await hourly.json() as HostMetric[];
      expect(hourlyRows.length).toBe(rollups.length);
      expect(hourlyRows[0].cpu_percent).toBeGreaterThan(0);
      // resolution=hourly without from/to reads metric_samples_hourly instead of falling back to raw.
      const hourlyUnbounded = await hub.api(`/api/hosts/${id}/metrics?resolution=hourly`) as Response;
      const hourlyUnboundedRows = await hourlyUnbounded.json() as HostMetric[];
      expect(hourlyUnboundedRows.length).toBe(rollups.length + 1);
      expect(hourlyUnboundedRows.some(r => r.sampled_at === partialHourStart.toISOString())).toBe(true);
      // auto picks hourly for spans beyond the raw retention window.
      const auto = await hub.api(`/api/hosts/${id}/metrics?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(nowIso)}`) as Response;
      expect((await auto.json() as HostMetric[]).length).toBe(rollups.length);
      // Negative query params.
      expect((await hub.api(`/api/hosts/${id}/metrics?resolution=bogus`)).status).toBe(400);
      expect((await hub.api(`/api/hosts/${id}/metrics?limit=0`)).status).toBe(400);
      expect((await hub.api(`/api/hosts/${id}/metrics?from=${encodeURIComponent(nowIso)}&to=${encodeURIComponent(fromIso)}`)).status).toBe(400);
      expect((await hub.api(`/api/hosts/${id}/metrics?from=${encodeURIComponent(fromIso)}`)).status).toBe(400);
      expect((await hub.api(`/api/hosts/not-a-uuid/metrics`)).status).toBe(400);
    } finally {
      await hub.stop();
    }
  });
}, 120_000);

integration("enrollment defaults to legacy protocol when version fields are absent", async () => {
  await withProviderTestDb(async (_db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      const legacy = await enroll(hub, "legacy-host");
      const response = await hub.api("/api/hosts");
      const fleet = await response.json() as HostList;
      const host = fleet.hosts.find(h => h.id === legacy.agentId);
      expect(host?.protocol_version).toBe(1);
      expect(host?.capabilities).toEqual([]);
    } finally {
      await hub.stop();
    }
  });
}, 120_000);
