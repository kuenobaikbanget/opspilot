import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { encryptProviderKey, readProviderMasterKey } from "../packages/ai/src/credentials";
import { hasPgVector, searchIncidentMemories } from "../apps/hub/src/memory-retrieval";
import { indexPendingMemoryEmbeddings, memoryEmbeddingsEnabled } from "../apps/worker/src/memory-embeddings";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";
import { conceptEmbedding, ftsRank } from "./memory-retrieval-fixtures/harness";
import { MEMORY_RECORDS, QUERY_CASES } from "./memory-retrieval-fixtures/corpus";

const integration = providerTestDatabaseAvailable ? test : test.skip;
const root = new URL("../", import.meta.url).pathname;
const master = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const masterKey = readProviderMasterKey({ AI_PROVIDER_ENCRYPTION_KEY: master })!;

async function migrate(url: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(root, "tools/migrate.ts")], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test", DATABASE_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: expect.stringContaining("014_memory_embeddings_hybrid.sql") });
}

async function withMigratedDb<T>(callback: (db: SQL, url: string) => Promise<T>): Promise<T> {
  return withProviderTestDb(async (db, url) => {
    await migrate(url);
    return callback(db, url);
  });
}

/** Seeds one agent + one incident per corpus memory, returning corpusId -> memory uuid. */
async function seedMemories(db: SQL, records = MEMORY_RECORDS): Promise<Map<string, string>> {
  const agentId = randomUUID();
  await db`INSERT INTO agents(id,hostname,token_hash) VALUES (${agentId},'memory-eval-host','dummy-hash')`;
  const ids = new Map<string, string>();
  for (const record of records) {
    const incidentId = randomUUID();
    const memoryId = randomUUID();
    await db`INSERT INTO incidents(id,agent_id,title,category,status,resolution) VALUES (${incidentId},${agentId},${record.summary},'repeat','resolved',${record.resolution})`;
    await db`INSERT INTO incident_memory(id,incident_id,summary,resolution,created_at,embedding_consent,embedded_at,embedding_values,embedding_dimensions,embedding_model)
      VALUES (${memoryId},${incidentId},${record.summary},${record.resolution},${record.created_at},TRUE,NOW(),${`{${conceptEmbedding(record.concepts).join(",")}}`}::float8[],${conceptEmbedding(record.concepts).length},'fixture-concept-embedding')`;
    ids.set(record.id, memoryId);
  }
  return ids;
}

integration("migration 014 applies cleanly on plain PostgreSQL 16 without pgvector", async () => {
  await withMigratedDb(async (db) => {
    const ledger = await db<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    expect(ledger.map((row) => row.name)).toContain("014_memory_embeddings_hybrid.sql");
    // Required nullable provenance columns exist.
    const columns = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'incident_memory'
      ORDER BY column_name`;
    const names = columns.map((row) => row.column_name);
    for (const required of [
      "embedding_values", "embedding_dimensions", "embedding_model",
      "embedding_provider_id", "embedded_at", "embedding_consent",
    ]) {
      expect(names).toContain(required);
    }
    // Plain postgres:16-alpine ships no pgvector: the conditional block must skip cleanly.
    const extensions = await db<{ extname: string }[]>`SELECT extname FROM pg_extension`;
    expect(extensions.map((row) => row.extname)).not.toContain("vector");
    expect(names).not.toContain("embedding_vector");
    expect(await hasPgVector(db)).toBe(false);
    // Partial indexes exist.
    const indexes = await db<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'incident_memory' ORDER BY indexname`;
    expect(indexes.map((row) => row.indexname)).toContain("idx_incident_memory_embedding_pending");
    expect(indexes.map((row) => row.indexname)).toContain("idx_incident_memory_embedded_at");
    // embedding_consent defaults to FALSE (opt-in).
    const agentId = randomUUID();
    await db`INSERT INTO agents(id,hostname,token_hash) VALUES (${agentId},'c','h')`;
    const incidentId = randomUUID();
    await db`INSERT INTO incidents(id,agent_id,title,category) VALUES (${incidentId},${agentId},'t','c')`;
    await db`INSERT INTO incident_memory(incident_id,summary,resolution) VALUES (${incidentId},'s','r')`;
    const row = await db<{ embedding_consent: boolean }[]>`SELECT embedding_consent FROM incident_memory WHERE incident_id=${incidentId}`;
    expect(row[0].embedding_consent).toBe(false);
  });
}, 60000);

integration("hybrid retrieval returns paraphrased repeat memory that PostgreSQL FTS alone misses", async () => {
  await withMigratedDb(async (db) => {
    const ids = await seedMemories(db);
    const paraphrase = QUERY_CASES.find((entry) => entry.id === "q-paraphrase-oom")!;
    const queryVector = conceptEmbedding(paraphrase.concepts);

    // Baseline: the real PostgreSQL FTS query (old behavior) misses the gold memory.
    const ftsOnly = await db<{ id: string }[]>`
      SELECT id FROM incident_memory
      WHERE to_tsvector('simple', summary || ' ' || resolution) @@ plainto_tsquery('simple', ${paraphrase.query})
      ORDER BY created_at DESC LIMIT 5`;
    expect(ftsOnly.map((row) => row.id)).not.toContain(ids.get("mem-oom-worker"));
    expect(ftsRank(paraphrase.query).map((item) => item.id).slice(0, 5)).not.toContain("mem-oom-worker");

    // searchIncidentMemories without a query vector is FTS-only and equally blind.
    const ftsSearch = await searchIncidentMemories(db, paraphrase.query, { limit: 5 });
    expect(ftsSearch.mode).toBe("fts");
    expect(ftsSearch.embedding_enabled).toBe(false);
    expect(ftsSearch.results.map((item) => item.id)).not.toContain(ids.get("mem-oom-worker"));
    expect(ftsSearch.results.every((item) => item.retrieval_method === "fts")).toBe(true);

    // Hybrid: stored embedding_values fallback (no pgvector here) fused via RRF finds it at top-1.
    const hybrid = await searchIncidentMemories(db, paraphrase.query, { queryVector, limit: 5 });
    expect(hybrid.mode).toBe("hybrid_rrf");
    expect(hybrid.embedding_enabled).toBe(true);
    expect(hybrid.pgvector_available).toBe(false);
    expect(hybrid.results[0].id).toBe(ids.get("mem-oom-worker"));
    expect(hybrid.results[0].retrieval_method).toBe("hybrid_rrf");
    expect(hybrid.results[0].vector_score).toBeGreaterThan(0.5);
    expect(hybrid.results[0].fts_score).toBeNull();
    expect(hybrid.results[0].hybrid_score).toBeGreaterThan(0);
    expect(hybrid.results[0].embedding_model).toBe("fixture-concept-embedding");

    // Exact-keyword repeat still works through the same path (FTS leg) and stays top-1.
    const exact = QUERY_CASES.find((entry) => entry.id === "q-exact-oom")!;
    const exactSearch = await searchIncidentMemories(db, exact.query, { queryVector: conceptEmbedding(exact.concepts), limit: 5 });
    expect(exactSearch.results[0].id).toBe(ids.get("mem-oom-worker"));
    expect(exactSearch.results[0].retrieval_method).toBe("hybrid_rrf");
    expect(exactSearch.results[0].fts_score).toBeGreaterThan(0);

    // Distractor query surfaces nothing in hybrid mode.
    const distractor = QUERY_CASES.find((entry) => entry.id === "q-distractor-printer")!;
    const distractorSearch = await searchIncidentMemories(db, distractor.query, {
      queryVector: conceptEmbedding(distractor.concepts),
      limit: 5,
    });
    expect(distractorSearch.results).toEqual([]);
  });
}, 60000);

integration("embedding indexer is opt-in and consent-gated", async () => {
  await withMigratedDb(async (db) => {
    expect(memoryEmbeddingsEnabled({})).toBe(false);
    expect(memoryEmbeddingsEnabled({ OPSPILOT_MEMORY_EMBEDDINGS_ENABLED: "true" })).toBe(true);

    const agentId = randomUUID();
    await db`INSERT INTO agents(id,hostname,token_hash) VALUES (${agentId},'idx-host','h')`;
    const incidentId = randomUUID();
    await db`INSERT INTO incidents(id,agent_id,title,category,status) VALUES (${incidentId},${agentId},'t','c','resolved')`;
    const memoryId = randomUUID();
    await db`INSERT INTO incident_memory(id,incident_id,summary,resolution,embedding_consent) VALUES (${memoryId},${incidentId},'sum','res',FALSE)`;

    const embedCalls: string[] = [];
    const embedFn = async (_connection: unknown, text: string) => {
      embedCalls.push(text);
      return { vector: conceptEmbedding(["linux", "kernel", "oom"]), dimensions: conceptEmbedding(["linux", "kernel", "oom"]).length, model: "fixture-model" };
    };

    // Disabled (env default) -> no-op even with a provider and master key.
    const providerId = randomUUID();
    await db`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,api_key_ciphertext)
      VALUES (${providerId},'embed','openai-compatible','https://embeddings.example/v1','text-embedding-3-small',TRUE,${encryptProviderKey(providerId, "sk-test-indexer-key-0123456789", masterKey)})`;
    expect(await indexPendingMemoryEmbeddings(db, masterKey, embedFn as never, { enabled: false })).toBe(0);
    // No master key -> no-op.
    expect(await indexPendingMemoryEmbeddings(db, null, embedFn as never, { enabled: true })).toBe(0);
    // Consent FALSE -> no-op.
    expect(await indexPendingMemoryEmbeddings(db, masterKey, embedFn as never, { enabled: true })).toBe(0);
    expect(embedCalls.length).toBe(0);
    let row = await db<{ embedded_at: string | null }[]>`SELECT embedded_at FROM incident_memory WHERE id=${memoryId}`;
    expect(row[0].embedded_at).toBeNull();

    // Anthropic-only deployment -> cleanly skipped (FTS-only), no embedding call.
    const anthropicId = randomUUID();
    await db`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,api_key_ciphertext)
      VALUES (${anthropicId},'ant','anthropic','https://api.anthropic.com/v1','claude-sonnet-4-5',TRUE,${encryptProviderKey(anthropicId, "sk-ant-test-indexer-key", masterKey)})`;
    await db`UPDATE ai_providers SET enabled=FALSE WHERE id=${providerId}`;
    await db`UPDATE incident_memory SET embedding_consent=TRUE WHERE id=${memoryId}`;
    expect(await indexPendingMemoryEmbeddings(db, masterKey, embedFn as never, { enabled: true })).toBe(0);
    expect(embedCalls.length).toBe(0);

    // Consented + embedding-capable provider -> embedded with provenance, redacted input.
    await db`UPDATE ai_providers SET enabled=TRUE WHERE id=${providerId}`;
    await db`UPDATE incident_memory SET summary='OOM killer terminated worker', resolution=${`resolution noted api_key=sk-live-secret-indexer-000111222333 and password=hunter2`} WHERE id=${memoryId}`;
    expect(await indexPendingMemoryEmbeddings(db, masterKey, embedFn as never, { enabled: true })).toBe(1);
    expect(embedCalls.length).toBe(1);
    expect(embedCalls[0]).toContain("[REDACTED]");
    expect(embedCalls[0]).not.toContain("sk-live-secret-indexer-000111222333");
    expect(embedCalls[0]).not.toContain("hunter2");
    row = await db<{ embedded_at: string | null; embedding_model: string | null; embedding_provider_id: string | null; embedding_dimensions: number | null; embedding_values: number[] | null }[]>`
      SELECT embedded_at, embedding_model, embedding_provider_id, embedding_dimensions, embedding_values FROM incident_memory WHERE id=${memoryId}`;
    expect(row[0].embedded_at).not.toBeNull();
    expect(row[0].embedding_model).toBe("fixture-model");
    expect(row[0].embedding_provider_id).toBe(providerId);
    expect(row[0].embedding_dimensions).toBeGreaterThan(0);
    expect(row[0].embedding_values?.length).toBe(row[0].embedding_dimensions);
    // Second tick finds nothing pending.
    expect(await indexPendingMemoryEmbeddings(db, masterKey, embedFn as never, { enabled: true })).toBe(0);
  });
}, 60000);
