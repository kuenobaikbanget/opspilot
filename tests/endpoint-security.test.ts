import { expect, test } from "bun:test";
import {
  parseCreateEndpointMonitorRequest,
  parseUpdateEndpointMonitorRequest,
  validateEndpointTargetUrl,
} from "../packages/contracts/src/index";
import { probeEndpointTarget } from "../packages/ai/src/endpoint-probe";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

const mockEnv = { NODE_ENV: "development", OPSPILOT_ALLOW_LOOPBACK_PROBES: "true" };
const prodEnv = { NODE_ENV: "production", OPSPILOT_ALLOW_LOOPBACK_PROBES: "true" };

test("endpoint URL validation rejects unsafe schemes, credentials, fragments and oversized URLs", () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/health",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "gopher://127.0.0.1/",
    "https://user:pass@example.com/health",
    "https://example.com/health#frag",
    `https://example.com/${"x".repeat(2100)}`,
    "https://example.com:abc/health",
    "not a url",
    "",
  ]) {
    expect(validateEndpointTargetUrl(url)).toBeNull();
  }
});

test("endpoint URL validation blocks loopback, private, CGNAT, link-local/metadata, multicast and reserved IPv4", () => {
  for (const url of [
    "http://0.0.0.0/health",
    "https://10.0.0.5/health",
    "https://172.16.0.1/health",
    "https://172.31.255.255/health",
    "https://192.168.1.10/health",
    "http://100.64.0.1/health",
    "http://100.127.255.255/health",
    "http://169.254.169.254/latest/meta-data/",
    "http://198.18.0.1/health",
    "http://192.0.2.1/health",
    "http://203.0.113.1/health",
    "http://224.0.0.1/health",
    "http://240.0.0.1/health",
    "https://localhost/health",
    "https://foo.localhost/health",
    "https://localhost./health",
    "https://metadata.google.internal/computeMetadata/v1/",
  ]) {
    expect(validateEndpointTargetUrl(url)).toBeNull();
    // The non-production loopback mock must never widen access to non-loopback ranges.
    expect(validateEndpointTargetUrl(url, { allowLoopbackMock: true })).toBeNull();
  }
  // Alternate loopback encodings normalize to 127.0.0.1: blocked without the mock,
  // allowed only by the explicit mock policy.
  for (const url of [
    "http://127.0.0.1:4101/health",
    "http://127.1/health",
    "http://2130706433/health",
    "http://0x7f000001/health",
    "http://0177.0.0.1/health",
  ]) {
    expect(validateEndpointTargetUrl(url)).toBeNull();
  }
  expect(validateEndpointTargetUrl("http://127.0.0.1:4101/health", { allowLoopbackMock: true })).toBe(
    "http://127.0.0.1:4101/health",
  );
  // 172.32.0.1 is outside 172.16.0.0/12 and therefore public.
  expect(validateEndpointTargetUrl("http://172.32.0.1/health")).toBe("http://172.32.0.1/health");
  expect(validateEndpointTargetUrl("https://8.8.8.8/health")).toBe("https://8.8.8.8/health");
  expect(validateEndpointTargetUrl("https://api.example.com/health")).toBe("https://api.example.com/health");
  expect(validateEndpointTargetUrl("http://example.com/health")).toBe("http://example.com/health");
});

test("endpoint URL validation blocks IPv6 loopback, link-local, ULA, multicast, mapped and special ranges", () => {
  for (const url of [
    "http://[::]/health",
    "http://[fe80::1]/health",
    "http://[fe80::1%25eth0]/health",
    "http://[fc00::1]/health",
    "http://[fd12:3456::1]/health",
    "http://[ff02::1]/health",
    "http://[2001:db8::1]/health",
    "http://[2002:7f00:1::]/health",
    "http://[2620:4f:8000::1]/health",
    "http://[3fff::1]/health",
    "http://[::ffff:10.0.0.1]/health",
    "http://[::ffff:a9fe:a9fe]/health",
    "http://[64:ff9b::7f00:1]/health",
    "http://[64:ff9b::a00:1]/health",
  ]) {
    expect(validateEndpointTargetUrl(url)).toBeNull();
    expect(validateEndpointTargetUrl(url, { allowLoopbackMock: true })).toBeNull();
  }
  // Loopback literals stay blocked without the mock and are allowed only by the mock.
  expect(validateEndpointTargetUrl("http://[::1]/health")).toBeNull();
  expect(validateEndpointTargetUrl("http://[::ffff:127.0.0.1]/health")).toBeNull();
  expect(validateEndpointTargetUrl("http://[2606:4700:4700::1111]/health")).toBe(
    "http://[2606:4700:4700::1111]/health",
  );
  expect(validateEndpointTargetUrl("http://[::1]/health", { allowLoopbackMock: true })).toBe(
    "http://[::1]/health",
  );
  expect(validateEndpointTargetUrl("http://[::ffff:127.0.0.1]/health", { allowLoopbackMock: true })).toBe(
    "http://[::ffff:7f00:1]/health",
  );
});

test("endpoint monitor payload parsing enforces structural bounds", () => {
  expect(parseCreateEndpointMonitorRequest(null)).toBeNull();
  expect(parseCreateEndpointMonitorRequest({ name: "", targetUrl: "https://example.com" })).toBeNull();
  expect(parseCreateEndpointMonitorRequest({ name: "x".repeat(81), targetUrl: "https://example.com" })).toBeNull();
  expect(
    parseCreateEndpointMonitorRequest({ name: "api", targetUrl: "https://example.com", expectedStatus: 99 }),
  ).toBeNull();
  expect(
    parseCreateEndpointMonitorRequest({ name: "api", targetUrl: "https://example.com", expectedStatus: 600 }),
  ).toBeNull();
  expect(
    parseCreateEndpointMonitorRequest({ name: "api", targetUrl: "https://example.com", checkIntervalSeconds: 5 }),
  ).toBeNull();
  expect(
    parseCreateEndpointMonitorRequest({ name: "api", targetUrl: "https://example.com", checkIntervalSeconds: 90000 }),
  ).toBeNull();
  expect(
    parseCreateEndpointMonitorRequest({ name: "api", targetUrl: "https://example.com", enabled: "yes" }),
  ).toBeNull();
  expect(
    parseCreateEndpointMonitorRequest({ name: "api", targetUrl: "https://example.com", expectedStatus: 204 }),
  ).toEqual({
    name: "api",
    targetUrl: "https://example.com",
    expectedStatus: 204,
    agentId: null,
    serviceName: null,
    checkIntervalSeconds: 60,
    enabled: true,
  });
  expect(parseUpdateEndpointMonitorRequest({})).toBeNull();
  expect(parseUpdateEndpointMonitorRequest({ enabled: false })).toEqual({ enabled: false });
  expect(parseUpdateEndpointMonitorRequest({ checkIntervalSeconds: 14 })).toBeNull();
});

test("probe blocks DNS answers that resolve to private or metadata addresses (rebinding defense)", async () => {
  const privateLookup = async () => [{ address: "10.0.0.5", family: 4 as const }];
  const metadataLookup = async () => [{ address: "169.254.169.254", family: 4 as const }];
  const cgnatLookup = async () => [{ address: "100.64.0.9", family: 4 as const }];
  const ipv6Lookup = async () => [{ address: "fe80::1", family: 6 as const }];
  const mappedPrivateLookup = async () => [{ address: "::ffff:a00:1", family: 6 as const }];
  const mixedLookup = async () => [
    { address: "93.184.216.34", family: 4 as const },
    { address: "192.168.0.1", family: 4 as const },
  ];
  for (const resolve of [
    privateLookup,
    metadataLookup,
    cgnatLookup,
    ipv6Lookup,
    mappedPrivateLookup,
    mixedLookup,
  ]) {
    // Even with the loopback mock enabled, non-loopback answers must be rejected.
    const result = await probeEndpointTarget("http://rebind.example/health", 200, mockEnv, { resolve });
    expect(result.status).toBe("down");
    expect(result.error).toBe("dns_blocked");
    expect(result.httpStatus).toBeNull();
  }
  const failingLookup = async () => {
    throw new Error("NXDOMAIN");
  };
  const failed = await probeEndpointTarget("http://nx.example/health", 200, mockEnv, {
    resolve: failingLookup,
  });
  expect(failed.error).toBe("dns_blocked");
});

test("probe validates every redirect hop and bounds the redirect count", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const pathname = new URL(req.url).pathname;
      if (pathname === "/ok") return new Response("ok", { status: 200 });
      if (pathname === "/redir-ok") return Response.redirect(`http://127.0.0.1:${server.port}/ok`, 302);
      if (pathname === "/redir-private") return Response.redirect("http://169.254.169.254/latest/meta-data/", 302);
      if (pathname === "/redir-cgnat") return Response.redirect("http://100.64.0.1/", 301);
      if (pathname === "/redir-scheme") return Response.redirect("file:///etc/passwd", 302);
      if (pathname === "/loop") return Response.redirect(`http://127.0.0.1:${server.port}/loop`, 302);
      return new Response("x", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const followed = await probeEndpointTarget(`${base}/redir-ok`, 200, mockEnv);
    expect(followed.status).toBe("up");
    expect(followed.httpStatus).toBe(200);

    const toPrivate = await probeEndpointTarget(`${base}/redir-private`, 200, mockEnv);
    expect(toPrivate.status).toBe("down");
    expect(toPrivate.error).toBe("redirect_blocked");

    const toCgnat = await probeEndpointTarget(`${base}/redir-cgnat`, 200, mockEnv);
    expect(toCgnat.error).toBe("redirect_blocked");

    const toFile = await probeEndpointTarget(`${base}/redir-scheme`, 200, mockEnv);
    expect(toFile.error).toBe("redirect_blocked");

    const loop = await probeEndpointTarget(`${base}/loop`, 200, mockEnv);
    expect(loop.status).toBe("down");
    expect(loop.error).toBe("redirect_limit");
    expect(loop.httpStatus).toBe(302);
  } finally {
    await server.stop(true);
  }
});

test("probe enforces strict timeouts and response body read cap", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const pathname = new URL(req.url).pathname;
      if (pathname === "/hang") return new Promise<Response>(() => {});
      if (pathname === "/slow-redir-1") {
        return Bun.sleep(120).then(() => Response.redirect(`http://127.0.0.1:${server.port}/slow-redir-2`, 302));
      }
      if (pathname === "/slow-redir-2") {
        return Bun.sleep(120).then(() => Response.redirect(`http://127.0.0.1:${server.port}/slow-redir-3`, 302));
      }
      if (pathname === "/slow-redir-3") {
        return Bun.sleep(120).then(() => new Response("ok", { status: 200 }));
      }
      if (pathname === "/big") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
            // Never ends; the probe must stop reading after the cap.
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response("ok", { status: 200 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const timeout = await probeEndpointTarget(`${base}/hang`, 200, mockEnv, {
      totalTimeoutMs: 250,
      connectTimeoutMs: 250,
    });
    expect(timeout.status).toBe("down");
    expect(timeout.error).toBe("timeout");
    expect(timeout.latencyMs).toBeLessThan(2000);

    // Cumulative timeout across redirects: 3 hops x 120ms = 360ms must exceed a 250ms total budget.
    const redirectTimeout = await probeEndpointTarget(`${base}/slow-redir-1`, 200, mockEnv, {
      totalTimeoutMs: 250,
      connectTimeoutMs: 250,
    });
    expect(redirectTimeout.status).toBe("down");
    expect(redirectTimeout.error).toBe("timeout");
    expect(redirectTimeout.latencyMs).toBeLessThan(350);

    const big = await probeEndpointTarget(`${base}/big`, 200, mockEnv, { totalTimeoutMs: 3000 });
    expect(big.status).toBe("up");
    expect(big.httpStatus).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("probe rejects blocked targets, production loopback and disabled TLS verification", async () => {
  expect((await probeEndpointTarget("http://169.254.169.254/latest/", 200, mockEnv)).error).toBe(
    "blocked_target",
  );
  expect((await probeEndpointTarget("file:///etc/passwd", 200, mockEnv)).error).toBe("blocked_target");

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  try {
    const url = `http://127.0.0.1:${server.port}/ok`;
    expect((await probeEndpointTarget(url, 200, prodEnv)).error).toBe("blocked_target");
    expect(
      (await probeEndpointTarget(url, 200, { ...mockEnv, NODE_TLS_REJECT_UNAUTHORIZED: "0" })).error,
    ).toBe("tls_verification_disabled");
    const up = await probeEndpointTarget(url, 200, mockEnv);
    expect(up.status).toBe("up");
    expect(up.latencyMs).not.toBeNull();
  } finally {
    await server.stop(true);
  }
});

const root = new URL("../", import.meta.url).pathname;
const origin = "http://localhost:3100";
const sessionSecret = "opspilot-endpoint-security-session-secret-32";
const password = "opspilot-endpoint-security-password";

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

async function migrate(databaseUrl: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "tools/migrate.ts"], {
    cwd: root,
    env: { DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`Migration failed with code ${code}: ${await new Response(child.stderr).text()}`);
  }
}

async function startHub(databaseUrl: string) {
  const port = freePort();
  const child = Bun.spawn([process.execPath, "--no-env-file", "apps/hub/src/index.ts"], {
    cwd: root,
    env: {
      NODE_ENV: "development",
      DATABASE_URL: databaseUrl,
      ADMIN_PASSWORD: password,
      SESSION_SECRET: sessionSecret,
      ALLOWED_ORIGIN: origin,
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  // Real OS-process supervision: fake timers cannot advance a child process,
  // so readiness is polled by condition with a short real backoff.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Hub exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/api/auth/me`, { signal: AbortSignal.timeout(300) });
      if (res.status === 200 || res.status === 401) break;
    } catch {
      // keep polling until the listener is ready
    }
    await Bun.sleep(25);
  }
  if (child.exitCode === null && Date.now() >= deadline) {
    throw new Error("Timed out waiting for Hub listener");
  }
  return {
    baseUrl,
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      // Real process supervision bound, same as tests/auth.test.ts.
      await Promise.race([
        child.exited,
        Bun.sleep(2000).then(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }),
      ]);
      await child.exited;
    },
  };
}

const integration = providerTestDatabaseAvailable ? test : test.skip;

integration("endpoint monitor routes require admin session and exact origin", async () => {
  await withProviderTestDb(async (_db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      const id = "123e4567-e89b-42d3-a456-426614174000";
      // Unauthenticated requests are rejected before any route logic or DB access.
      for (const [method, path] of [
        ["GET", "/api/services"],
        ["POST", "/api/endpoints"],
        ["PATCH", `/api/endpoints/${id}`],
        ["DELETE", `/api/endpoints/${id}`],
        ["POST", `/api/endpoints/${id}/check`],
        ["GET", `/api/endpoints/${id}/runs`],
      ] as const) {
        const res = await fetch(`${hub.baseUrl}${path}`, {
          method,
          headers: { "content-type": "application/json", origin },
          body: method === "GET" ? undefined : "{}",
        });
        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe("Unauthorized");
      }

      // Login establishes the admin session cookie.
      const login = await fetch(`${hub.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0];

      // Authenticated but cross-origin mutations are rejected.
      const crossOrigin = await fetch(`${hub.baseUrl}/api/endpoints`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example", cookie },
        body: JSON.stringify({ name: "x", targetUrl: "https://example.com/health" }),
      });
      expect(crossOrigin.status).toBe(403);
      expect((await crossOrigin.json()).code).toBe("forbidden_origin");

      const crossOriginCheck = await fetch(`${hub.baseUrl}/api/endpoints/${id}/check`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example", cookie },
        body: "{}",
      });
      expect(crossOriginCheck.status).toBe(403);
    } finally {
      await hub.stop();
    }
  });
});
