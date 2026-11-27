import { expect, test } from "bun:test";

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
      const res = await fetch(`${baseUrl}/api/auth/me`, { signal: AbortSignal.timeout(300) });
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // keep polling until listener is ready
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for Hub listener");
}

async function authDisabled(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", `
    import { isAuthDisabled } from "./apps/hub/src/auth";
    console.log(JSON.stringify(isAuthDisabled(JSON.parse(process.argv[1]))));
  `, JSON.stringify(env)], {
    cwd: root,
    env: { PATH: process.env.PATH || "", NODE_ENV: "test", SESSION_SECRET: sessionSecret, DATABASE_URL: dummyDb },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return JSON.parse(stdout) as boolean;
}

test("isAuthDisabled only enables bypass in non-production with explicit 'true'", async () => {
  expect(await authDisabled({ NODE_ENV: "development" })).toBe(false);
  expect(await authDisabled({ NODE_ENV: "development", DISABLE_AUTH: "false" })).toBe(false);
  expect(await authDisabled({ NODE_ENV: "development", DISABLE_AUTH: "1" })).toBe(false);
  expect(await authDisabled({ NODE_ENV: "development", DISABLE_AUTH: "true" })).toBe(true);
  expect(await authDisabled({ DISABLE_AUTH: "true" })).toBe(true);
  await expect(authDisabled({ NODE_ENV: "production", DISABLE_AUTH: "true" })).rejects.toThrow(
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

test.each(["missing", "invalid", "loopback"])("Hub starts and fails the public installer closed with %s HTTPS configuration", async (scenario) => {
  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const hub = spawnHub({
    PORT: String(port),
    NODE_ENV: "development",
    DISABLE_AUTH: "false",
    SESSION_SECRET: sessionSecret,
    ...(scenario === "loopback" ? {
      OPSPILOT_DEV_LOOPBACK_INSTALL: "true",
      OPSPILOT_PUBLIC_HUB_URL: baseUrl,
      OPSPILOT_AGENT_VERSION: "v0.1.0-rc.2",
    } : scenario === "invalid" ? {
      OPSPILOT_PUBLIC_HUB_URL: "https://hub.example%27",
      OPSPILOT_AGENT_VERSION: "v0.1.0-rc.2",
    } : {}),
  });
  try {
    await waitHubReady(baseUrl, hub.child);
    const me = await fetch(`${baseUrl}/api/auth/me`);
    expect(me.status).toBe(401);
    const installConfig = await fetch(`${baseUrl}/api/agents/install-config`);
    expect(installConfig.status).toBe(401);
    const installer = await fetch(`${baseUrl}/api/agents/install.sh`);
    expect(installer.status).toBe(503);
    expect(await installer.json()).toEqual({ error: "HTTPS agent installation is not configured" });
  } finally {
    await hub.stop();
  }
});

test("public HTTPS installer uses deployment settings, never request metadata", async () => {
  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const hub = spawnHub({
    PORT: String(port),
    NODE_ENV: "development",
    SESSION_SECRET: sessionSecret,
    OPSPILOT_PUBLIC_HUB_URL: "https://Hub.Example:8443/",
    OPSPILOT_AGENT_VERSION: "v1.2.3-rc.2",
    OPSPILOT_AGENT_REPOSITORY: "reviewed-org/agent.repo",
  });
  try {
    await waitHubReady(baseUrl, hub.child);
    const endpoint = `${baseUrl}/api/agents/install.sh`;
    const response = await fetch(endpoint);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const script = await response.text();
    expect(script).toContain("hub_url='https://hub.example:8443' version='v1.2.3-rc.2' repository='reviewed-org/agent.repo'");
    expect(script).not.toContain(sessionSecret);

    const headers = {
      host: "untrusted.invalid",
      forwarded: "host=untrusted.invalid;proto=http",
      "x-forwarded-host": "untrusted.invalid",
      "x-forwarded-proto": "http",
      origin: "http://untrusted.invalid",
      "user-agent": "Linux aarch64",
    };
    const hostile = await fetch(`${endpoint}?arch=arm64&version=v99.0.0`, { headers });
    expect(hostile.status).toBe(200);
    expect(await hostile.text()).toBe(script);
    const post = await fetch(endpoint, { method: "POST", headers });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
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
