import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

/**
 * TLS / WSS coverage for the Phase 4 reference deployment:
 *  - A TLS-terminating WSS endpoint (as the reverse proxy presents it) completes a
 *    hello/hello_ack exchange only when the client trusts the CA (positive), and rejects
 *    clients that do not (negative — proves no InsecureSkipVerify-style bypass).
 *  - The Hub issues Secure cookies when COOKIE_SECURE=true and tolerates the
 *    X-Forwarded-Proto / X-Forwarded-For headers a reverse proxy adds.
 *
 * The agent-side wss:// dialer (OPSPILOT_CA_CERT_FILE) is covered by
 * agent/internal/agent/tls_wss_test.go.
 */

const integration = providerTestDatabaseAvailable ? test : test.skip;
const root = new URL("../", import.meta.url).pathname;
const password = "disposable-tls-wss-integration";

let certDir: string;
const servers: { stop: () => void }[] = [];

beforeAll(async () => {
  certDir = await mkdtemp(join(tmpdir(), "opspilot-tls-test-"));
  const run = (args: string[]) => {
    const proc = Bun.spawnSync(["openssl", ...args], { cwd: certDir, stderr: "pipe" });
    if (!proc.success) throw new Error(`openssl ${args[0]} failed: ${proc.stderr.toString()}`);
  };
  run(["req", "-x509", "-newkey", "rsa:2048", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-nodes", "-subj", "/CN=opspilot-test-ca"]);
  run(["req", "-newkey", "rsa:2048", "-keyout", "server.key", "-out", "server.csr", "-nodes", "-subj", "/CN=localhost"]);
  await Bun.write(join(certDir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  run(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "1", "-extfile", "ext.cnf"]);
});

afterAll(async () => {
  for (const s of servers) s.stop();
  await rm(certDir, { recursive: true, force: true });
});

type WssServer = { url: string; port: number; stop: () => void };

/** Minimal TLS + WebSocket server mimicking the Hub control socket behind a proxy. */
async function startWssServer(): Promise<WssServer> {
  const cert = await Bun.file(join(certDir, "server.pem")).text();
  const key = await Bun.file(join(certDir, "server.key")).text();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert, key },
    fetch(req, server) {
      if (req.url.endsWith("/api/agents/connect") && server.upgrade(req)) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, msg) {
        const hello = JSON.parse(String(msg));
        if (hello.type === "hello") {
          ws.send(JSON.stringify({ type: "hello_ack", protocolVersion: hello.protocolVersion, capabilities: ["telemetry"] }));
        }
      },
    },
  });
  const wss: WssServer = { url: `wss://127.0.0.1:${server.port}/api/agents/connect`, port: server.port, stop: () => server.stop() };
  servers.push(wss);
  return wss;
}

/** Runs a wss:// client in a subprocess so NODE_EXTRA_CA_CERTS is picked up at startup. */
async function wssClientRoundTrip(url: string, caFile: string | null): Promise<{ ok: boolean; ack: unknown; error?: string }> {
  const script = `
    const ws = new WebSocket(${JSON.stringify(url)});
    const done = (v) => { console.log(JSON.stringify(v)); process.exit(0); };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", protocolVersion: 2, capabilities: ["telemetry"] })));
    ws.addEventListener("message", (m) => done({ ok: true, ack: JSON.parse(String(m.data)) }));
    ws.addEventListener("error", () => done({ ok: false, error: "tls or upgrade failed" }));
    setTimeout(() => done({ ok: false, error: "timeout" }), 4000);
  `;
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (caFile) env.NODE_EXTRA_CA_CERTS = caFile;
  // Async spawn: the WSS server lives in this same process, so spawnSync would deadlock.
  const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim().split("\n").pop() ?? "{}";
  await proc.exited;
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, ack: null, error: (await new Response(proc.stderr).text()).slice(0, 200) };
  }
}

test("positive: wss:// hello/hello_ack round trip when the client trusts the CA", async () => {
  const wss = await startWssServer();
  const result = await wssClientRoundTrip(wss.url, join(certDir, "ca.pem"));
  expect(result.ok).toBe(true);
  expect(result.ack).toEqual({ type: "hello_ack", protocolVersion: 2, capabilities: ["telemetry"] });
});

test("negative: wss:// connection without the trusted CA fails TLS verification", async () => {
  const wss = await startWssServer();
  const result = await wssClientRoundTrip(wss.url, null);
  expect(result.ok).toBe(false);
});

test("TLS handshake verifies only with the trusted CA (openssl s_client)", async () => {
  const wss = await startWssServer();
  // s_client stays connected after the handshake; read output until the verification line
  // appears, then kill it.
  const probe = async (extra: string[]) => {
    const proc = Bun.spawn(["openssl", "s_client", "-connect", `127.0.0.1:${wss.port}`, "-verify_return_error", "-brief", ...extra], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !out.includes("Verification")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
    proc.kill();
    await proc.exited;
    return out + (await new Response(proc.stderr).text());
  };
  const untrusted = await probe([]);
  expect(untrusted).not.toContain("Verification: OK");
  const trusted = await probe(["-CAfile", join(certDir, "ca.pem")]);
  expect(trusted).toContain("Verification: OK");
}, 10_000);

// --- Hub behavior behind the TLS reverse proxy (needs a test database) ---

type Hub = {
  base: string;
  api: (path: string, init?: { body?: unknown; headers?: Record<string, string> }) => Promise<Response>;
  stop: () => Promise<void>;
};

async function startHub(databaseUrl: string, cookieSecure: boolean): Promise<Hub> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    const serve = Bun.serve;
    Bun.serve = options => serve({...options, hostname: "127.0.0.1"});
    await import("./apps/hub/src/index.ts");
  `], {
    cwd: root, stdout: "pipe", stderr: "inherit",
    env: {
      DATABASE_URL: databaseUrl, PORT: "0", NODE_ENV: "development", ADMIN_PASSWORD: password,
      SESSION_SECRET: "disposable-tls-wss-cookie-secret", COOKIE_SECURE: cookieSecure ? "true" : "false",
    },
  });
  const stdout = child.stdout.getReader();
  const startup = await stdout.read();
  await stdout.cancel();
  const port = new TextDecoder().decode(startup.value).match(/localhost:(\d+)/)?.[1];
  if (!port) throw new Error("Hub did not announce its test port");
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    api: (path, init = {}) => fetch(base + path, {
      signal: AbortSignal.timeout(3000),
      headers: { "content-type": "application/json", ...init.headers },
      method: init.body === undefined ? "GET" : "POST",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    stop: async () => { child.kill(); await child.exited; },
  };
}

async function migrate(databaseUrl: string) {
  const migration = Bun.spawnSync([process.execPath, "--no-env-file", "tools/migrate.ts"], {
    cwd: root, env: { DATABASE_URL: databaseUrl }, timeout: 15_000,
  });
  if (!migration.success) throw new Error(`Migration failed: ${migration.stderr.toString()}`);
}

integration("hub issues Secure cookies with COOKIE_SECURE=true and handles proxy headers cleanly", async () => {
  await withProviderTestDb(async (db, databaseUrl) => {
    await migrate(databaseUrl);
    const secureHub = await startHub(databaseUrl, true);
    const plainHub = await startHub(databaseUrl, false);
    try {
      const secureLogin = await secureHub.api("/api/auth/login", { body: { password } });
      expect(secureLogin.status).toBe(200);
      const secureCookie = secureLogin.headers.get("set-cookie") ?? "";
      expect(secureCookie).toContain("Secure");
      expect(secureCookie).toContain("HttpOnly");

      const plainLogin = await plainHub.api("/api/auth/login", { body: { password } });
      expect(plainLogin.status).toBe(200);
      expect(plainLogin.headers.get("set-cookie") ?? "").not.toContain("Secure");

      // A reverse proxy adds forwarding headers; the Hub must accept them without treating
      // them as credentials or breaking authentication.
      const cookie = secureCookie.split(";")[0];
      const proxied = await secureHub.api("/api/hosts", { headers: {
        cookie,
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.10",
        host: "ops.example.com",
      } });
      expect(proxied.status).toBe(200);

      // Forwarded headers alone are not credentials.
      const spoofed = await secureHub.api("/api/hosts", { headers: {
        "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.10",
      } });
      expect(spoofed.status).toBe(401);
    } finally {
      await secureHub.stop();
      await plainHub.stop();
    }
  });
});
