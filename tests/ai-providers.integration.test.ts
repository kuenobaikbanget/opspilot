import { expect, test } from "bun:test";
import type { SQL } from "bun";
import type { AiProvider, CreateAiProviderRequest, Diagnosis } from "../packages/contracts/src/index";
import { generateDiagnosis } from "../packages/ai/src/index";
import { decryptProviderKey, readProviderMasterKey } from "../packages/ai/src/credentials";
import { runOneInvestigation, runOneProviderTest } from "../apps/worker/src/jobs";
import { fixtureInput, startProviderFixture } from "./helpers/provider-https-fixture";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

const integration = providerTestDatabaseAvailable ? test : test.skip;
const origin = "http://localhost:3100";
const master = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const masterKey = readProviderMasterKey({ AI_PROVIDER_ENCRYPTION_KEY: master })!;
const dummyKey = "sk-opspilot-integration-only-dummy-key";
const replacementKey = "sk-opspilot-integration-only-replacement";
const password = "opspilot-integration-only-password";
const root = new URL("../", import.meta.url).pathname;
const providerPath = "/api/ai/providers";
const missingId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

type ApiError = { error: string; code?: string };
type Report = {
  id: string;
  status: string;
  error: string | null;
  result_json: Diagnosis | null;
  provider: { id: string | null; name: string; protocol: string; baseUrl: string | null; model: string | null };
};
type Detail = { investigations: Report[] };
type RequestOptions = {
  authenticated?: boolean;
  origin?: string | null;
  contentType?: string | null;
  raw?: string;
};
type Hub = {
  request(path: string, method?: string, data?: unknown, overrides?: RequestOptions): Promise<Response>;
  responses: string[];
  stop(): Promise<string>;
};

// No inherited environment or dotenv: children cannot pick up developer credentials.
function childEnv(databaseUrl: string, encryptionKey: string | null = master): Record<string, string> {
  return {
    NODE_ENV: "development",
    DATABASE_URL: databaseUrl,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: "opspilot-disposable-provider-integration-session-secret",
    COOKIE_SECURE: "false",
    ALLOWED_ORIGIN: origin,
    INVESTIGATION_POLL_MS: "1000",
    ...(encryptionKey === null ? {} : { AI_PROVIDER_ENCRYPTION_KEY: encryptionKey }),
  };
}

// These bounds supervise real OS processes/HTTP/SQL; fake time cannot advance a child process.
async function bounded<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  const timeout = Promise.withResolvers<T>();
  const timer = setTimeout(() => timeout.reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
  try { return await Promise.race([work, timeout.promise]); }
  finally { clearTimeout(timer); }
}

async function eventually<T>(read: () => Promise<T | undefined>, label: string, milliseconds = 15_000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    // Real subprocess/SQL readiness is polled by condition, never by a guessed fixed wait.
    await Bun.sleep(30);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function spawn(script: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--no-env-file", script], {
    cwd: root, env, stdout: "pipe", stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let stopping: Promise<string> | undefined;
  return {
    child,
    stop(): Promise<string> {
      return stopping ??= (async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        try { await bounded(child.exited, 2_000, "child shutdown"); }
        catch { child.kill("SIGKILL"); await child.exited; }
        return `${await stdout}\n${await stderr}`;
      })();
    },
    async finish(): Promise<{ code: number; output: string }> {
      const code = await bounded(child.exited, 15_000, "child command").catch((error: unknown) => {
        child.kill("SIGKILL");
        throw error;
      });
      return { code, output: `${await stdout}\n${await stderr}` };
    },
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

async function startHub(databaseUrl: string, encryptionKey: string | null = master): Promise<Hub> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const process = spawn("apps/hub/src/index.ts", { ...childEnv(databaseUrl, encryptionKey), PORT: String(port) });
  const baseUrl = `http://127.0.0.1:${port}`;
  const responses: string[] = [];
  let cookie = "";
  async function request(path: string, method = "GET", data?: unknown, overrides: RequestOptions = {}): Promise<Response> {
    const headers = new Headers();
    if (overrides.authenticated !== false && cookie) headers.set("cookie", cookie);
    if (method !== "GET") {
      if (overrides.origin !== null) headers.set("origin", overrides.origin ?? origin);
      if (overrides.contentType !== null) headers.set("content-type", overrides.contentType ?? "application/json");
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers, body: overrides.raw ?? (data === undefined ? undefined : JSON.stringify(data)),
      signal: AbortSignal.timeout(5_000),
    });
    responses.push(await response.clone().text());
    return response;
  }
  try {
    await eventually(async () => {
      if (process.child.exitCode !== null) throw new Error(`Hub exited before startup: ${await process.stop()}`);
      try { return (await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).ok ? true : undefined; }
      catch { return undefined; }
    }, "Hub readiness");
    const login = await request("/api/auth/login", "POST", { password });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    return { request, responses, stop: process.stop };
  } catch (error) {
    await process.stop();
    throw error;
  }
}

async function withHubDb(work: (db: SQL, hub: Hub, databaseUrl: string) => Promise<void>): Promise<void> {
  await withProviderTestDb(async (db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try { await work(db, hub, databaseUrl); }
    finally {
      const logs = await hub.stop();
      expect(logs).not.toContain(dummyKey);
      expect(logs).not.toContain(replacementKey);
      expect(hub.responses.join("\n")).not.toContain(dummyKey);
      expect(hub.responses.join("\n")).not.toContain(replacementKey);
      expect(hub.responses.join("\n")).not.toMatch(/v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}/);
    }
  });
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return await response.json() as T;
}
async function error(response: Response, status: number, code?: string): Promise<void> {
  const data = await json<ApiError>(response, status);
  expect(typeof data.error).toBe("string");
  if (code) expect(data.code).toBe(code);
  expect(JSON.stringify(data)).not.toContain(dummyKey);
}
function input(baseUrl = "https://provider.example/v1"): CreateAiProviderRequest {
  return { name: "Integration connection", protocol: "openai-compatible", baseUrl, apiKey: dummyKey, defaultModel: "fixture-model", enabled: true };
}
async function create(hub: Hub, fields: Partial<CreateAiProviderRequest> = {}): Promise<AiProvider> {
  return (await json<{ provider: AiProvider }>(await hub.request(providerPath, "POST", { ...input(), ...fields }), 201)).provider;
}
async function patch(hub: Hub, id: string, fields: object): Promise<AiProvider> {
  return (await json<{ provider: AiProvider }>(await hub.request(`${providerPath}/${id}`, "PATCH", fields))).provider;
}
async function metadata(hub: Hub, id: string): Promise<AiProvider> {
  const { providers } = await json<{ providers: AiProvider[] }>(await hub.request(providerPath));
  const provider = providers.find((entry) => entry.id === id);
  expect(provider).toBeDefined();
  return provider!;
}
async function queueTest(hub: Hub, id: string): Promise<string> {
  const queued = await json<{ id: string; providerId: string; status: string }>(await hub.request(`${providerPath}/${id}/test`, "POST", {}), 202);
  expect(queued.providerId).toBe(id);
  expect(queued.status).toBe("queued");
  return queued.id;
}
async function seedIncident(db: SQL): Promise<{ incidentId: string; evidenceId: string }> {
  const [host] = await db`INSERT INTO agents(hostname,token_hash) VALUES('byok-offline-fixture','not-an-agent-token') RETURNING id`;
  const [incident] = await db`INSERT INTO incidents(agent_id,title,category) VALUES(${host.id},'Synthetic disk investigation','disk') RETURNING id`;
  const [evidence] = await db`INSERT INTO evidence(incident_id,source,content) VALUES(${incident.id},'fixture:disk_usage','Synthetic measured evidence: root disk is 92 percent full.') RETURNING id`;
  return { incidentId: incident.id as string, evidenceId: evidence.id as string };
}
async function investigate(hub: Hub, incidentId: string, provider: AiProvider, model = "explicit-investigation-model"): Promise<string> {
  const queued = await json<{ id: string; status: string; liveAgent: boolean }>(await hub.request(`/api/incidents/${incidentId}/investigate`, "POST", {
    providerId: provider.id, providerRevision: provider.revision, model,
  }), 202);
  expect(queued.status).toBe("queued");
  expect(queued.liveAgent).toBe(false);
  return queued.id;
}
function deferred() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: resolve };
}
async function providerAudit(db: SQL): Promise<void> {
  const rows = await db`SELECT action,target_id,data FROM audit_events WHERE action LIKE 'ai.provider.%' ORDER BY id`;
  expect(rows.length).toBeGreaterThan(0);
  const allowed: Record<string, true> = { protocol: true, revision: true, changedFields: true, testId: true, httpStatus: true, errorCode: true };
  for (const row of rows) {
    expect(row.target_id).toMatch(/^[0-9a-f-]{36}$/);
    for (const key of Object.keys(row.data as object)) expect(Object.hasOwn(allowed, key)).toBe(true);
    const serialized = JSON.stringify(row.data);
    for (const secret of [dummyKey, replacementKey, "v1.", "https://", "Integration connection"]) expect(serialized).not.toContain(secret);
  }
}

integration("provider routes require admin, exact Origin, JSON objects and bounded UTF-8 bodies", async () => {
  await withHubDb(async (db, hub) => {
    const { incidentId } = await seedIncident(db);
    const provider = await create(hub);
    const routes = [
      { path: providerPath, method: "POST", body: input() },
      { path: `${providerPath}/${provider.id}`, method: "PATCH", body: { name: "Changed" } },
      { path: `${providerPath}/${provider.id}`, method: "DELETE", body: undefined },
      { path: `${providerPath}/${provider.id}/test`, method: "POST", body: {} },
      { path: `/api/incidents/${incidentId}/investigate`, method: "POST", body: { providerId: provider.id, providerRevision: 1, model: "fixture-model" } },
    ];
    await error(await hub.request(providerPath, "GET", undefined, { authenticated: false }), 401);
    for (const route of routes) {
      await error(await hub.request(route.path, route.method, route.body, { authenticated: false }), 401);
      for (const badOrigin of [null, "http://attacker.invalid", `${origin}/`]) {
        await error(await hub.request(route.path, route.method, route.body, { origin: badOrigin }), 403, "forbidden_origin");
      }
      for (const contentType of [null, "text/plain", "application/x-www-form-urlencoded"]) {
        await error(await hub.request(route.path, route.method, route.body ?? {}, { contentType }), 415, "invalid_request");
      }
      for (const raw of ["{", "null", "[]", "true", '"string"']) {
        await error(await hub.request(route.path, route.method, undefined, { raw }), 400, "invalid_request");
      }
      await error(await hub.request(route.path, route.method, { ...route.body, unknown: true }), 400, "invalid_request");
      await error(await hub.request(route.path, route.method, undefined, { raw: JSON.stringify({ padding: "é".repeat(8_192) }) }), 413, "invalid_request");
      // Exactly 16 KiB is parsed, then fails schema validation, not the byte limit.
      const prefix = '{"padding":"';
      const suffix = '"}';
      const exact = prefix + "x".repeat(16 * 1_024 - prefix.length - suffix.length) + suffix;
      expect(Buffer.byteLength(exact)).toBe(16 * 1_024);
      await error(await hub.request(route.path, route.method, undefined, { raw: exact }), 400, "invalid_request");
    }
    for (const id of ["bad-uuid", missingId]) {
      const status = id === missingId ? 404 : 400;
      for (const [suffix, method, body] of [["", "PATCH", { name: "Changed" }], ["", "DELETE", undefined], ["/test", "POST", {}]] as const) {
        await error(await hub.request(`${providerPath}/${id}${suffix}`, method, body), status);
      }
      await error(await hub.request(`/api/incidents/${id}/investigate`, "POST", { providerId: provider.id, providerRevision: 1, model: "fixture-model" }), status);
    }
    for (const fields of [
      { name: "" }, { name: "x".repeat(81) }, { protocol: "openai" }, { enabled: "true" },
      { defaultModel: "" }, { defaultModel: "m".repeat(201) }, { apiKey: "" }, { apiKey: "contains spaces" },
      { apiKey: "k".repeat(4_097) }, { apiKey: "line\nbreak" }, { apiKey: "control\u0001character" },
      { baseUrl: "x".repeat(2_049) }, { enabled: null }, { name: 7 }, { defaultModel: false },
    ]) {
      await error(await hub.request(providerPath, "POST", { ...input(), ...fields }), 400, "invalid_request");
      await error(await hub.request(`${providerPath}/${provider.id}`, "PATCH", fields), 400, "invalid_request");
    }
    for (const field of ["name", "protocol", "baseUrl", "apiKey", "defaultModel", "enabled"]) {
      const incomplete: Record<string, unknown> = { ...input() };
      delete incomplete[field];
      await error(await hub.request(providerPath, "POST", incomplete), 400, "invalid_request");
    }
    for (const [baseUrl, code] of [
      ["http://provider.example/v1", "invalid_endpoint"],
      ["https://127.0.0.1/v1", "endpoint_not_public"],
      ["https://localhost/v1", "endpoint_not_public"],
      ["https://user:pass@provider.example/v1", "invalid_endpoint"],
      ["https://provider.example/v1?key=secret", "invalid_endpoint"],
      ["https://provider.example/v1#fragment", "invalid_endpoint"],
    ]) {
      await error(await hub.request(providerPath, "POST", { ...input(), baseUrl }), 400, code);
      await error(await hub.request(`${providerPath}/${provider.id}`, "PATCH", { baseUrl }), 400, code);
    }
    await error(await hub.request(`${providerPath}/${provider.id}`, "PATCH", {}), 400, "invalid_request");
    for (const fields of [{ provider: "openai" }, { providerId: "bad", providerRevision: 1, model: "m" }, { providerId: provider.id, providerRevision: 0, model: "m" }, { providerId: provider.id, providerRevision: 1.5, model: "m" }, { providerId: provider.id, providerRevision: 1, model: " " }]) {
      await error(await hub.request(`/api/incidents/${incidentId}/investigate`, "POST", fields), 400, "invalid_request");
    }
  });
}, 60_000);

integration("provider CRUD preserves encrypted keys, revisions, snapshots and audit allowlists", async () => {
  await withHubDb(async (db, hub) => {
    let provider = await create(hub, { baseUrl: "https://provider.example/v1/", name: "  Integration connection  " });
    expect(provider.name).toBe("Integration connection");
    expect(provider.baseUrl).toBe("https://provider.example/v1");
    expect(provider.hasApiKey).toBe(true);
    expect(provider.revision).toBe(1);
    expect(provider.lastTest).toBeNull();
    const [stored] = await db`SELECT api_key_ciphertext FROM ai_providers WHERE id=${provider.id}`;
    expect(stored.api_key_ciphertext).toStartWith("v1.");
    expect(stored.api_key_ciphertext).not.toContain(dummyKey);
    expect(decryptProviderKey(provider.id, stored.api_key_ciphertext, masterKey)).toBe(dummyKey);
    const raw = JSON.stringify(await json(await hub.request(providerPath)));
    expect(raw).not.toContain(stored.api_key_ciphertext);
    expect(raw).not.toContain("api_key_ciphertext");
    expect(raw).not.toContain('"apiKey"');
    const noop = await patch(hub, provider.id, { name: provider.name, baseUrl: `${provider.baseUrl}/`, enabled: true });
    expect(noop.revision).toBe(1);
    expect(noop.updatedAt).toBe(provider.updatedAt);
    for (const fields of [{ baseUrl: "https://another.example/v1" }, { protocol: "anthropic" }]) {
      await error(await hub.request(`${providerPath}/${provider.id}`, "PATCH", fields), 400, "invalid_request");
    }
    provider = await patch(hub, provider.id.toUpperCase(), { apiKey: replacementKey });
    expect(provider.revision).toBe(2);
    const [replaced] = await db`SELECT api_key_ciphertext FROM ai_providers WHERE id=${provider.id}`;
    expect(replaced.api_key_ciphertext).not.toBe(stored.api_key_ciphertext);
    expect(decryptProviderKey(provider.id, replaced.api_key_ciphertext, masterKey)).toBe(replacementKey);
    provider = await patch(hub, provider.id, { baseUrl: "https://another.example/v1", protocol: "anthropic", apiKey: replacementKey });
    expect(provider.revision).toBe(3);
    provider = await patch(hub, provider.id, { enabled: false });
    expect(provider.revision).toBe(4);
    await error(await hub.request(`${providerPath}/${provider.id}/test`, "POST", {}), 409, "provider_disabled");
    const { incidentId } = await seedIncident(db);
    await error(await hub.request(`/api/incidents/${incidentId}/investigate`, "POST", { providerId: provider.id, providerRevision: provider.revision, model: "m" }), 409, "provider_disabled");
    provider = await patch(hub, provider.id, { enabled: true });
    expect(provider.revision).toBe(5);
    await providerAudit(db);
    await json(await hub.request(`${providerPath}/${provider.id}`, "DELETE"));
    expect((await db`SELECT id FROM ai_providers WHERE id=${provider.id}`).length).toBe(0);
    await error(await hub.request(`${providerPath}/${provider.id}`, "DELETE"), 404, "provider_unavailable");
  });
}, 60_000);

integration("missing or malformed master leaves monitoring and metadata available but rejects AI mutations", async () => {
  await withProviderTestDb(async (db, databaseUrl) => {
    await migrate(databaseUrl);
    const configured = await startHub(databaseUrl);
    let provider: AiProvider;
    const { incidentId } = await seedIncident(db);
    let queuedId: string;
    try {
      provider = await create(configured);
      queuedId = await investigate(configured, incidentId, provider);
    } finally { await configured.stop(); }
    for (const encryptionKey of [null, "not-canonical-base64"]) {
      const hub = await startHub(databaseUrl, encryptionKey);
      try {
        await json(await hub.request("/healthz"));
        await json(await hub.request("/api/incidents"));
        await json(await hub.request("/api/hosts"));
        const listing = await json<{ encryptionConfigured: boolean; providers: AiProvider[] }>(await hub.request(providerPath));
        expect(listing.encryptionConfigured).toBe(false);
        expect(listing.providers[0]!.id).toBe(provider!.id);
        for (const [path, method, data] of [
          [providerPath, "POST", input()], [`${providerPath}/${provider!.id}`, "PATCH", { name: "Changed" }],
          [`${providerPath}/${provider!.id}`, "DELETE", undefined], [`${providerPath}/${provider!.id}/test`, "POST", {}],
          [`/api/incidents/${incidentId}/investigate`, "POST", { providerId: provider!.id, providerRevision: 1, model: "m" }],
        ] as const) await error(await hub.request(path, method, data), 503, "credential_unavailable");
        expect(await runOneInvestigation(db, null)).toBe(false);
        expect((await db`SELECT status FROM investigations WHERE id=${queuedId!}`)[0].status).toBe("queued");
      } finally { expect(await hub.stop()).not.toContain(dummyKey); }
    }
    // Well-formed replacement master is configured, but cannot decrypt existing rows.
    const wrong = await startHub(databaseUrl, Buffer.alloc(32, 1).toString("base64"));
    try {
      expect((await json<{ encryptionConfigured: boolean }>(await wrong.request(providerPath))).encryptionConfigured).toBe(true);
      await error(await wrong.request(`${providerPath}/${provider!.id}/test`, "POST", {}), 503, "credential_unavailable");
      await error(await wrong.request(`/api/incidents/${incidentId}/investigate`, "POST", { providerId: provider!.id, providerRevision: 1, model: "m" }), 503, "credential_unavailable");
    } finally { await wrong.stop(); }
  });
}, 60_000);

integration("real HTTPS generation completes queued tests and cited investigations once across concurrent Workers", async () => {
  await withHubDb(async (db, hub) => {
    const fixture = await startProviderFixture();
    const gate = deferred();
    let pending: Promise<boolean> | undefined;
    try {
      let provider = await create(hub, { baseUrl: fixture.baseUrl });
      const { incidentId, evidenceId } = await seedIncident(db);
      await db`INSERT INTO incident_memory(incident_id,summary,resolution)
        VALUES(${incidentId},'Synthetic disk investigation memory','Synthetic human-confirmed fixture resolution')`;
      const testId = await queueTest(hub, provider.id);
      const queued = (await metadata(hub, provider.id)).lastTest!;
      expect(queued.id).toBe(testId);
      expect(queued.status).toBe("queued");
      expect(queued.model).toBe("fixture-model");
      expect(queued.revision).toBe(provider.revision);
      await error(await hub.request(`${providerPath}/${provider.id}/test`, "POST", {}), 409, "test_in_progress");
      const generate: typeof generateDiagnosis = (connection, incident, evidence, memory) => generateDiagnosis(connection, incident, evidence, memory, fixture.post);
      const held: typeof generateDiagnosis = async (...args) => { const result = await generate(...args); await gate.promise; return result; };
      const first = pending = runOneProviderTest(db, masterKey, held);
      await eventually(async () => fixture.requests.length === 1 ? true : undefined, "synthetic HTTPS request");
      expect(await runOneProviderTest(db, masterKey, generate)).toBe(false);
      expect((await metadata(hub, provider.id)).lastTest!.status).toBe("running");
      gate.release();
      expect(await first).toBe(true);
      expect(fixture.requests.length).toBe(1);
      const completed = (await metadata(hub, provider.id)).lastTest!;
      expect(completed.status).toBe("completed");
      expect(completed.errorCode).toBeNull();
      expect(completed.startedAt).not.toBeNull();
      expect(completed.completedAt).not.toBeNull();
      expect(fixture.requests[0]!.rawBody).toContain("OpsPilot connection test");
      expect(fixture.requests[0]!.rawBody).not.toContain("Synthetic measured evidence");
      expect(fixtureInput(fixture.requests[0]!.body)).toEqual({
        incident: { title: "OpsPilot connection test", category: "connection_test" },
        evidence: [],
        prior_resolutions: [],
      });
      const jobId = await investigate(hub, incidentId, provider);
      const outcomes = await Promise.all([runOneInvestigation(db, masterKey, generate), runOneInvestigation(db, masterKey, generate)]);
      expect(outcomes.sort()).toEqual([false, true]);
      expect(fixture.requests.length).toBe(2);
      const report = (await json<Detail>(await hub.request(`/api/incidents/${incidentId}`))).investigations.find((entry) => entry.id === jobId)!;
      expect(report.status).toBe("completed");
      expect(report.result_json!.evidence_ids).toEqual([evidenceId]);
      expect(report.provider).toEqual({ id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: fixture.baseUrl, model: "explicit-investigation-model" });
      expect(fixture.requests[1]!.rawBody).toContain("explicit-investigation-model");
      provider = await patch(hub, provider.id, { name: "Renamed after report", defaultModel: "new-default" });
      expect((await metadata(hub, provider.id)).lastTest!.revision).not.toBe(provider.revision);
      const afterEdit = (await json<Detail>(await hub.request(`/api/incidents/${incidentId}`))).investigations[0]!;
      expect(afterEdit.provider).toEqual(report.provider);
      await json(await hub.request(`${providerPath}/${provider.id}`, "DELETE"));
      const afterDelete = (await json<Detail>(await hub.request(`/api/incidents/${incidentId}`))).investigations[0]!;
      expect(afterDelete.provider).toEqual({ ...report.provider, id: null });
      expect(afterDelete.result_json).toEqual(report.result_json);
      expect((await db`SELECT api_key_ciphertext FROM ai_providers WHERE id=${provider.id}`).length).toBe(0);
      const audit = await db`SELECT action,data FROM audit_events WHERE action LIKE 'ai.provider.test_%'`;
      expect(audit.filter((entry) => entry.action === "ai.provider.test_completed" && entry.data.testId === testId).length).toBe(1);
      await providerAudit(db);
    } finally { gate.release(); if (pending) await pending; await fixture.close(); }
  });
}, 60_000);

integration("browser and queued-job revisions, disabled/deleted providers and corrupt credentials fail before outbound", async () => {
  await withHubDb(async (db, hub) => {
    const fixture = await startProviderFixture();
    try {
      const { incidentId } = await seedIncident(db);
      const generate: typeof generateDiagnosis = (connection, incident, evidence, memory) => generateDiagnosis(connection, incident, evidence, memory, fixture.post);
      let provider = await create(hub, { baseUrl: fixture.baseUrl });
      const stale = provider;
      provider = await patch(hub, provider.id, { name: "New revision" });
      await error(await hub.request(`/api/incidents/${incidentId}/investigate`, "POST", { providerId: stale.id, providerRevision: stale.revision, model: "m" }), 409, "provider_changed");
      await error(await hub.request(`/api/incidents/${incidentId}/investigate`, "POST", { providerId: missingId, providerRevision: 1, model: "m" }), 404, "provider_unavailable");
      expect((await db`SELECT id FROM investigations`).length).toBe(0);
      const changedJob = await investigate(hub, incidentId, provider);
      provider = await patch(hub, provider.id, { defaultModel: "changed-default" });
      expect(await runOneInvestigation(db, masterKey, generate)).toBe(true);
      const [changed] = await db`SELECT status,error FROM investigations WHERE id=${changedJob}`;
      expect(changed.status).toBe("failed");
      expect(changed.error).toBe("provider_changed");
      const disabledJob = await investigate(hub, incidentId, provider);
      await db`UPDATE ai_providers SET enabled=false WHERE id=${provider.id}`;
      expect(await runOneInvestigation(db, masterKey, generate)).toBe(true);
      const [disabled] = await db`SELECT status,error FROM investigations WHERE id=${disabledJob}`;
      expect(disabled.status).toBe("failed");
      expect(disabled.error).toBe("provider_disabled");
      await db`UPDATE ai_providers SET enabled=true WHERE id=${provider.id}`;
      const badCredentialJob = await investigate(hub, incidentId, provider);
      const [credential] = await db`SELECT api_key_ciphertext FROM ai_providers WHERE id=${provider.id}`;
      await db`UPDATE ai_providers SET api_key_ciphertext='v1.corrupted.ciphertext.tag' WHERE id=${provider.id}`;
      await error(await hub.request(`${providerPath}/${provider.id}/test`, "POST", {}), 503, "credential_unavailable");
      await error(await hub.request(`/api/incidents/${incidentId}/investigate`, "POST", { providerId: provider.id, providerRevision: provider.revision, model: "m" }), 503, "credential_unavailable");
      expect(await runOneInvestigation(db, masterKey, generate)).toBe(true);
      const [unavailable] = await db`SELECT status,error FROM investigations WHERE id=${badCredentialJob}`;
      expect(unavailable.status).toBe("failed");
      expect(unavailable.error).toBe("credential_unavailable");
      await db`UPDATE ai_providers SET api_key_ciphertext=${credential.api_key_ciphertext} WHERE id=${provider.id}`;
      const deletedJob = await investigate(hub, incidentId, provider);
      await json(await hub.request(`${providerPath}/${provider.id}`, "DELETE"));
      expect(await runOneInvestigation(db, masterKey, generate)).toBe(true);
      const [deleted] = await db`SELECT status,provider_id,provider_name FROM investigations WHERE id=${deletedJob}`;
      expect(deleted.status).toBe("failed");
      expect(deleted.provider_id).toBeNull();
      expect((await db`SELECT error FROM investigations WHERE id=${deletedJob}`)[0].error).toBe("provider_unavailable");
      expect(deleted.provider_name).toBe(provider.name);
      expect(fixture.requests.length).toBe(0);
      await db`UPDATE incidents SET status='resolved',resolved_at=NOW() WHERE id=${incidentId}`;
      const other = await create(hub, { baseUrl: fixture.baseUrl });
      await error(await hub.request(`/api/incidents/${incidentId}/investigate`, "POST", { providerId: other.id, providerRevision: other.revision, model: "m" }), 409);
    } finally { await fixture.close(); }
  });
}, 60_000);

integration("test slot expiry, configuration invalidation and late results cannot overwrite newer tests", async () => {
  await withHubDb(async (db, hub) => {
    const fixture = await startProviderFixture();
    const gate = deferred();
    let pending: Promise<boolean> | undefined;
    try {
      let provider = await create(hub, { baseUrl: fixture.baseUrl });
      const expiredId = await queueTest(hub, provider.id);
      await db`UPDATE ai_providers SET last_test_expires_at=NOW()-INTERVAL '1 second' WHERE id=${provider.id}`;
      const beforeGet = await db`SELECT last_test_status FROM ai_providers WHERE id=${provider.id}`;
      const expiredProjection = (await metadata(hub, provider.id)).lastTest!;
      expect(expiredProjection.status).toBe("failed");
      expect(expiredProjection.errorCode).toBe("provider_timeout");
      expect((await db`SELECT last_test_status FROM ai_providers WHERE id=${provider.id}`)[0].last_test_status).toBe(beforeGet[0].last_test_status);
      expect((await db`SELECT id FROM audit_events WHERE action='ai.provider.test_failed'`).length).toBe(0);
      expect(await runOneProviderTest(db, null)).toBe(true);
      expect(await runOneProviderTest(db, null)).toBe(false);
      const failedAudit = await db`SELECT data FROM audit_events WHERE action='ai.provider.test_failed'`;
      expect(failedAudit.filter((row) => row.data.testId === expiredId && row.data.errorCode === "provider_timeout").length).toBe(1);
      const changedId = await queueTest(hub, provider.id);
      provider = await patch(hub, provider.id, { name: "Changed while queued" });
      expect((await metadata(hub, provider.id)).lastTest!.errorCode).toBe("provider_changed");
      expect(await runOneProviderTest(db, masterKey)).toBe(false);
      expect((await db`SELECT data FROM audit_events WHERE action='ai.provider.test_failed'`).filter((row) => row.data.testId === changedId).length).toBe(1);
      const oldId = await queueTest(hub, provider.id);
      const generate: typeof generateDiagnosis = (connection, incident, evidence, memory) => generateDiagnosis(connection, incident, evidence, memory, fixture.post);
      const delayed: typeof generateDiagnosis = async (...args) => { const result = await generate(...args); await gate.promise; return result; };
      pending = runOneProviderTest(db, masterKey, delayed);
      await eventually(async () => fixture.requests.length === 1 ? true : undefined, "held test request");
      await db`UPDATE ai_providers SET last_test_expires_at=NOW()-INTERVAL '1 second' WHERE id=${provider.id}`;
      expect(await runOneProviderTest(db, null)).toBe(true);
      const newId = await queueTest(hub, provider.id);
      expect(newId).not.toBe(oldId);
      expect(await runOneProviderTest(db, masterKey, generate)).toBe(true);
      const newResult = (await metadata(hub, provider.id)).lastTest!;
      expect(newResult.id).toBe(newId);
      expect(newResult.status).toBe("completed");
      gate.release();
      expect(await pending).toBe(true);
      expect((await metadata(hub, provider.id)).lastTest).toEqual(newResult);
      const oldResults = await db`SELECT action,data FROM audit_events WHERE action IN ('ai.provider.test_failed','ai.provider.test_completed')`;
      expect(oldResults.filter((row) => row.data.testId === oldId && row.action === "ai.provider.test_failed").length).toBe(1);
      expect(oldResults.filter((row) => row.data.testId === oldId && row.action === "ai.provider.test_completed").length).toBe(0);
      await providerAudit(db);
    } finally { gate.release(); if (pending) await pending; await fixture.close(); }
  });
}, 60_000);

integration("running test revision changes reject late native HTTPS success", async () => {
  await withHubDb(async (db, hub) => {
    const fixture = await startProviderFixture();
    const gate = deferred();
    let pending: Promise<boolean> | undefined;
    try {
      let provider = await create(hub, { baseUrl: fixture.baseUrl });
      const testId = await queueTest(hub, provider.id);
      const generate: typeof generateDiagnosis = async (connection, incident, evidence, memory) => {
        const diagnosis = await generateDiagnosis(connection, incident, evidence, memory, fixture.post);
        await gate.promise;
        return diagnosis;
      };
      pending = runOneProviderTest(db, masterKey, generate);
      await eventually(async () => fixture.requests.length === 1 ? true : undefined, "running generation");
      provider = await patch(hub, provider.id, { defaultModel: "new-config-model" });
      const changed = (await metadata(hub, provider.id)).lastTest!;
      expect(changed.status).toBe("failed");
      expect(changed.errorCode).toBe("provider_changed");
      expect(changed.revision).toBe(provider.revision - 1);
      gate.release();
      expect(await pending).toBe(true);
      expect((await metadata(hub, provider.id)).lastTest).toEqual(changed);
      expect((await db`SELECT data FROM audit_events WHERE action='ai.provider.test_completed'`).filter((row) => row.data.testId === testId).length).toBe(0);
      expect((await db`SELECT data FROM audit_events WHERE action='ai.provider.test_failed'`).filter((row) => row.data.testId === testId).length).toBe(1);
    } finally { gate.release(); if (pending) await pending; await fixture.close(); }
  });
}, 60_000);

integration("native Worker entrypoint consumes queued private-target tests with sanitized failure", async () => {
  await withHubDb(async (db, hub, databaseUrl) => {
    const provider = await create(hub);
    // Simulate an unsafe persisted endpoint; Worker must repeat endpoint policy, not trust Hub validation.
    await db`UPDATE ai_providers SET base_url='https://localhost/v1' WHERE id=${provider.id}`;
    const testId = await queueTest(hub, provider.id);
    const worker = spawn("apps/worker/src/index.ts", childEnv(databaseUrl));
    try {
      const lastTest = await eventually(async () => {
        const last = (await metadata(hub, provider.id)).lastTest;
        return last?.status === "failed" ? last : undefined;
      }, "native Worker private-target failure");
      expect(lastTest.id).toBe(testId);
      expect(["invalid_endpoint", "endpoint_not_public"]).toContain(lastTest.errorCode!);
      expect(lastTest.httpStatus).toBeNull();
      const rows = await db`SELECT data FROM audit_events WHERE action='ai.provider.test_failed'`;
      expect(rows.filter((row) => row.data.testId === testId).length).toBe(1);
    } finally {
      const logs = await worker.stop();
      expect(logs).not.toContain(dummyKey);
      expect(logs).not.toContain("https://localhost");
      expect(logs).not.toContain("v1.");
    }
  });
}, 60_000);

integration("provider limit is enforced atomically under concurrent create requests", async () => {
  await withHubDb(async (db, hub) => {
    const provider = await create(hub);
    // Encrypted envelopes are real; UUID-bound AAD is irrelevant to counting and never decrypted here.
    await db`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,api_key_ciphertext)
      SELECT gen_random_uuid(),'Limit fixture','openai-compatible','https://provider.example/v1','fixture-model',true,api_key_ciphertext
      FROM ai_providers CROSS JOIN generate_series(1,98) WHERE id=${provider.id}`;
    const responses = await Promise.all([hub.request(providerPath, "POST", { ...input(), name: "Hundred A" }), hub.request(providerPath, "POST", { ...input(), name: "Hundred B" })]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    await error(responses.find((response) => response.status === 409)!, 409, "provider_limit");
    expect(Number((await db`SELECT COUNT(*) AS count FROM ai_providers`)[0].count)).toBe(100);
  });
}, 60_000);

integration("upstream errors echoing credentials never enter reports, test DTOs or audit data", async () => {
  await withHubDb(async (db, hub) => {
    const fixture = await startProviderFixture({
      handler(request, response) {
        response.writeHead(429, {
          "content-type": "application/json",
          location: `https://attacker.invalid/${dummyKey}`,
        });
        response.end(JSON.stringify({ error: dummyKey, echoedAuthorization: request.headers.authorization }));
      },
    });
    try {
      const provider = await create(hub, { baseUrl: fixture.baseUrl });
      const generate: typeof generateDiagnosis = (connection, incident, evidence, memory) => generateDiagnosis(connection, incident, evidence, memory, fixture.post);
      await queueTest(hub, provider.id);
      expect(await runOneProviderTest(db, masterKey, generate)).toBe(true);
      const lastTest = (await metadata(hub, provider.id)).lastTest!;
      expect(lastTest.status).toBe("failed");
      expect(lastTest.errorCode).toBe("provider_http");
      expect(lastTest.httpStatus).toBe(429);
      const { incidentId } = await seedIncident(db);
      const jobId = await investigate(hub, incidentId, provider);
      expect(await runOneInvestigation(db, masterKey, generate)).toBe(true);
      const report = (await json<Detail>(await hub.request(`/api/incidents/${incidentId}`))).investigations.find((entry) => entry.id === jobId)!;
      expect(report.status).toBe("failed");
      expect(report.error).toBe("provider_http");
      expect(report.result_json).toBeNull();
      expect(JSON.stringify(report)).not.toContain("attacker.invalid");
      const [stored] = await db`SELECT error,result_json FROM investigations WHERE id=${jobId}`;
      expect(JSON.stringify(stored)).not.toContain(dummyKey);
      await providerAudit(db);
    } finally { await fixture.close(); }
  });
}, 60_000);

integration("investigation already in flight keeps captured destination and snapshot through edit and deletion", async () => {
  await withHubDb(async (db, hub) => {
    const fixture = await startProviderFixture();
    const gate = deferred();
    let pending: Promise<boolean> | undefined;
    try {
      const original = await create(hub, { baseUrl: fixture.baseUrl });
      const { incidentId, evidenceId } = await seedIncident(db);
      const jobId = await investigate(hub, incidentId, original, "captured-model");
      const generate: typeof generateDiagnosis = async (connection, incident, evidence, memory) => {
        const result = await generateDiagnosis(connection, incident, evidence, memory, fixture.post);
        await gate.promise;
        return result;
      };
      pending = runOneInvestigation(db, masterKey, generate);
      await eventually(async () => fixture.requests.length === 1 ? true : undefined, "captured investigation request");
      await patch(hub, original.id, { name: "Different destination", baseUrl: "https://elsewhere.example/v1", apiKey: replacementKey, defaultModel: "different-model" });
      await json(await hub.request(`${providerPath}/${original.id}`, "DELETE"));
      gate.release();
      expect(await pending).toBe(true);
      const report = (await json<Detail>(await hub.request(`/api/incidents/${incidentId}`))).investigations.find((entry) => entry.id === jobId)!;
      expect(report.status).toBe("completed");
      expect(report.provider).toEqual({ id: null, name: original.name, protocol: original.protocol, baseUrl: fixture.baseUrl, model: "captured-model" });
      expect(report.result_json!.evidence_ids).toEqual([evidenceId]);
      expect(fixture.requests.length).toBe(1);
      expect(fixture.requests[0]!.headers.authorization).toBe(`Bearer ${dummyKey}`);
      expect(fixture.requests[0]!.rawBody).toContain("captured-model");
      expect(fixture.requests[0]!.rawBody).not.toContain("different-model");
    } finally { gate.release(); if (pending) await pending; await fixture.close(); }
  });
}, 60_000);

integration("Worker retires persisted invalid test revisions, disabled slots and bad credentials without outbound", async () => {
  await withHubDb(async (db, hub) => {
    const fixture = await startProviderFixture();
    try {
      let provider = await create(hub, { baseUrl: fixture.baseUrl });
      const generate: typeof generateDiagnosis = (connection, incident, evidence, memory) => generateDiagnosis(connection, incident, evidence, memory, fixture.post);
      await queueTest(hub, provider.id);
      await db`UPDATE ai_providers SET revision=revision+1 WHERE id=${provider.id}`;
      expect(await runOneProviderTest(db, masterKey, generate)).toBe(true);
      expect((await metadata(hub, provider.id)).lastTest!.errorCode).toBe("provider_changed");
      provider = await metadata(hub, provider.id);
      await queueTest(hub, provider.id);
      await db`UPDATE ai_providers SET enabled=false WHERE id=${provider.id}`;
      expect(await runOneProviderTest(db, masterKey, generate)).toBe(true);
      expect((await metadata(hub, provider.id)).lastTest!.errorCode).toBe("provider_disabled");
      await db`UPDATE ai_providers SET enabled=true WHERE id=${provider.id}`;
      await queueTest(hub, provider.id);
      await db`UPDATE ai_providers SET api_key_ciphertext='v1.broken.ciphertext.tag' WHERE id=${provider.id}`;
      expect(await runOneProviderTest(db, masterKey, generate)).toBe(true);
      expect((await metadata(hub, provider.id)).lastTest!.errorCode).toBe("credential_unavailable");
      expect(await runOneProviderTest(db, masterKey, generate)).toBe(false);
      expect(fixture.requests.length).toBe(0);
      const audits = await db`SELECT data FROM audit_events WHERE action='ai.provider.test_failed'`;
      expect(audits.length).toBe(3);
      expect(new Set(audits.map((row) => row.data.testId)).size).toBe(3);
      await providerAudit(db);
    } finally { await fixture.close(); }
  });
}, 60_000);

integration("provider deletion and a queued Worker claim follow the same lock order", async () => {
  await withHubDb(async (db, hub) => {
    const fixture = await startProviderFixture();
    const locked = deferred();
    const release = deferred();
    let deleting: Promise<Response> | undefined;
    let worker: Promise<boolean> | undefined;
    let holding: Promise<unknown> | undefined;
    try {
      const provider = await create(hub, { baseUrl: fixture.baseUrl });
      const { incidentId } = await seedIncident(db);
      const jobId = await investigate(hub, incidentId, provider);
      holding = db.begin(async (tx) => {
        await tx`SELECT id FROM ai_providers WHERE id=${provider.id} FOR UPDATE`;
        locked.release();
        await release.promise;
      });
      await bounded(locked.promise, 5_000, "provider lock");
      deleting = hub.request(`${providerPath}/${provider.id}`, "DELETE");
      await eventually(async () => {
        const rows = await db`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%SELECT * FROM ai_providers WHERE id=%FOR UPDATE%'`;
        return rows.length ? true : undefined;
      }, "delete waiting for provider");
      const generate: typeof generateDiagnosis = (connection, incident, evidence, memory) =>
        generateDiagnosis(connection, incident, evidence, memory, fixture.post);
      worker = runOneInvestigation(db, masterKey, generate);
      await eventually(async () => {
        const rows = await db`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%SELECT id,protocol,base_url,enabled,revision,api_key_ciphertext%FOR UPDATE%'`;
        return rows.length ? true : undefined;
      }, "Worker waiting for provider");
      release.release();
      await holding;
      await json(await deleting);
      expect(await bounded(worker, 5_000, "deleted-provider claim")).toBe(true);
      const [job] = await db`SELECT status,error,provider_id,provider_name FROM investigations WHERE id=${jobId}`;
      expect(job.status).toBe("failed");
      expect(job.error).toBe("provider_unavailable");
      expect(job.provider_id).toBeNull();
      expect(job.provider_name).toBe(provider.name);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      release.release();
      await Promise.allSettled([holding, deleting, worker]);
      await fixture.close();
    }
  });
}, 60_000);
