import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostMetric, HostSystemdStatus } from "../packages/contracts/src/index";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

const integration = providerTestDatabaseAvailable ? test : test.skip;
const root = new URL("../", import.meta.url).pathname;
const password = "disposable-systemd-integration";

type Identity = { agentId: string; agentSecret: string };

async function eventually<T>(read: () => Promise<T>, accept: (result: T) => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  do {
    const result = await read();
    if (accept(result)) return result;
    // HTTP and the database run in separate processes; fake timers cannot advance them.
    await Bun.sleep(35);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function openConnection(url: string, id: Identity) {
  const socket = new WebSocket(url, { headers: {
    "x-opspilot-agent-id": id.agentId, authorization: `Bearer ${id.agentSecret}`,
  } });
  const signal = AbortSignal.timeout(5000);
  try {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    socket.addEventListener("open", () => resolve(), { once: true, signal });
    socket.addEventListener("error", () => reject(new Error("Agent socket upgrade failed")), { once: true, signal });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    await promise;
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

integration("Go wire, authenticated systemd snapshots and selected-host reads interoperate without disrupting telemetry", async () => {
  await withProviderTestDb(async (db, databaseUrl) => {
    const scratch = await mkdtemp(join(tmpdir(), "opspilot-systemd-test-"));
    const stop = new Set<() => Promise<unknown>>();
    try {
      const binary = join(scratch, "opspilot-agent");
      const build = Bun.spawnSync(["go", "build", "-mod=readonly", "-o", binary, "./cmd/opspilot-agent"], {
        cwd: join(root, "agent"), timeout: 90_000,
        env: { PATH: process.env.PATH ?? "", HOME: scratch, CGO_ENABLED: "0", GOTOOLCHAIN: "local",
          GOMODCACHE: process.env.GOMODCACHE || join(process.env.HOME ?? scratch, "go/pkg/mod"),
          GOCACHE: process.env.GOCACHE || join(scratch, "go-cache") },
      });
      if (!build.success) throw new Error(`Go build failed: ${build.stderr.toString()}`);
      const migration = Bun.spawnSync([process.execPath, "--no-env-file", "tools/migrate.ts"], {
        cwd: root, env: { DATABASE_URL: databaseUrl }, timeout: 15_000,
      });
      if (!migration.success) throw new Error(`Migration failed: ${migration.stderr.toString()}`);

      // Import after setting the loopback bind so the production socket handlers run only on loopback.
      const hub = Bun.spawn([process.execPath, "--no-env-file", "-e", `
        const serve = Bun.serve;
        Bun.serve = options => serve({...options, hostname: "127.0.0.1"});
        await import("./apps/hub/src/index.ts");
      `], {
        cwd: root, stdout: "pipe", stderr: "inherit",
        env: { DATABASE_URL: databaseUrl, PORT: "0", NODE_ENV: "development", ADMIN_PASSWORD: password,
          SESSION_SECRET: "disposable-systemd-integration-cookie", COOKIE_SECURE: "false" },
      });
      stop.add(async () => { hub.kill(); await hub.exited; });
      const stdout = hub.stdout.getReader();
      const startup = await stdout.read();
      await stdout.cancel();
      const port = new TextDecoder().decode(startup.value).match(/localhost:(\d+)/)?.[1];
      if (!port) throw new Error("Hub did not announce its test port");
      const base = `http://127.0.0.1:${port}`;
      const socketUrl = `ws://127.0.0.1:${port}/api/agents/connect`;
      let cookie = "";
      const api = (path: string, body?: unknown, auth = true) => fetch(base + path, {
        signal: AbortSignal.timeout(3000),
        headers: { "content-type": "application/json", ...(auth && cookie ? { cookie } : {}) },
        method: body === undefined ? "GET" : "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const login = await api("/api/auth/login", { password });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")!.split(";")[0];
      const token = async (): Promise<string> => {
        const response = await api("/api/agents/enrollment-token", {});
        expect(response.status).toBe(201);
        return (await response.json()).token;
      };
      const enroll = async (hostname: string): Promise<Identity> => {
        const response = await api("/api/agents/enroll", { token: await token(), hostname, version: "legacy-fixture" }, false);
        expect(response.status).toBe(201);
        return response.json();
      };
      const status = async (id: string): Promise<HostSystemdStatus> => {
        const response = await api(`/api/hosts/${id}/services`);
        expect(response.status).toBe(200);
        return response.json();
      };
      const metrics = async (id: string): Promise<HostMetric[]> => (await api(`/api/hosts/${id}/metrics`)).json();
      const startAgent = (unit: string, enrollmentToken: string) => {
        const child = Bun.spawn([binary], { stdout: "ignore", stderr: "inherit", env: {
          OPSPILOT_HUB_URL: base, OPSPILOT_AGENT_STATE_PATH: join(scratch, "identity.json"),
          OPSPILOT_ENROLL_TOKEN: enrollmentToken, OPSPILOT_SYSTEMD_UNIT: unit,
        } });
        const terminate = async () => { child.kill(); await child.exited; stop.delete(terminate); };
        stop.add(terminate);
        return terminate;
      };

      const terminateAgent = startAgent("", await token());
      const identityPath = join(scratch, "identity.json");
      await eventually(() => Bun.file(identityPath).exists(), Boolean, "Go agent enrollment");
      const goId = (await Bun.file(identityPath).json() as Identity).agentId;
      const disabled = await eventually(() => status(goId), row => row.report?.status === "disabled", "Go disabled report");
      expect(disabled).toMatchObject({ online: true, report: { current: true }, service: null });
      expect((await eventually(() => metrics(goId), rows => !!rows.length, "Go metrics"))[0].cpu_percent).toBeGreaterThanOrEqual(0);
      await terminateAgent();
      await eventually(() => status(goId), row => !row.online, "Go disconnect");
      startAgent("--invalid.service", "");
      const unavailable = await eventually(() => status(goId), row => row.report?.status === "unavailable", "Go invalid-config report");
      expect(unavailable).toMatchObject({ online: true, report: { current: true }, service: null });

      const legacy = await enroll("legacy-fixture");
      const other = await enroll("different-host");
      const id = legacy.agentId;
      expect((await api(`/api/hosts/${id}/services`, undefined, false)).status).toBe(401);
      expect((await api("/api/hosts/not-a-uuid/services")).status).toBe(400);
      expect((await api(`/api/hosts/${crypto.randomUUID()}/services`)).status).toBe(404);
      const denied = await fetch(base + "/api/agents/connect", { headers: {
        "x-opspilot-agent-id": other.agentId, authorization: `Bearer ${legacy.agentSecret}`,
      } });
      expect(denied.status).toBe(401);
      await db`INSERT INTO host_services(agent_id,name,runtime,state) VALUES(${id},'demo.service','systemd','running')`;

      let socket = await openConnection(socketUrl, legacy);
      stop.add(async () => socket.close());
      const metric = (cpuPercent: number) => JSON.stringify({ type: "telemetry", timestamp: new Date().toISOString(),
        cpuPercent, memoryPercent: 20, diskPercent: 30, networkRxBytes: 0, networkTxBytes: 0, uptimeSeconds: 1, configHashes: {} });
      socket.send(metric(12));
      await eventually(() => metrics(id), rows => rows.some(row => row.cpu_percent === 12), "legacy metrics");
      expect(await status(id)).toMatchObject({ online: true, report: null, service: null });

      const frame = (state: string, observedAt = new Date().toISOString()) => ({
        type: "systemd_status", version: 1, observedAt, status: "observed", unit: "verify.service", state,
      });
      const running = frame("running");
      for (const raw of ["null", "{broken json", JSON.stringify({ ...running, agentId: other.agentId }),
        JSON.stringify({ ...running, state: "inactive" }), JSON.stringify({ ...running, unit: "*.service" }),
        JSON.stringify({ ...running, units: [running, running] }), JSON.stringify(running).padEnd(513, " "),
        JSON.stringify({ ...running, observedAt: "2025-01-01T00:00:00.000Z" })]) socket.send(raw);
      socket.send(metric(13));
      await eventually(() => metrics(id), rows => rows.some(row => row.cpu_percent === 13), "metrics after rejected status frames");
      expect((await status(id)).report).toBeNull();
      expect((await status(other.agentId)).report).toBeNull();

      socket.send(JSON.stringify(running));
      const measured = await eventually(() => status(id), row => row.service?.state === "running", "live snapshot");
      expect(measured.service).toMatchObject({ name: "verify.service", agent_id: id, source: "agent_systemd", freshness: "fresh", observed_at: running.observedAt });
      const next = frame("stopped");
      socket.send(JSON.stringify(next));
      await eventually(() => status(id), row => row.service?.state === "stopped", "newer stopped snapshot");
      socket.send(JSON.stringify(running));
      socket.send(metric(14));
      await eventually(() => metrics(id), rows => rows.some(row => row.cpu_percent === 14), "metrics after out-of-order frame");
      expect((await status(id)).service).toMatchObject({ state: "stopped", observed_at: next.observedAt });

      // Replacing a connected socket cannot make its last sample current on the replacement.
      socket = await openConnection(socketUrl, legacy);
      expect(await status(id)).toMatchObject({ online: true, service: { state: "stopped", observed_at: next.observedAt, freshness: "stale" } });
      const failed = frame("failed");
      socket.send(JSON.stringify(failed));
      await eventually(() => status(id), row => row.service?.freshness === "fresh" && row.service.state === "failed", "new session snapshot");
      const expiredAt = new Date(Date.now() - 61_000).toISOString();
      await db`UPDATE host_systemd_reports SET observed_at=${expiredAt} WHERE agent_id=${id}`;
      await db`UPDATE host_services SET observed_at=${expiredAt} WHERE agent_id=${id} AND source='agent_systemd'`;
      expect(await status(id)).toMatchObject({ online: true, report: { current: false }, service: { state: "failed", freshness: "stale" } });
      socket.send(JSON.stringify({ type: "systemd_status", version: 1, observedAt: new Date().toISOString(), status: "unavailable", unit: "verify.service" }));
      const lostAccess = await eventually(() => status(id), row => row.report?.status === "unavailable", "collection failure");
      expect(lostAccess.service).toMatchObject({ state: "failed", observed_at: expiredAt, freshness: "stale" });
      socket.close();
      const offline = await eventually(() => status(id), row => !row.online, "legacy disconnect");
      expect(offline.service).toEqual(lostAccess.service);
      socket = await openConnection(socketUrl, legacy);
      socket.send(JSON.stringify({ type: "systemd_status", version: 1, observedAt: new Date().toISOString(), status: "disabled" }));
      expect((await eventually(() => status(id), row => row.report?.status === "disabled", "explicit collector removal")).service).toBeNull();
      expect((await status(other.agentId)).service).toBeNull();
    } finally {
      try { for (const close of [...stop].reverse()) await close(); }
      finally { await rm(scratch, { recursive: true, force: true }); }
    }
  });
}, 120_000);
