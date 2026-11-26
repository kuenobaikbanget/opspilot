import { expect, test } from "bun:test";
import { runDueEndpointChecks } from "../apps/worker/src/endpoint-scheduler";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

const integration = providerTestDatabaseAvailable ? test : test.skip;

const root = new URL("../", import.meta.url).pathname;
const origin = "http://localhost:3100";
const password = "opspilot-endpoint-integration-password";
const sessionSecret = "opspilot-endpoint-integration-session-secret";
const mockEnv = { NODE_ENV: "development", OPSPILOT_ALLOW_LOOPBACK_PROBES: "true" };

function spawn(script: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--no-env-file", script], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  return {
    child,
    async finish(): Promise<{ code: number; output: string }> {
      // Real OS-process supervision bound: fake timers cannot advance a child process.
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      try {
        const code = await child.exited;
        return { code, output: `${await stdout}\n${await stderr}` };
      } finally {
        clearTimeout(timer);
      }
    },
    async stop(): Promise<void> {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(2000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all([stdout, stderr]);
    },
  };
}

async function migrate(databaseUrl: string): Promise<void> {
  const migration = spawn("tools/migrate.ts", { DATABASE_URL: databaseUrl });
  try {
    const result = await migration.finish();
    expect(result.code).toBe(0);
  } finally {
    await migration.stop();
  }
}

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

async function startHub(databaseUrl: string) {
  const port = freePort();
  const child = spawn("apps/hub/src/index.ts", {
    NODE_ENV: "development",
    DATABASE_URL: databaseUrl,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    ALLOWED_ORIGIN: origin,
    OPSPILOT_ALLOW_LOOPBACK_PROBES: "true",
    PORT: String(port),
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  // Real OS-process supervision: fake timers cannot advance a child process,
  // so readiness is polled by condition with a short real backoff.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null) {
      const result = await child.finish();
      throw new Error(`Hub exited early with code ${result.code}: ${result.output}`);
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(300) });
      if (res.status === 200) break;
    } catch {
      // keep polling until the listener is ready
    }
    await Bun.sleep(25);
  }
  let cookie = "";
  async function request(path: string, method = "GET", data?: unknown): Promise<Response> {
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    if (method !== "GET") {
      headers.set("origin", origin);
      headers.set("content-type", "application/json");
    }
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(8_000),
    });
  }
  return {
    baseUrl,
    request,
    async login(): Promise<void> {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      expect(res.status).toBe(200);
      cookie = res.headers.get("set-cookie")!.split(";")[0];
    },
    async stop(): Promise<void> {
      await child.stop();
    },
  };
}

integration("endpoint monitor routes persist, audit and schedule probes with SSRF controls", async () => {
  await withProviderTestDb(async (db, databaseUrl) => {
    await migrate(databaseUrl);

    // Mock target endpoint on loopback; allowed only via the explicit non-production mock policy.
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/health") return new Response("ok", { status: 200 });
        return new Response("err", { status: 503 });
      },
    });
    const hub = await startHub(databaseUrl);
    try {
      const targetUrl = `http://127.0.0.1:${target.port}/health`;

      // Unauthenticated access is rejected.
      expect((await hub.request("/api/endpoints", "POST", { name: "x", targetUrl })).status).toBe(401);
      await hub.login();

      // SSRF policy rejects private/metadata targets at creation time.
      const rejected = await hub.request("/api/endpoints", "POST", {
        name: "metadata",
        targetUrl: "http://169.254.169.254/latest/meta-data/",
      });
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).code).toBe("invalid_target");
      const rejectedCgnat = await hub.request("/api/endpoints", "POST", {
        name: "cgnat",
        targetUrl: "http://100.64.0.1/",
      });
      expect((await rejectedCgnat.json()).code).toBe("invalid_target");
      const rejectedMapped = await hub.request("/api/endpoints", "POST", {
        name: "mapped",
        targetUrl: "http://[::ffff:10.0.0.1]/",
      });
      expect((await rejectedMapped.json()).code).toBe("invalid_target");
      const badPayload = await hub.request("/api/endpoints", "POST", { name: "", targetUrl });
      expect(badPayload.status).toBe(400);

      // Create persists configuration with a server-side named probe location.
      const created = await hub.request("/api/endpoints", "POST", {
        name: "storefront-api",
        serviceName: "storefront",
        targetUrl,
        expectedStatus: 200,
        checkIntervalSeconds: 15,
      });
      expect(created.status).toBe(201);
      const endpoint = (await created.json()).endpoint;
      expect(endpoint.name).toBe("storefront-api");
      expect(endpoint.probe_location).toBe("hub-local");
      expect(endpoint.enabled).toBe(true);
      expect(endpoint.check_interval_seconds).toBe(15);
      expect(endpoint.run_counts).toEqual({ total: 0, up: 0, down: 0 });
      expect(endpoint.last_status).toBe("unknown");
      const id = endpoint.id;

      // Creation is audited without leaking the target URL.
      const audits = await db<{ action: string; target_id: string; data: unknown }[]>`
        SELECT action,target_id,data FROM audit_events WHERE target_id=${id} ORDER BY id`;
      expect(audits.map((a) => a.action)).toContain("endpoint.created");
      const createdAudit = audits.find((a) => a.action === "endpoint.created")!;
      expect(JSON.stringify(createdAudit.data)).not.toContain(targetUrl);
      expect(JSON.stringify(createdAudit.data)).not.toContain("target_url");

      // Listing returns the monitor with correctly scoped aggregate counts.
      const list = await hub.request("/api/services");
      const endpoints = (await list.json()).endpoints;
      const listed = endpoints.find((e: { id: string }) => e.id === id);
      expect(listed.run_counts).toEqual({ total: 0, up: 0, down: 0 });

      // Manual probe persists a run row with source timestamps and audits the action.
      const checked = await hub.request(`/api/endpoints/${id}/check`, "POST");
      expect(checked.status).toBe(200);
      const afterCheck = (await checked.json()).endpoint;
      expect(afterCheck.last_status).toBe("up");
      expect(afterCheck.last_http_status).toBe(200);
      expect(afterCheck.last_checked_at).not.toBeNull();
      expect(afterCheck.run_counts).toEqual({ total: 1, up: 1, down: 0 });

      const runs = await hub.request(`/api/endpoints/${id}/runs`);
      const runsPayload = await runs.json();
      expect(runsPayload.runs.length).toBe(1);
      expect(runsPayload.runs[0].probe_location).toBe("hub-local");
      expect(runsPayload.runs[0].status).toBe("up");
      expect(Date.parse(runsPayload.runs[0].started_at)).toBeLessThanOrEqual(
        Date.parse(runsPayload.runs[0].finished_at),
      );

      const probeAudits = await db<{ action: string; data: { manual: boolean } }[]>`
        SELECT action,data FROM audit_events WHERE target_id=${id} AND action='endpoint.probe'`;
      expect(probeAudits.length).toBe(1);
      expect(probeAudits[0].data.manual).toBe(true);

      // PATCH updates configuration, rejects unsafe targets and audits changed fields.
      const patched = await hub.request(`/api/endpoints/${id}`, "PATCH", {
        checkIntervalSeconds: 30,
        enabled: true,
      });
      expect(patched.status).toBe(200);
      expect((await patched.json()).endpoint.check_interval_seconds).toBe(30);
      const patchAudits = await db<{ data: { changed: string[] } }[]>`
        SELECT data FROM audit_events WHERE target_id=${id} AND action='endpoint.updated'`;
      expect(patchAudits.length).toBe(1);
      expect(patchAudits[0].data.changed).toContain("checkIntervalSeconds");
      expect(JSON.stringify(patchAudits[0].data)).not.toContain("target_url");

      const badPatch = await hub.request(`/api/endpoints/${id}`, "PATCH", {
        targetUrl: "http://192.168.0.10/admin",
      });
      expect((await badPatch.json()).code).toBe("invalid_target");

      // Bounded scheduling: the worker module claims due monitors, probes and persists runs.
      // The manual probe just ran, so the 15s interval has not elapsed yet.
      expect(await runDueEndpointChecks(db, { env: mockEnv })).toBe(0);
      await db`UPDATE endpoint_monitors SET last_checked_at=NOW() - INTERVAL '1 minute' WHERE id=${id}`;
      expect(await runDueEndpointChecks(db, { env: mockEnv })).toBe(1);
      const [monitor] = await db<{ last_status: string; last_checked_at: Date }[]>`
        SELECT last_status,last_checked_at FROM endpoint_monitors WHERE id=${id}`;
      expect(monitor.last_status).toBe("up");
      const runRows = await db<{ probe_location: string; status: string; started_at: Date; finished_at: Date }[]>`
        SELECT probe_location,status,started_at,finished_at FROM endpoint_monitor_runs WHERE monitor_id=${id} ORDER BY started_at DESC LIMIT 1`;
      expect(runRows[0].probe_location).toBe("hub-local");
      expect(runRows[0].status).toBe("up");
      expect(runRows[0].started_at.getTime()).toBeLessThanOrEqual(runRows[0].finished_at.getTime());

      // A disabled monitor is never scheduled.
      await db`UPDATE endpoint_monitors SET enabled=false, last_checked_at=NULL WHERE id=${id}`;
      expect(await runDueEndpointChecks(db, { env: mockEnv })).toBe(0);
      await db`UPDATE endpoint_monitors SET enabled=true WHERE id=${id}`;

      // DELETE removes the monitor (runs cascade) and audits the action.
      const deleted = await hub.request(`/api/endpoints/${id}`, "DELETE");
      expect(deleted.status).toBe(200);
      const deleteAudits = await db<{ action: string }[]>`
        SELECT action FROM audit_events WHERE target_id=${id} AND action='endpoint.deleted'`;
      expect(deleteAudits.length).toBe(1);
      expect((await hub.request(`/api/endpoints/${id}/runs`)).status).toBe(404);
      const remaining = await db<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM endpoint_monitor_runs WHERE monitor_id=${id}`;
      expect(remaining[0].c).toBe(0);

      // Unknown ids are 404 on every sub-route.
      const unknown = "123e4567-e89b-42d3-a456-426614174000";
      expect((await hub.request(`/api/endpoints/${unknown}/check`, "POST")).status).toBe(404);
      expect((await hub.request(`/api/endpoints/${unknown}`, "PATCH", { enabled: false })).status).toBe(404);
      expect((await hub.request(`/api/endpoints/${unknown}`, "DELETE")).status).toBe(404);
    } finally {
      await hub.stop();
      await target.stop(true);
    }
  });
});
