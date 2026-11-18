import { expect, test } from "bun:test";
import { isAuthDisabled } from "../apps/hub/src/auth";

const root = new URL("../", import.meta.url).pathname;
const origin = "http://localhost:3100";
const sessionSecret = "opspilot-auth-test-session-secret-32-chars";
const dummyDb = "postgres://opspilot:opspilot@127.0.0.1:5433/opspilot";

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

function spawnHub(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "apps/hub/src/index.ts"], {
    cwd: root,
    env: {
      PATH: process.env.PATH || "",
      DATABASE_URL: dummyDb,
      ALLOWED_ORIGIN: origin,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  return {
    child,
    async waitExit() {
      const code = await child.exited;
      return { code, output: `${await stdout}\n${await stderr}` };
    },
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      return `${await stdout}\n${await stderr}`;
    },
  };
}

async function waitHubReady(baseUrl: string, child: Bun.Subprocess) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Hub exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/agents/install.sh`, { signal: AbortSignal.timeout(300) });
      if (res.status === 200) return;
    } catch {
      // keep polling until listener is ready
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for Hub listener");
}

test("isAuthDisabled only enables bypass in non-production with explicit 'true'", () => {
  expect(isAuthDisabled({ NODE_ENV: "development" })).toBe(false);
  expect(isAuthDisabled({ NODE_ENV: "development", DISABLE_AUTH: "false" })).toBe(false);
  expect(isAuthDisabled({ NODE_ENV: "development", DISABLE_AUTH: "1" })).toBe(false);
  expect(isAuthDisabled({ NODE_ENV: "development", DISABLE_AUTH: "true" })).toBe(true);
  expect(isAuthDisabled({ DISABLE_AUTH: "true" })).toBe(true);
  expect(() => isAuthDisabled({ NODE_ENV: "production", DISABLE_AUTH: "true" })).toThrow(
    "DISABLE_AUTH cannot be enabled in production",
  );
});

test("Hub refuses to start in production when DISABLE_AUTH=true", async () => {
  const hub = spawnHub({
    PORT: String(freePort()),
    NODE_ENV: "production",
    DISABLE_AUTH: "true",
    ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    SESSION_SECRET: sessionSecret,
  });
  const result = await hub.waitExit();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("DISABLE_AUTH cannot be enabled in production");
});

test("Hub refuses to start without SESSION_SECRET when auth is enabled", async () => {
  const hub = spawnHub({
    PORT: String(freePort()),
    NODE_ENV: "development",
    DISABLE_AUTH: "false",
  });
  const result = await hub.waitExit();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("SESSION_SECRET must have >= 32 chars");
});

test("Hub enforces 401 on admin routes when DISABLE_AUTH is false", async () => {
  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const hub = spawnHub({
    PORT: String(port),
    NODE_ENV: "development",
    DISABLE_AUTH: "false",
    SESSION_SECRET: sessionSecret,
  });
  try {
    await waitHubReady(baseUrl, hub.child);
    const me = await fetch(`${baseUrl}/api/auth/me`);
    expect(me.status).toBe(401);
    const installConfig = await fetch(`${baseUrl}/api/agents/install-config`);
    expect(installConfig.status).toBe(401);
  } finally {
    await hub.stop();
  }
});

test("Hub bypasses admin session auth in dev when DISABLE_AUTH=true while preserving Origin and agent checks", async () => {
  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const hub = spawnHub({
    PORT: String(port),
    NODE_ENV: "development",
    DISABLE_AUTH: "true",
  });
  try {
    await waitHubReady(baseUrl, hub.child);

    const me = await fetch(`${baseUrl}/api/auth/me`);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ authenticated: true, role: "admin", authDisabled: true });

    const installConfig = await fetch(`${baseUrl}/api/agents/install-config`);
    expect(installConfig.status).toBe(503);

    const loginOk = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(loginOk.status).toBe(200);
    expect(await loginOk.json()).toEqual({ ok: true, authDisabled: true });

    const loginBadOrigin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { origin: "http://evil.invalid", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(loginBadOrigin.status).toBe(403);

    const enrollBadOrigin = await fetch(`${baseUrl}/api/agents/enroll`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token: "t", hostname: "h" }),
    });
    expect(enrollBadOrigin.status).toBe(403);
  } finally {
    await hub.stop();
  }
});
