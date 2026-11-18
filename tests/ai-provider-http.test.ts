import { expect, spyOn, test } from "bun:test";
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { createServer } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createProviderPost, normalizeProviderBaseUrl, ProviderError, type ProviderErrorCode } from "../packages/ai/src/provider-http";
import { FIXTURE_DUMMY_KEY, FIXTURE_PUBLIC_ADDRESS, fixtureCa, startProviderFixture } from "./helpers/provider-https-fixture";

async function failure(promise: Promise<unknown>, code: ProviderErrorCode, status?: number): Promise<ProviderError> {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ProviderError);
  const error = caught as ProviderError;
  expect(error.code).toBe(code);
  expect(error.httpStatus).toBe(status);
  for (const text of [String(error), JSON.stringify(error), error.stack ?? ""]) {
    expect(text).not.toContain(FIXTURE_DUMMY_KEY);
    expect(text).not.toContain("private upstream body");
    expect(text).not.toContain("https://provider.example");
  }
  return error;
}

const headers = { Authorization: `Bearer ${FIXTURE_DUMMY_KEY}` };
const forbiddenEndpoints = [
  "http://provider.example/v1", "ftp://provider.example/v1", "https://user:pass@provider.example/v1",
  "https://provider.example/v1?secret=1", "https://provider.example/v1#secret", "https://provider.example/v1?", "https://provider.example/v1#",
  "https://provider.example:0/v1", "https://provider.example:65536/v1", "https://[fe80::1%25eth0]/v1",
  "https://localhost/v1", "https://service.localhost/v1", "https://LOCALHOST./v1",
  "https://127.0.0.1/v1", "https://2130706433/v1", "https://0x7f000001/v1", "https://0177.0.0.1/v1",
  "https://[::1]/v1", "https://[::ffff:127.0.0.1]/v1", "https://[::ffff:8.8.8.8]/v1",
  "https://[fc00::1]/v1", "https://[fe80::1]/v1", "https://[2001:db8::1]/v1", "https://[2002:0808:0808::1]/v1",
  "https://[2001:20::1]/v1", "https://[2620:4f:8000::1]/v1", "https://[3fff::1]/v1",
  ...["0.1.2.3", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.88.99.1", "192.168.0.1", "192.175.48.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255"].map((ip) => `https://${ip}/v1`),
];

test("normalization is static and canonical; private/ambiguous endpoints never open a socket", async () => {
  expect(normalizeProviderBaseUrl(" https://PROVIDER.example:443/v1/// ")).toBe("https://provider.example/v1");
  expect(normalizeProviderBaseUrl("https://unresolved.example/v1")).toBe("https://unresolved.example/v1");
  expect(normalizeProviderBaseUrl("https://8.8.8.8/v1")).toBe("https://8.8.8.8/v1");
  expect(normalizeProviderBaseUrl("https://[2606:4700:4700::1111]/v1")).toBe("https://[2606:4700:4700::1111]/v1");
  expect(() => normalizeProviderBaseUrl("https://provider.example/" + "x".repeat(2048))).toThrow(ProviderError);
  let resolutions = 0;
  let sockets = 0;
  const post = createProviderPost({
    resolve: (async () => { resolutions++; throw new Error("DNS must not run"); }) as typeof lookup,
    request: (() => { sockets++; throw new Error("Socket must not open"); }) as typeof request,
  });
  for (const endpoint of forbiddenEndpoints) {
    expect(() => normalizeProviderBaseUrl(endpoint)).toThrow(ProviderError);
    // Invalid WHATWG URLs cannot enter ProviderPost's URL-typed public API.
    let url: URL;
    try { url = new URL(endpoint); } catch { continue; }
    let caught: unknown;
    try { await post(url, headers, {}); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(["invalid_endpoint", "endpoint_not_public"]).toContain((caught as ProviderError).code);
  }
  expect(resolutions).toBe(0);
  expect(sockets).toBe(0);
});

test("empty, failing, private and mixed A/AAAA DNS responses fail closed", async () => {
  const fixture = await startProviderFixture();
  try {
    const cases: { answers?: { address: string; family: number }[]; code: ProviderErrorCode }[] = [
      { code: "dns_failed" }, { answers: [], code: "dns_failed" },
      { answers: [{ address: "127.0.0.1", family: 4 }], code: "endpoint_not_public" },
      { answers: [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }, { address: "10.0.0.1", family: 4 }], code: "endpoint_not_public" },
      { answers: [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }, { address: "::1", family: 6 }], code: "endpoint_not_public" },
      { answers: [{ address: "::ffff:93.184.216.34", family: 6 }], code: "endpoint_not_public" },
    ];
    for (const entry of cases) {
      const resolve = (async (hostname: string, options: unknown) => {
        expect(hostname).toBe("provider.example");
        expect(options).toEqual({ all: true, verbatim: true });
        if (!entry.answers) throw new Error(FIXTURE_DUMMY_KEY);
        return entry.answers;
      }) as typeof lookup;
      await failure(fixture.createPost({ resolve })(new URL(fixture.baseUrl), headers, {}), entry.code);
    }
    expect(fixture.transports).toHaveLength(0);
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});

test("one DNS resolution pins the first public answer for the actual native socket, including lookup all", async () => {
  const fixture = await startProviderFixture({ handler: (_req, res) => { res.end('{"ok":true}'); } });
  try {
    for (const lookupAll of [false, true]) {
      let resolutions = 0;
      const resolve = (async () => {
        resolutions++;
        return resolutions === 1
          ? [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }, { address: "8.8.8.8", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      }) as typeof lookup;
      expect(await fixture.createPost({ resolve, lookupAll })(new URL(fixture.baseUrl), headers, {})).toEqual({ ok: true });
      expect(resolutions).toBe(1);
      expect(fixture.transports.at(-1)?.pinnedAddresses).toEqual([FIXTURE_PUBLIC_ADDRESS]);
      expect(fixture.requests.at(-1)?.servername).toBe("provider.example");
      expect(fixture.requests.at(-1)?.headers.host).toBe(new URL(fixture.baseUrl).host);
    }
  } finally { await fixture.close(); }
});

test("public IP literals skip DNS and disable DNS-name SNI without disabling TLS verification", async () => {
  let resolutions = 0;
  let observed = 0;
  const post = createProviderPost({
    resolve: (async () => { resolutions++; throw new Error("Unexpected DNS"); }) as typeof lookup,
    request: ((_url: URL, options: RequestOptions) => {
      expect(options).toMatchObject({ servername: "", rejectUnauthorized: true, agent: false, family: 4 });
      observed++;
      throw new Error("Deliberate boundary stop: no public connection");
    }) as typeof request,
  });
  await failure(post(new URL("https://8.8.8.8/v1"), headers, {}), "provider_network");
  expect(resolutions).toBe(0);
  expect(observed).toBe(1);
});

test("all redirect statuses fail without reaching a second listener or exposing Location/body", async () => {
  const second = await startProviderFixture();
  let status = 301;
  let sameOrigin = false;
  const first = await startProviderFixture({ handler: (_req, res) => {
    res.writeHead(status, { Location: `${sameOrigin ? first.baseUrl : second.baseUrl}/${FIXTURE_DUMMY_KEY}` });
    res.end(`private upstream body ${FIXTURE_DUMMY_KEY}`);
  } });
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (status of [301, 302, 303, 307, 308]) {
      for (sameOrigin of [false, true]) {
        const before = first.requests.length;
        await failure(first.post(new URL(first.baseUrl), headers, {}), "provider_redirect");
        expect(first.requests.length - before).toBe(1);
      }
    }
    expect(first.requests).toHaveLength(10);
    expect(second.requests).toHaveLength(0);
    expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(FIXTURE_DUMMY_KEY);
  } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); await first.close(); await second.close(); }
});

test("HTTP errors retain only a safe category and status, never the echoed credential", async () => {
  const fixture = await startProviderFixture({ handler: (req, res) => {
    res.writeHead(401, { "x-credential-echo": String(req.headers.authorization) });
    res.end(JSON.stringify({ error: `private upstream body ${req.headers.authorization}` }));
  } });
  try { await failure(fixture.post(new URL(fixture.baseUrl), headers, { secret: FIXTURE_DUMMY_KEY }), "provider_http", 401); }
  finally { await fixture.close(); }
});

test("untrusted issuer and wrong-host certificates fail native verification before HTTP", async () => {
  const trusted = await startProviderFixture();
  const wrong = await startProviderFixture({ certificate: "wrong-host" });
  try {
    await failure(trusted.createPost({ trusted: false })(new URL(trusted.baseUrl), headers, {}), "provider_network");
    await failure(wrong.post(new URL(wrong.baseUrl), headers, {}), "provider_network");
    expect(trusted.requests).toHaveLength(0);
    expect(wrong.requests).toHaveLength(0);
  } finally { await trusted.close(); await wrong.close(); }
});

test("Bun native HTTPS primitive keeps Host/SNI with custom lookup and verifies the hostname", async () => {
  const fixture = await startProviderFixture({ handler: (_req, res) => { res.end('{"native":true}'); } });
  const wrong = await startProviderFixture({ certificate: "wrong-host" });
  const nativePost = async (baseUrl: string) => {
    const completion = Promise.withResolvers<string>();
    const req = request(new URL(baseUrl), {
      method: "POST", agent: false, ca: fixtureCa, rejectUnauthorized: true,
      servername: "provider.example", family: 4, autoSelectFamily: false,
      lookup: (hostname, options, done) => {
        expect(hostname).toBe("provider.example");
        if (typeof options === "object" && options.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
        else done(null, "127.0.0.1", 4);
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => completion.resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", completion.reject);
    });
    req.on("error", completion.reject);
    req.end("{}");
    return completion.promise;
  };
  try {
    expect(await nativePost(fixture.baseUrl)).toBe('{"native":true}');
    expect(fixture.requests[0]?.servername).toBe("provider.example");
    expect(fixture.requests[0]?.headers.host).toBe(new URL(fixture.baseUrl).host);
    await expect(nativePost(wrong.baseUrl)).rejects.toThrow();
    expect(wrong.requests).toHaveLength(0);
  } finally { await fixture.close(); await wrong.close(); }
});

test("body limit accepts exactly 1 MiB and rejects over-limit/chunked bodies and oversized headers", async () => {
  let mode: "exact" | "large" | "chunked" | "headers" = "exact";
  const fixture = await startProviderFixture({ handler: (_req, res) => {
    if (mode === "headers") { res.setHeader("x-oversized", "x".repeat(20 * 1024)); res.end("{}"); return; }
    if (mode === "chunked") {
      res.flushHeaders();
      for (let index = 0; index < 17; index++) res.write("x".repeat(64 * 1024));
      res.end(); return;
    }
    res.end(JSON.stringify("x".repeat(1024 * 1024 - (mode === "exact" ? 2 : 1))));
  } });
  try {
    const value = await fixture.post(new URL(fixture.baseUrl), headers, {});
    expect(typeof value).toBe("string");
    expect((value as string).length).toBe(1024 * 1024 - 2);
    for (mode of ["large", "chunked", "headers"]) {
      await failure(fixture.post(new URL(fixture.baseUrl), headers, {}), "provider_response_too_large");
    }
  } finally { await fixture.close(); }
});

test("compressed, malformed JSON and truncated responses never expose upstream content", async () => {
  let mode: "encoding" | "malformed" | "aborted" = "encoding";
  const fixture = await startProviderFixture({ handler: (_req, res) => {
    if (mode === "encoding") res.setHeader("Content-Encoding", "gzip");
    if (mode === "aborted") {
      res.writeHead(200, { "Content-Length": 9999 });
      res.write(`private upstream body ${FIXTURE_DUMMY_KEY}`, () => res.destroy());
      return;
    }
    res.end(`private upstream body ${FIXTURE_DUMMY_KEY}`);
  } });
  try {
    for (mode of ["encoding", "malformed"]) await failure(fixture.post(new URL(fixture.baseUrl), headers, {}), "provider_invalid_response");
    mode = "aborted";
    await failure(fixture.post(new URL(fixture.baseUrl), headers, {}), "provider_network");
  } finally { await fixture.close(); }
});

test("DNS deadline is total and late resolution cannot open a socket", async () => {
  // Intentionally exercises the unchanged native thirty-second timer; fake time cannot prove platform deadlines.
  const answer = Promise.withResolvers<{ address: string; family: number }[]>();
  let sockets = 0;
  const post = createProviderPost({
    resolve: (() => answer.promise) as typeof lookup,
    request: (() => { sockets++; throw new Error("Late DNS opened a socket"); }) as typeof request,
  });
  const started = Date.now();
  await failure(post(new URL("https://provider.example/v1"), headers, {}), "provider_timeout");
  expect(Date.now() - started).toBeGreaterThanOrEqual(29_000);
  expect(Date.now() - started).toBeLessThan(40_000);
  answer.resolve([{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]);
  // Yield to late DNS completion without replacing the native production deadline.
  const continued = Promise.withResolvers<void>();
  setImmediate(continued.resolve);
  await continued.promise;
  expect(sockets).toBe(0);
}, 45_000);

test("TCP/TLS connection stall is destroyed by the native five-second connection deadline", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  const post = createProviderPost({
    resolve: (async () => [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]) as typeof lookup,
    request: ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => request(url, {
      ...options, port: address.port,
      lookup: (_hostname, lookupOptions, done) => {
        if (typeof lookupOptions === "object" && lookupOptions.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
        else done(null, "127.0.0.1", 4);
      },
    }, callback)) as typeof request,
  });
  try {
    const started = Date.now();
    await failure(post(new URL("https://provider.example/v1"), headers, {}), "provider_timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(Date.now() - started).toBeLessThan(12_000);
  } finally {
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    server.close((error) => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  }
}, 45_000);

test("body stall remains bounded by the total thirty-second production deadline", async () => {
  // Real TLS/body streaming must remain bounded by the unchanged native production timer.
  const fixture = await startProviderFixture({ handler: (_req, res) => { res.writeHead(200); res.write('{"pending":'); } });
  try {
    const started = Date.now();
    await failure(fixture.post(new URL(fixture.baseUrl), headers, {}), "provider_timeout");
    expect(fixture.requests).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(29_000);
    expect(Date.now() - started).toBeLessThan(40_000);
  } finally { await fixture.close(); }
}, 45_000);

test("unsafe TLS and verbose-fetch settings reject before DNS/request in isolated processes", async () => {
  const moduleUrl = new URL("../packages/ai/src/provider-http.ts", import.meta.url).href;
  const script = `
    import { createProviderPost } from ${JSON.stringify(moduleUrl)};
    let calls = 0;
    const post = createProviderPost({ resolve: async () => { calls++; throw Error("DNS called"); }, request: () => { calls++; throw Error("request called"); } });
    try { await post(new URL("https://provider.example/v1"), { Authorization: "Bearer ${FIXTURE_DUMMY_KEY}" }, {}); process.exit(2); }
    catch (error) { console.log(JSON.stringify({code:error.code,calls})); }
  `;
  for (const unsafe of [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { BUN_CONFIG_VERBOSE_FETCH: "1" }, { BUN_CONFIG_VERBOSE_FETCH: "curl" }]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      env: { PATH: process.env.PATH ?? "", ...unsafe }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(JSON.stringify({ code: "provider_configuration", calls: 0 }));
    expect(stdout + stderr).not.toContain(FIXTURE_DUMMY_KEY);
  }
});
