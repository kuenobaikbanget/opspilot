import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostWorkloads, WorkloadList } from "../packages/contracts/src/index";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

const integration = providerTestDatabaseAvailable ? test : test.skip;
const root = new URL("../", import.meta.url).pathname;
const password = "disposable-workloads-integration";

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

integration("Go wire, authenticated workload inventory frames and scoped reads interoperate without disrupting telemetry", async () => {
  await withProviderTestDb(async (db, databaseUrl) => {
    const scratch = await mkdtemp(join(tmpdir(), "opspilot-workloads-test-"));
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
          SESSION_SECRET: "disposable-workloads-integration-cookie", COOKIE_SECURE: "false" },
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
      const hostWorkloads = async (id: string): Promise<HostWorkloads> => {
        const response = await api(`/api/hosts/${id}/workloads`);
        expect(response.status).toBe(200);
        return response.json();
      };
      const fleetWorkloads = async (): Promise<WorkloadList> => (await api("/api/workloads")).json();
      const metrics = async (id: string) => (await api(`/api/hosts/${id}/metrics`)).json();

      // A Go agent without the opt-in flags reports an explicit disabled capability.
      const child = Bun.spawn([binary], { stdout: "ignore", stderr: "inherit", env: {
        OPSPILOT_HUB_URL: base, OPSPILOT_AGENT_STATE_PATH: join(scratch, "identity.json"),
        OPSPILOT_ENROLL_TOKEN: await token(),
      } });
      const terminate = async () => { child.kill(); await child.exited; stop.delete(terminate); };
      stop.add(terminate);
      const identityPath = join(scratch, "identity.json");
      await eventually(() => Bun.file(identityPath).exists(), Boolean, "Go agent enrollment");
      const goId = (await Bun.file(identityPath).json() as Identity).agentId;
      const disabled = await eventually(() => hostWorkloads(goId), row => row.collection?.status === "disabled", "Go disabled inventory report");
      expect(disabled).toMatchObject({ online: true, collection: { current: true, reason: null }, workloads: [], counts: { total: 0, running: 0, stopped: 0, failed: 0, unknown: 0 } });
      expect((await eventually(() => metrics(goId), (rows: { length: number }) => rows.length > 0, "Go metrics"))[0].cpu_percent).toBeGreaterThanOrEqual(0);
      await terminate();
      await eventually(() => hostWorkloads(goId), row => !row.online, "Go disconnect");

      // Read-model authorization and validation.
      const legacy = await enroll("legacy-fixture");
      const other = await enroll("different-host");
      const id = legacy.agentId;
      expect((await api("/api/workloads", undefined, false)).status).toBe(401);
      expect((await api(`/api/hosts/${id}/workloads`, undefined, false)).status).toBe(401);
      expect((await api("/api/hosts/not-a-uuid/workloads")).status).toBe(400);
      expect((await api(`/api/hosts/${crypto.randomUUID()}/workloads`)).status).toBe(404);
      const denied = await fetch(base + "/api/agents/connect", { headers: {
        "x-opspilot-agent-id": other.agentId, authorization: `Bearer ${legacy.agentSecret}`,
      } });
      expect(denied.status).toBe(401);
      expect((await hostWorkloads(id)).collection).toBeNull();
      expect((await fleetWorkloads()).total).toBe(0);

      let socket = await openConnection(socketUrl, legacy);
      stop.add(async () => socket.close());
      const metric = (cpuPercent: number) => JSON.stringify({ type: "telemetry", timestamp: new Date().toISOString(),
        cpuPercent, memoryPercent: 20, diskPercent: 30, networkRxBytes: 0, networkTxBytes: 0, uptimeSeconds: 1, configHashes: {} });
      socket.send(metric(12));
      await eventually(() => metrics(id), (rows: { cpu_percent: number }[]) => rows.some(row => row.cpu_percent === 12), "legacy metrics");

      const frame = (body: Record<string, unknown>, observedAt = new Date().toISOString()) => ({
        type: "workload_inventory", version: 1, observedAt, ...body,
      });
      const okFrame = frame({ status: "ok", workloads: [
        { name: "web", runtime: "docker", state: "running", cpuPercent: 1.5, memoryBytes: 67108864 },
        { name: "nginx.service", runtime: "systemd", state: "stopped" },
      ] });
      // Invalid names, shapes, counts, timestamps, sizes and spoofed host identity are ignored.
      for (const raw of ["null", "{broken json", JSON.stringify({ ...okFrame, agentId: other.agentId }),
        JSON.stringify(frame({ status: "ok", workloads: [{ name: "--all", runtime: "docker", state: "running" }] })),
        JSON.stringify(frame({ status: "ok", workloads: [{ name: "nginx", runtime: "systemd", state: "running" }] })),
        JSON.stringify(frame({ status: "ok", workloads: [okFrame.workloads[0], okFrame.workloads[0]] })),
        JSON.stringify(frame({ status: "ok", workloads: Array.from({ length: 65 }, (_, i) => ({ name: `c${i}`, runtime: "docker", state: "running" })) })),
        JSON.stringify(frame({ status: "unavailable" })),
        JSON.stringify(frame({ status: "ok", workloads: [] }, "2025-01-01T00:00:00.000Z")),
        JSON.stringify(frame({ version: 2, status: "disabled" })),
        JSON.stringify(okFrame).padEnd(16 * 1024 + 1, " "),
      ]) socket.send(raw);
      socket.send(metric(13));
      await eventually(() => metrics(id), (rows: { cpu_percent: number }[]) => rows.some(row => row.cpu_percent === 13), "metrics after rejected inventory frames");
      expect((await hostWorkloads(id)).collection).toBeNull();
      expect((await hostWorkloads(other.agentId)).collection).toBeNull();

      // A measured snapshot persists workload rows with scoped resources and freshness.
      socket.send(JSON.stringify(okFrame));
      const measured = await eventually(() => hostWorkloads(id), row => row.collection?.status === "ok" && row.workloads.length === 2, "live inventory");
      expect(measured).toMatchObject({
        online: true,
        collection: { status: "ok", reason: null, skipped: [], current: true, observed_at: okFrame.observedAt },
        counts: { total: 2, running: 1, stopped: 1, failed: 0, unknown: 0 },
      });
      expect(measured.workloads).toContainEqual(expect.objectContaining({
        name: "web", runtime: "docker", state: "running", source: "agent_workloads", freshness: "fresh",
        cpu_percent: 1.5, memory_bytes: 67108864, observed_at: okFrame.observedAt,
      }));
      expect(measured.workloads).toContainEqual(expect.objectContaining({
        name: "nginx.service", runtime: "systemd", state: "stopped", freshness: "fresh",
        cpu_percent: null, memory_bytes: null,
      }));
      const fleet = await fleetWorkloads();
      expect(fleet).toMatchObject({
        total: 2, hosts_total: 3, hosts_online: 1, hosts_collecting: 1,
        counts: { total: 2, running: 1, stopped: 1, failed: 0, unknown: 0 },
        limit: 200, stale_after_seconds: 120,
      });
      expect(fleet.workloads).toHaveLength(2);

      // A newer successful scan replaces the row set; an older frame cannot overwrite it.
      const next = frame({ status: "ok", workloads: [{ name: "web", runtime: "docker", state: "failed", cpuPercent: 0, memoryBytes: 0 }] }, new Date(Date.now() + 1000).toISOString());
      socket.send(JSON.stringify(next));
      await eventually(() => hostWorkloads(id), row => row.workloads.length === 1 && row.workloads[0]?.state === "failed", "replaced inventory");
      socket.send(JSON.stringify(okFrame));
      socket.send(metric(14));
      await eventually(() => metrics(id), (rows: { cpu_percent: number }[]) => rows.some(row => row.cpu_percent === 14), "metrics after out-of-order frame");
      const afterOutOfOrder = await hostWorkloads(id);
      expect(afterOutOfOrder.workloads).toHaveLength(1);
      expect(afterOutOfOrder.workloads[0]).toMatchObject({ name: "web", state: "failed", observed_at: next.observedAt });
      expect((await fleetWorkloads()).total).toBe(1);

      // Aging past the stale window marks the collection and rows not current, without changing them.
      const expiredAt = new Date(Date.now() - 121_000).toISOString();
      await db`UPDATE host_workload_reports SET observed_at=${expiredAt} WHERE agent_id=${id}`;
      await db`UPDATE host_services SET observed_at=${expiredAt} WHERE agent_id=${id} AND source='agent_workloads'`;
      expect(await hostWorkloads(id)).toMatchObject({
        online: true, collection: { status: "ok", current: false }, workloads: [{ freshness: "stale" }],
      });
      expect((await fleetWorkloads()).hosts_collecting).toBe(0);

      // A collection failure keeps the status/reason and removes rows that can no longer be claimed fresh.
      const unavailable = frame({ status: "unavailable", reason: "docker_daemon_unreachable" });
      socket.send(JSON.stringify(unavailable));
      const failed = await eventually(() => hostWorkloads(id), row => row.collection?.status === "unavailable", "collection failure");
      expect(failed).toMatchObject({ collection: { status: "unavailable", reason: "docker_daemon_unreachable", current: true }, workloads: [], counts: { total: 0, running: 0, stopped: 0, failed: 0, unknown: 0 } });

      // Replacing the socket invalidates the previous session's currency; a new frame restores it.
      socket = await openConnection(socketUrl, legacy);
      expect((await hostWorkloads(id)).collection).toMatchObject({ status: "unavailable", current: false });
      socket.send(JSON.stringify(frame({ status: "ok", workloads: [], skipped: ["systemd"] })));
      const freshAgain = await eventually(() => hostWorkloads(id), row => row.collection?.current === true && row.collection.status === "ok", "new session inventory");
      expect(freshAgain.collection).toMatchObject({ skipped: ["systemd"] });
      expect(freshAgain.workloads).toEqual([]);
      expect((await fleetWorkloads()).hosts_collecting).toBe(1);

      // An explicit disabled report is a capability statement, not a process state.
      socket.send(JSON.stringify(frame({ status: "disabled" })));
      expect((await eventually(() => hostWorkloads(id), row => row.collection?.status === "disabled", "explicit disabled")).collection).toMatchObject({ current: true, reason: null });
      expect((await hostWorkloads(other.agentId)).collection).toBeNull();
      socket.close();
    } finally {
      try { for (const close of [...stop].reverse()) await close(); }
      finally { await rm(scratch, { recursive: true, force: true }); }
    }
  });
}, 120_000);
