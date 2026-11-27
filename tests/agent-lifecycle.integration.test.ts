import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { authTestDatabaseAvailable, withAuthTestDb } from "./helpers/auth-test-db";
import { csrfFromLogin } from "./helpers/csrf";

// db.ts requires DATABASE_URL at import time; the pool is never used by these tests.
process.env.DATABASE_URL = "postgres://opspilot:opspilot@127.0.0.1:5433/opspilot";

const { hashSecret } = await import("../apps/hub/src/db");

const integration = authTestDatabaseAvailable ? test : test.skip;
const root = new URL("../", import.meta.url).pathname;
const origin = "http://localhost:3100";
const password = "opspilot-agent-lifecycle-integration-password";
const sessionSecret = "opspilot-agent-lifecycle-integration-session-secret";

type Spawned = {
  child: Bun.Subprocess;
  stop(): Promise<string>;
  finish(): Promise<{ code: number; output: string }>;
};

function spawn(script: string, env: Record<string, string>): Spawned {
  const child = Bun.spawn([process.execPath, "--no-env-file", script], {
    cwd: root, env: { PATH: process.env.PATH || "", ...env }, stdout: "pipe", stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let stopping: Promise<string> | undefined;
  return {
    child,
    stop(): Promise<string> {
      return stopping ??= (async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        try { await Promise.race([child.exited, Bun.sleep(2_000)]); } catch { /* ignore */ }
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        return `${await stdout}\n${await stderr}`;
      })();
    },
    async finish(): Promise<{ code: number; output: string }> {
      const code = await child.exited;
      return { code, output: `${await stdout}\n${await stderr}` };
    },
  };
}

function childEnv(databaseUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "development",
    DATABASE_URL: databaseUrl,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    COOKIE_SECURE: "false",
    ALLOWED_ORIGIN: origin,
    SESSION_IDLE_TIMEOUT_SECONDS: "60",
    ...extra,
  };
}

async function migrate(databaseUrl: string): Promise<void> {
  const migration = spawn("tools/migrate.ts", childEnv(databaseUrl));
  try {
    const result = await migration.finish();
    expect(result.code).toBe(0);
  } finally {
    await migration.stop();
  }
}

type Hub = {
  baseUrl: string;
  request(path: string, init?: {
    method?: string;
    body?: unknown;
    cookie?: string | null;
    csrf?: string | null;
    origin?: string | null;
    headers?: Record<string, string>;
  }): Promise<Response>;
  login(): Promise<{ cookie: string; csrf: string }>;
  stop(): Promise<string>;
};

async function startHub(databaseUrl: string, extra: Record<string, string> = {}): Promise<Hub> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const child = spawn("apps/hub/src/index.ts", { ...childEnv(databaseUrl, extra), PORT: String(port) });
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(path: string, init: {
    method?: string;
    body?: unknown;
    cookie?: string | null;
    csrf?: string | null;
    origin?: string | null;
    headers?: Record<string, string>;
  } = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers ?? {});
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.origin !== undefined) {
      if (init.origin !== null) headers.set("origin", init.origin);
    } else if (method !== "GET") {
      headers.set("origin", origin);
    }
    if (init.csrf) headers.set("x-opspilot-csrf", init.csrf);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(8_000),
    });
  }

  async function login(): Promise<{ cookie: string; csrf: string }> {
    const res = await request("/api/auth/login", { method: "POST", body: { password } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    return { cookie, csrf: csrfFromLogin(res) };
  }

  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.child.exitCode !== null) throw new Error(`Hub exited before startup: ${await child.stop()}`);
      try {
        if ((await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).ok) break;
      } catch { /* not ready yet */ }
      await Bun.sleep(30);
    }
    return { baseUrl, request, login, stop: child.stop };
  } catch (error) {
    await child.stop();
    throw error;
  }
}

async function enrollAgent(hub: Hub, admin: { cookie: string; csrf: string }, hostname: string) {
  const tokenRes = await hub.request("/api/agents/enrollment-token", {
    method: "POST", body: {}, cookie: admin.cookie, csrf: admin.csrf,
  });
  expect(tokenRes.status).toBe(201);
  const { token } = await tokenRes.json() as { token: string };
  const res = await hub.request("/api/agents/enroll", {
    method: "POST", body: { token, hostname }, origin: null,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { agentId: string; agentSecret: string };
}

type WsOutcome = { opened: boolean; code: number | null; reason: string };

function connectWs(hub: Hub, agentId: string, secret: string): Promise<WsOutcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${hub.baseUrl.replace("http", "ws")}/api/agents/connect`, {
      headers: { "x-opspilot-agent-id": agentId, authorization: `Bearer ${secret}` },
    });
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      resolve({ opened: false, code: null, reason: "timeout" });
    }, 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({ opened: true, code: null, reason: "" });
    });
    ws.addEventListener("error", () => {
      // Auth failure surfaces as an error/close without a successful open.
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ opened: false, code: event.code, reason: event.reason });
    });
  });
}

/** Waits for the close event of an already-open agent socket. */
function waitClose(ws: WebSocket, timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WS close")), timeoutMs);
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    });
  });
}

function openAgentWs(hub: Hub, agentId: string, secret: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${hub.baseUrl.replace("http", "ws")}/api/agents/connect`, {
      headers: { "x-opspilot-agent-id": agentId, authorization: `Bearer ${secret}` },
    });
    const timer = setTimeout(() => reject(new Error("timed out waiting for WS open")), 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      reject(new Error(`WS closed before open: ${event.code} ${event.reason}`));
    });
    ws.addEventListener("error", () => { /* close follows */ });
  });
}

integration("login issues session + CSRF cookies; mutations require the CSRF header and same origin", async () => {
  await withAuthTestDb(async (_db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      const admin = await hub.login();
      expect(admin.cookie).toContain("opspilot_session=");
      expect(admin.csrf).not.toBe("");

      const me = await hub.request("/api/auth/me", { cookie: admin.cookie });
      expect(me.status).toBe(200);

      // Missing CSRF header on a state-changing route -> 403.
      const noCsrf = await hub.request("/api/agents/enrollment-token", {
        method: "POST", body: {}, cookie: admin.cookie,
      });
      expect(noCsrf.status).toBe(403);
      expect((await noCsrf.json()).code).toBe("csrf_required");

      // Wrong CSRF token -> 403.
      const wrongCsrf = await hub.request("/api/agents/enrollment-token", {
        method: "POST", body: {}, cookie: admin.cookie, csrf: "wrong-token",
      });
      expect(wrongCsrf.status).toBe(403);

      // Correct CSRF token -> allowed.
      const ok = await hub.request("/api/agents/enrollment-token", {
        method: "POST", body: {}, cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(ok.status).toBe(201);

      // Cross-origin mutation with valid cookie+CSRF -> 403 forbidden_origin.
      const crossOrigin = await hub.request("/api/agents/enrollment-token", {
        method: "POST", body: {}, cookie: admin.cookie, csrf: admin.csrf, origin: "http://evil.example",
      });
      expect(crossOrigin.status).toBe(403);
      expect((await crossOrigin.json()).code).toBe("forbidden_origin");

      // Unauthenticated mutation -> 401 even with a CSRF header.
      const anon = await hub.request("/api/agents/enrollment-token", {
        method: "POST", body: {}, csrf: admin.csrf,
      });
      expect(anon.status).toBe(401);
    } finally {
      await hub.stop();
    }
  });
});

integration("login rate limit returns 429 with Retry-After", async () => {
  await withAuthTestDb(async (_db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl, {
      RATE_LIMIT_LOGIN_MAX: "3",
      RATE_LIMIT_LOGIN_WINDOW_MS: "60000",
    });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await hub.request("/api/auth/login", {
          method: "POST", body: { password: "wrong-password" },
        });
        expect(res.status).toBe(401);
      }
      const limited = await hub.request("/api/auth/login", { method: "POST", body: { password } });
      expect(limited.status).toBe(429);
      expect((await limited.json()).code).toBe("rate_limited");
      const retryAfter = Number(limited.headers.get("retry-after"));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    } finally {
      await hub.stop();
    }
  });
});

integration("state-changing admin APIs return 429 with Retry-After when the write budget is exhausted", async () => {
  await withAuthTestDb(async (_db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl, {
      RATE_LIMIT_ADMIN_MAX: "3",
      RATE_LIMIT_ADMIN_WINDOW_MS: "60000",
    });
    try {
      const admin = await hub.login();
      for (let i = 0; i < 3; i++) {
        const res = await hub.request("/api/agents/enrollment-token", {
          method: "POST", body: {}, cookie: admin.cookie, csrf: admin.csrf,
        });
        expect(res.status).toBe(201);
      }
      const limited = await hub.request("/api/agents/enrollment-token", {
        method: "POST", body: {}, cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(limited.status).toBe(429);
      expect((await limited.json()).code).toBe("rate_limited");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      // GET reads are not write-limited.
      expect((await hub.request("/api/auth/me", { cookie: admin.cookie })).status).toBe(200);
    } finally {
      await hub.stop();
    }
  });
});

integration("logout revokes the session server-side; a replayed cookie is rejected", async () => {
  await withAuthTestDb(async (_db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      const admin = await hub.login();
      const meBefore = await hub.request("/api/auth/me", { cookie: admin.cookie });
      expect(meBefore.status).toBe(200);

      const logout = await hub.request("/api/auth/logout", {
        method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(logout.status).toBe(200);
      // Both cookies are cleared.
      const setCookies = logout.headers.getSetCookie();
      expect(setCookies.some((c) => c.startsWith("opspilot_session=;"))).toBe(true);
      expect(setCookies.some((c) => c.startsWith("opspilot_csrf=;"))).toBe(true);

      // Replayed cookie after logout -> 401.
      const replayed = await hub.request("/api/auth/me", { cookie: admin.cookie });
      expect(replayed.status).toBe(401);
      const replayedWrite = await hub.request("/api/agents/enrollment-token", {
        method: "POST", body: {}, cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(replayedWrite.status).toBe(401);
    } finally {
      await hub.stop();
    }
  });
});

integration("sessions can be listed and revoked individually; logout-all revokes the rest", async () => {
  await withAuthTestDb(async (_db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      const a = await hub.login();
      const b = await hub.login();

      const listRes = await hub.request("/api/auth/sessions", { cookie: a.cookie });
      expect(listRes.status).toBe(200);
      const { sessions } = await listRes.json() as { sessions: { id: string; current: boolean; revoked_at: string | null }[] };
      expect(sessions.length).toBe(2);
      expect(sessions.filter((s) => s.current).length).toBe(1);
      expect(sessions.every((s) => s.revoked_at === null)).toBe(true);

      // Revoke B's session using A's session; invalid and unknown ids are rejected.
      const bSession = sessions.find((s) => !s.current)!;
      const badId = await hub.request(`/api/auth/sessions/not-a-uuid`, {
        method: "DELETE", cookie: a.cookie, csrf: a.csrf,
      });
      expect(badId.status).toBe(400);
      const unknown = await hub.request(`/api/auth/sessions/123e4567-e89b-42d3-a456-426614174000`, {
        method: "DELETE", cookie: a.cookie, csrf: a.csrf,
      });
      expect(unknown.status).toBe(404);
      const revoked = await hub.request(`/api/auth/sessions/${bSession.id}`, {
        method: "DELETE", cookie: a.cookie, csrf: a.csrf,
      });
      expect(revoked.status).toBe(200);
      // B's cookie is now dead; revoking again -> 404.
      const bMe = await hub.request("/api/auth/me", { cookie: b.cookie });
      expect(bMe.status).toBe(401);
      const again = await hub.request(`/api/auth/sessions/${bSession.id}`, {
        method: "DELETE", cookie: a.cookie, csrf: a.csrf,
      });
      expect(again.status).toBe(404);

      // logout-all revokes every other live session; the caller stays valid.
      const c = await hub.login();
      const all = await hub.request("/api/auth/logout-all", {
        method: "POST", cookie: c.cookie, csrf: c.csrf,
      });
      expect(all.status).toBe(200);
      expect((await all.json()).revoked).toBe(1);
      expect((await hub.request("/api/auth/me", { cookie: a.cookie })).status).toBe(401);
      expect((await hub.request("/api/auth/me", { cookie: c.cookie })).status).toBe(200);
    } finally {
      await hub.stop();
    }
  });
});

integration("expired and idle sessions are rejected server-side even with a valid signed cookie", async () => {
  await withAuthTestDb(async (db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      // Absolute expiry enforced by the DB row (token exp claim is still valid).
      const expired = await hub.login();
      await db`UPDATE sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE session_hash=${hashSecret(expired.cookie.split("=")[1]!)}`;
      expect((await hub.request("/api/auth/me", { cookie: expired.cookie })).status).toBe(401);

      // Idle timeout enforced via last_seen_at (SESSION_IDLE_TIMEOUT_SECONDS=60).
      const idle = await hub.login();
      await db`UPDATE sessions SET last_seen_at=NOW()-INTERVAL '2 hours' WHERE session_hash=${hashSecret(idle.cookie.split("=")[1]!)}`;
      expect((await hub.request("/api/auth/me", { cookie: idle.cookie })).status).toBe(401);

      // A fresh session still works.
      const fresh = await hub.login();
      expect((await hub.request("/api/auth/me", { cookie: fresh.cookie })).status).toBe(200);
    } finally {
      await hub.stop();
    }
  });
});

integration("agent revoke closes the live WebSocket and rejects all future auth", async () => {
  await withAuthTestDb(async (_db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      const admin = await hub.login();
      const agent = await enrollAgent(hub, admin, "revoke-target");

      // Bearer auth works before revocation.
      const ws = await openAgentWs(hub, agent.agentId, agent.agentSecret);
      const closed = waitClose(ws);

      const revoke = await hub.request(`/api/agents/${agent.agentId}/revoke`, {
        method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(revoke.status).toBe(200);
      expect((await revoke.json()).revoked).toBe(true);

      // The active WebSocket is closed immediately with the revoked close code.
      const { code, reason } = await closed;
      expect(code).toBe(4003);
      expect(reason).toContain("revoked");

      // Future HTTP and WS auth attempts with the same credential are rejected.
      const httpAuth = await hub.request("/api/agents/connect", {
        origin: null,
        headers: {
          "x-opspilot-agent-id": agent.agentId,
          authorization: `Bearer ${agent.agentSecret}`,
        },
      });
      expect(httpAuth.status).toBe(401);
      const wsAfter = await connectWs(hub, agent.agentId, agent.agentSecret);
      expect(wsAfter.opened).toBe(false);

      // Revoking again -> 404; malformed/unknown ids -> 400/404.
      const again = await hub.request(`/api/agents/${agent.agentId}/revoke`, {
        method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(again.status).toBe(404);
      const badId = await hub.request(`/api/agents/nope/revoke`, {
        method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(badId.status).toBe(400);
      const unknown = await hub.request(`/api/agents/123e4567-e89b-42d3-a456-426614174000/revoke`, {
        method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(unknown.status).toBe(404);
    } finally {
      await hub.stop();
    }
  });
});

integration("agent rotate swaps the credential immediately and disconnects stale sessions", async () => {
  await withAuthTestDb(async (_db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      const admin = await hub.login();
      const agent = await enrollAgent(hub, admin, "rotate-target");

      const ws = await openAgentWs(hub, agent.agentId, agent.agentSecret);
      const closed = waitClose(ws);

      const rotate = await hub.request(`/api/agents/${agent.agentId}/rotate`, {
        method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(rotate.status).toBe(200);
      const { agentSecret: newSecret } = (await rotate.json()) as { agentSecret: string };
      expect(newSecret).not.toBe(agent.agentSecret);

      // Stale WebSocket disconnected with the rotated close code.
      expect((await closed).code).toBe(4002);

      // Old secret rejected on HTTP and WS; new secret accepted.
      const oldHttp = await hub.request("/api/agents/connect", {
        origin: null,
        headers: { "x-opspilot-agent-id": agent.agentId, authorization: `Bearer ${agent.agentSecret}` },
      });
      expect(oldHttp.status).toBe(401);
      const oldWs = await connectWs(hub, agent.agentId, agent.agentSecret);
      expect(oldWs.opened).toBe(false);
      const newWs = await openAgentWs(hub, agent.agentId, newSecret);
      newWs.close();

      // Rotating an unknown agent -> 404; revoked agents stay revoked even after rotate.
      const unknown = await hub.request(`/api/agents/123e4567-e89b-42d3-a456-426614174000/rotate`, {
        method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(unknown.status).toBe(404);

      const revokedAgent = await enrollAgent(hub, admin, "rotate-revoked");
      expect((await hub.request(`/api/agents/${revokedAgent.agentId}/revoke`, {
        method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      })).status).toBe(200);
      const rotateRevoked = await hub.request(`/api/agents/${revokedAgent.agentId}/rotate`, {
        method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      });
      expect(rotateRevoked.status).toBe(200);
      const { agentSecret: revivedSecret } = (await rotateRevoked.json()) as { agentSecret: string };
      const revivedWs = await connectWs(hub, revokedAgent.agentId, revivedSecret);
      expect(revivedWs.opened).toBe(false);
    } finally {
      await hub.stop();
    }
  });
});
