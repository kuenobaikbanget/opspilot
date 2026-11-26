import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import type { Diagnosis, IncidentMemoryRecord } from "../packages/contracts/src/index";
import type { generateDiagnosis } from "../packages/ai/src/index";
import { encryptProviderKey, readProviderMasterKey } from "../packages/ai/src/credentials";
import { runOneInvestigation } from "../apps/worker/src/jobs";
import { memoryFingerprint } from "../apps/hub/src/memory-dedup";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

const integration = providerTestDatabaseAvailable ? test : test.skip;
const root = new URL("../", import.meta.url).pathname;
const master = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const masterKey = readProviderMasterKey({ AI_PROVIDER_ENCRYPTION_KEY: master })!;
const dummyKey = "sk-opspilot-memory-dedup-integration-only-dummy-key";
const origin = "http://localhost:3100";
const password = "opspilot-memory-dedup-integration-only-password";

const RESOLUTION_A = "Restart the nginx service and verify it listens on port 443 again";
const RESOLUTION_A_NEAR = "Restart the nginx service and verify it listens on port 443 again now";
const RESOLUTION_DISTINCT = "Extend the backup volume disk quota and prune archives older than 30 days";

type Hub = {
  request(path: string, method?: string, data?: unknown, headers?: Record<string, string>): Promise<Response>;
  stop(): Promise<string>;
};

function diagnosis(cause: string): Diagnosis {
  return { probable_cause: cause, confidence: "high", evidence_ids: [], missing_evidence: [], recommended_checks: [] };
}

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

function childEnv(databaseUrl: string): Record<string, string> {
  return {
    NODE_ENV: "development",
    DATABASE_URL: databaseUrl,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: "opspilot-disposable-memory-dedup-integration-session-secret",
    COOKIE_SECURE: "false",
    ALLOWED_ORIGIN: origin,
    AI_PROVIDER_ENCRYPTION_KEY: master,
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

async function startHub(databaseUrl: string): Promise<Hub> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const child = spawn("apps/hub/src/index.ts", { ...childEnv(databaseUrl), PORT: String(port) });
  const baseUrl = `http://127.0.0.1:${port}`;
  let cookie = "";
  async function request(path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const all = new Headers(headers);
    if (cookie && !all.has("cookie")) all.set("cookie", cookie);
    if (method !== "GET" && !all.has("origin")) {
      all.set("origin", origin);
      all.set("content-type", "application/json");
    }
    return fetch(`${baseUrl}${path}`, {
      method, headers: all, body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(5_000),
    });
  }
  try {
    await eventually(async () => {
      if (child.child.exitCode !== null) throw new Error(`Hub exited before startup: ${await child.stop()}`);
      try { return (await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).ok ? true : undefined; }
      catch { return undefined; }
    }, "Hub readiness");
    const login = await request("/api/auth/login", "POST", { password });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    return { request, stop: child.stop };
  } catch (error) {
    await child.stop();
    throw error;
  }
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return await response.json() as T;
}

async function seedAgent(db: SQL, hostname = "memory-fixture"): Promise<string> {
  const [host] = await db`INSERT INTO agents(hostname,token_hash) VALUES(${hostname},'not-an-agent-token') RETURNING id`;
  return host.id as string;
}

async function seedIncident(db: SQL, agentId: string, title: string, category = "manual"): Promise<string> {
  const [incident] = await db`INSERT INTO incidents(agent_id,title,category) VALUES(${agentId},${title},${category}) RETURNING id`;
  return incident.id as string;
}

async function seedProvider(db: SQL): Promise<{ id: string; revision: number }> {
  const id = randomUUID();
  await db`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,revision,api_key_ciphertext)
    VALUES(${id},'Memory fixture','openai-compatible','https://provider.example/v1','fixture-model',true,1,
      ${encryptProviderKey(id, dummyKey, masterKey)})`;
  return { id, revision: 1 };
}

async function insertJob(db: SQL, incidentId: string, provider: { id: string; revision: number }): Promise<string> {
  const [row] = await db`INSERT INTO investigations(
      incident_id,provider_id,provider_revision,provider_name,provider_protocol,provider_base_url,provider_model,
      status,attempts,max_attempts,dedupe_key
    ) VALUES(
      ${incidentId},${provider.id},${provider.revision},'Memory fixture','openai-compatible','https://provider.example/v1','fixture-model',
      'queued',0,3,${randomUUID()}
    ) RETURNING id`;
  return row.id as string;
}

type MemoryRow = {
  id: string;
  incident_id: string;
  summary: string;
  resolution: string;
  occurrence_count: number;
  canonical_memory_id: string | null;
  content_fingerprint: string | null;
};

async function memoryRows(db: SQL): Promise<MemoryRow[]> {
  return await db<MemoryRow[]>`SELECT id,incident_id,summary,resolution,occurrence_count,canonical_memory_id,content_fingerprint FROM incident_memory ORDER BY created_at`;
}

integration("resolving repeat incidents deduplicates into one canonical memory with full source provenance", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const hub = await startHub(url);
    try {
      const agentId = await seedAgent(db);
      const i1 = await seedIncident(db, agentId, "Nginx port 443 listening failure", "manual");
      const i2 = await seedIncident(db, agentId, "Nginx again not listening on 443", "manual");
      const i3 = await seedIncident(db, agentId, "Third nginx 443 outage", "manual");
      const i4 = await seedIncident(db, agentId, "Backup disk quota exhausted", "disk");

      const first = await json<{ ok: boolean; memoryId: string; deduplicated: boolean; occurrenceCount: number }>(
        await hub.request(`/api/incidents/${i1}/resolve`, "POST", { resolution: RESOLUTION_A }), 200);
      expect(first).toEqual({ ok: true, memoryId: first.memoryId, deduplicated: false, occurrenceCount: 1 });
      expect(first.memoryId).toMatch(/^[0-9a-f-]{36}$/);

      // Identical resolution on another incident merges into the same canonical memory.
      const second = await json<{ memoryId: string; deduplicated: boolean; occurrenceCount: number }>(
        await hub.request(`/api/incidents/${i2}/resolve`, "POST", { resolution: ` ${RESOLUTION_A.toUpperCase()}! ` }), 200);
      expect(second.memoryId).toBe(first.memoryId);
      expect(second.deduplicated).toBe(true);
      expect(second.occurrenceCount).toBe(2);

      // Near-identical resolution (one extra word) still deduplicates.
      const third = await json<{ memoryId: string; deduplicated: boolean; occurrenceCount: number }>(
        await hub.request(`/api/incidents/${i3}/resolve`, "POST", { resolution: RESOLUTION_A_NEAR }), 200);
      expect(third.memoryId).toBe(first.memoryId);
      expect(third.deduplicated).toBe(true);
      expect(third.occurrenceCount).toBe(3);

      // A distinct resolution creates a separate canonical memory.
      const fourth = await json<{ memoryId: string; deduplicated: boolean; occurrenceCount: number }>(
        await hub.request(`/api/incidents/${i4}/resolve`, "POST", { resolution: RESOLUTION_DISTINCT }), 200);
      expect(fourth.memoryId).not.toBe(first.memoryId);
      expect(fourth.deduplicated).toBe(false);
      expect(fourth.occurrenceCount).toBe(1);

      const rows = await memoryRows(db);
      expect(rows.length).toBe(2);
      const canonical = rows.filter((row) => row.canonical_memory_id === null);
      expect(canonical.length).toBe(2);
      const merged = rows.find((row) => row.id === first.memoryId)!;
      expect(merged.occurrence_count).toBe(3);
      expect(merged.content_fingerprint).toBe(memoryFingerprint("Nginx port 443 listening failure", RESOLUTION_A));

      // Every contributing incident remains traceable via incident_memory_sources.
      const sources = await db<{ memory_id: string; incident_id: string; hostname: string | null; category: string | null }[]>`
        SELECT memory_id,incident_id,hostname,category FROM incident_memory_sources ORDER BY incident_id`;
      expect(sources.length).toBe(4);
      const firstSources = sources.filter((row) => row.memory_id === first.memoryId);
      expect(firstSources.map((row) => row.incident_id).sort()).toEqual([i1, i2, i3].sort());
      expect(firstSources.every((row) => row.hostname === "memory-fixture")).toBe(true);
      expect(firstSources.every((row) => row.category === "manual")).toBe(true);

      // GET /api/memory returns canonical records with provenance and counts.
      const list = await json<IncidentMemoryRecord[]>(await hub.request("/api/memory"));
      expect(list.length).toBe(2);
      const record = list.find((m) => m.id === first.memoryId)!;
      expect(record.occurrence_count).toBe(3);
      expect(record.sources.length).toBe(3);
      expect(record.sources.every((s) => typeof s.resolved_at === "string" && s.hostname === "memory-fixture")).toBe(true);
      expect(record.sources.map((s) => s.incident_id).sort()).toEqual([i1, i2, i3].sort());
      // FTS query filters canonical memories only.
      const searched = await json<IncidentMemoryRecord[]>(await hub.request(`/api/memory?q=${encodeURIComponent("nginx 443")}`));
      expect(searched.length).toBe(1);
      expect(searched[0].id).toBe(first.memoryId);

      // Non-secret audit trail.
      const audits = await db<{ action: string; data: Record<string, unknown> }[]>`
        SELECT action,data FROM audit_events WHERE action IN ('memory.created','memory.deduplicated') ORDER BY id`;
      expect(audits.filter((a) => a.action === "memory.created").length).toBe(2);
      const dedupAudits = audits.filter((a) => a.action === "memory.deduplicated");
      expect(dedupAudits.length).toBe(2);
      expect(dedupAudits.map((a) => a.data.occurrenceCount).sort()).toEqual([2, 3]);
      expect(dedupAudits.every((a) => a.data.memoryId === first.memoryId && typeof a.data.incidentId === "string")).toBe(true);
    } finally {
      const logs = await hub.stop();
      expect(logs).not.toContain(dummyKey);
    }
  });
}, 60_000);

integration("POST /api/memory/merge enforces auth and origin, rejects invalid requests, and merges with provenance", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const hub = await startHub(url);
    try {
      const agentId = await seedAgent(db);
      const i1 = await seedIncident(db, agentId, "Nginx port 443 listening failure");
      const i2 = await seedIncident(db, agentId, "Backup disk quota exhausted", "disk");
      const r1 = await json<{ memoryId: string }>(await hub.request(`/api/incidents/${i1}/resolve`, "POST", { resolution: RESOLUTION_A }), 200);
      const r2 = await json<{ memoryId: string }>(await hub.request(`/api/incidents/${i2}/resolve`, "POST", { resolution: RESOLUTION_DISTINCT }), 200);

      // Unauthenticated: 401.
      const anon = await hub.request("/api/memory/merge", "POST", { sourceMemoryId: r2.memoryId, targetMemoryId: r1.memoryId }, { cookie: "", origin });
      expect(anon.status).toBe(401);

      // Authenticated but wrong Origin: 403.
      const badOrigin = await hub.request("/api/memory/merge", "POST",
        { sourceMemoryId: r2.memoryId, targetMemoryId: r1.memoryId },
        { origin: "https://evil.example" });
      expect(badOrigin.status).toBe(403);

      // Self-merge: 400.
      const selfMerge = await json<{ error: string }>(await hub.request("/api/memory/merge", "POST", { sourceMemoryId: r1.memoryId, targetMemoryId: r1.memoryId }), 400);
      expect(selfMerge.error).toBeTruthy();

      // Malformed UUID / unknown key: 400.
      expect((await hub.request("/api/memory/merge", "POST", { sourceMemoryId: "nope", targetMemoryId: r1.memoryId })).status).toBe(400);
      expect((await hub.request("/api/memory/merge", "POST", { sourceMemoryId: r2.memoryId, targetMemoryId: r1.memoryId, extra: 1 })).status).toBe(400);

      // Unknown but well-formed IDs: 404.
      const missing = randomUUID();
      expect((await hub.request("/api/memory/merge", "POST", { sourceMemoryId: missing, targetMemoryId: r1.memoryId })).status).toBe(404);

      // Successful merge: sources move, source becomes non-canonical, counts recompute.
      const merged = await json<{ ok: boolean; memory: IncidentMemoryRecord }>(
        await hub.request("/api/memory/merge", "POST", { sourceMemoryId: r2.memoryId, targetMemoryId: r1.memoryId }), 200);
      expect(merged.ok).toBe(true);
      expect(merged.memory.id).toBe(r1.memoryId);
      expect(merged.memory.occurrence_count).toBe(2);
      expect(merged.memory.sources.map((s) => s.incident_id).sort()).toEqual([i1, i2].sort());

      const rows = await memoryRows(db);
      const source = rows.find((row) => row.id === r2.memoryId)!;
      expect(source.canonical_memory_id).toBe(r1.memoryId);
      const target = rows.find((row) => row.id === r1.memoryId)!;
      expect(target.canonical_memory_id).toBeNull();
      expect(target.occurrence_count).toBe(2);
      const sourceCount = await db`SELECT COUNT(*)::int AS n FROM incident_memory_sources WHERE memory_id=${r2.memoryId}`;
      expect(sourceCount[0].n).toBe(0);
      const targetSources = await db`SELECT incident_id FROM incident_memory_sources WHERE memory_id=${r1.memoryId} ORDER BY incident_id`;
      expect(targetSources.map((row) => row.incident_id)).toEqual([i1, i2].sort());

      // GET /api/memory only lists the canonical survivor.
      const list = await json<IncidentMemoryRecord[]>(await hub.request("/api/memory"));
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(r1.memoryId);
      expect(list[0].occurrence_count).toBe(2);

      // Merging an already-merged source again: 409.
      expect((await hub.request("/api/memory/merge", "POST", { sourceMemoryId: r2.memoryId, targetMemoryId: r1.memoryId })).status).toBe(409);

      // Non-secret audit event.
      const audits = await db<{ action: string; data: Record<string, unknown> }[]>`
        SELECT action,data FROM audit_events WHERE action='memory.merged'`;
      expect(audits.length).toBe(1);
      expect(audits[0].data.sourceMemoryId).toBe(r2.memoryId);
      expect(audits[0].data.targetMemoryId).toBe(r1.memoryId);
      expect(audits[0].data.occurrenceCount).toBe(2);
    } finally {
      await hub.stop();
    }
  });
}, 60_000);

integration("worker investigation deduplicates canonical memories and persists retrieved_memories_json", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const hub = await startHub(url);
    try {
      const provider = await seedProvider(db);
      const agentId = await seedAgent(db);
      // One resolved incident seeds the canonical memory (with source provenance).
      const seeded = await seedIncident(db, agentId, "Nginx port 443 listening failure seed");
      await json(await hub.request(`/api/incidents/${seeded}/resolve`, "POST", { resolution: RESOLUTION_A }), 200);
      // A second, near-duplicate canonical memory that also matches the FTS query.
      const [dupRow] = await db`INSERT INTO incidents(agent_id,title,category) VALUES(${agentId},'Nginx port 443 listening failure duplicate seed','manual') RETURNING id`;
      await db`INSERT INTO incident_memory(incident_id,summary,resolution,content_fingerprint,occurrence_count)
        VALUES(${dupRow.id},${"Nginx port 443 listening failure"},${RESOLUTION_A_NEAR},${memoryFingerprint("Nginx port 443 listening failure", RESOLUTION_A_NEAR)},1)`;
      await db`INSERT INTO incident_memory_sources(memory_id,incident_id,agent_id,hostname,category,incident_title,resolved_at)
        SELECT id,${dupRow.id},${agentId},'memory-fixture','manual','Nginx port 443 listening failure duplicate seed',NOW() FROM incident_memory WHERE incident_id=${dupRow.id}`;

      // The incident under investigation matches both memories by FTS.
      const incidentId = await seedIncident(db, agentId, "Nginx port 443 listening failure");
      const jobId = await insertJob(db, incidentId, provider);

      let seenMemories: unknown[] = [];
      const captureGenerate: typeof generateDiagnosis = async (_connection, _incident, _evidence, memories) => {
        seenMemories = memories;
        return diagnosis("nginx restart");
      };
      expect(await runOneInvestigation(db, masterKey, captureGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);

      // Near-duplicate canonical memories were collapsed before the LLM call.
      expect(seenMemories.length).toBe(1);
      expect((seenMemories[0] as { id: string }).id).toBeTruthy();

      const [row] = await db<{ status: string; retrieved_memories_json: Record<string, unknown>[] | null }[]>`
        SELECT status,retrieved_memories_json FROM investigations WHERE id=${jobId}`;
      expect(row.status).toBe("completed");
      expect(Array.isArray(row.retrieved_memories_json)).toBe(true);
      const attribution = row.retrieved_memories_json!;
      expect(attribution.length).toBe(1);
      expect(attribution[0].memory_id).toBe((seenMemories[0] as { id: string }).id);
      expect(attribution[0].retrieval_method).toBe("fts");
      expect(attribution[0].occurrence_count).toBe(1);
      // The surviving deduplicated memory is the newer near-duplicate row, so its source
      // is the duplicate seed incident (both memories matched FTS; only one was used).
      expect(attribution[0].source_incident_ids).toEqual([dupRow.id]);
      expect(typeof attribution[0].resolution_preview).toBe("string");

      // GET /api/incidents/:id exposes retrieved_memories on the investigation object.
      const detail = await json<{ investigations: { id: string; status: string; retrieved_memories: Record<string, unknown>[] | null }[] }>(
        await hub.request(`/api/incidents/${incidentId}`));
      const investigation = detail.investigations.find((item) => item.id === jobId)!;
      expect(investigation.retrieved_memories).not.toBeNull();
      expect(investigation.retrieved_memories!.length).toBe(1);
      expect(investigation.retrieved_memories![0].memory_id).toBe(attribution[0].memory_id);
      expect(investigation.retrieved_memories![0].source_incident_ids).toEqual([dupRow.id]);
    } finally {
      await hub.stop();
    }
  });
}, 60_000);
