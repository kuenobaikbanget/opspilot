import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import type { AiProvider, Diagnosis } from "../packages/contracts/src/index";
import type { generateDiagnosis } from "../packages/ai/src/index";
import { encryptProviderKey, readProviderMasterKey } from "../packages/ai/src/credentials";
import { ProviderError } from "../packages/ai/src/provider-http";
import { recoverExpiredLeases, runOneInvestigation } from "../apps/worker/src/jobs";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

const integration = providerTestDatabaseAvailable ? test : test.skip;
const root = new URL("../", import.meta.url).pathname;
const master = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const masterKey = readProviderMasterKey({ AI_PROVIDER_ENCRYPTION_KEY: master })!;
const dummyKey = "sk-opspilot-reliability-integration-only-dummy-key";
const origin = "http://localhost:3100";
const password = "opspilot-reliability-integration-only-password";
const providerPath = "/api/ai/providers";

type ProviderSeed = { id: string; revision: number };
type JobOverrides = {
  status?: string;
  attempts?: number;
  max_attempts?: number;
  worker_id?: string | null;
  lease_expires_at?: Date | null;
  next_retry_at?: Date | null;
  dedupe_key?: string | null;
};
type Hub = {
  request(path: string, method?: string, data?: unknown): Promise<Response>;
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

function deferred() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: resolve };
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
    SESSION_SECRET: "opspilot-disposable-reliability-integration-session-secret",
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
  async function request(path: string, method = "GET", data?: unknown): Promise<Response> {
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    if (method !== "GET") {
      headers.set("origin", origin);
      headers.set("content-type", "application/json");
    }
    return fetch(`${baseUrl}${path}`, {
      method, headers, body: data === undefined ? undefined : JSON.stringify(data),
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

async function seedProvider(db: SQL): Promise<ProviderSeed> {
  const id = randomUUID();
  await db`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,revision,api_key_ciphertext)
    VALUES(${id},'Reliability fixture','openai-compatible','https://provider.example/v1','fixture-model',true,1,
      ${encryptProviderKey(id, dummyKey, masterKey)})`;
  return { id, revision: 1 };
}

async function seedIncident(db: SQL): Promise<string> {
  const [host] = await db`INSERT INTO agents(hostname,token_hash) VALUES('reliability-fixture','not-an-agent-token') RETURNING id`;
  const [incident] = await db`INSERT INTO incidents(agent_id,title,category) VALUES(${host.id},'Reliability lease fixture','disk') RETURNING id`;
  return incident.id as string;
}

async function insertJob(db: SQL, incidentId: string, provider: ProviderSeed, overrides: JobOverrides = {}): Promise<string> {
  const [row] = await db`INSERT INTO investigations(
      incident_id,provider_id,provider_revision,provider_name,provider_protocol,provider_base_url,provider_model,
      status,attempts,max_attempts,worker_id,lease_expires_at,next_retry_at,dedupe_key
    ) VALUES(
      ${incidentId},${provider.id},${provider.revision},'Reliability fixture','openai-compatible','https://provider.example/v1','fixture-model',
      ${overrides.status ?? "queued"},${overrides.attempts ?? 0},${overrides.max_attempts ?? 3},
      ${overrides.worker_id ?? null},${overrides.lease_expires_at ?? null},${overrides.next_retry_at ?? null},${overrides.dedupe_key ?? null}
    ) RETURNING id`;
  return row.id as string;
}

type JobRow = {
  status: string;
  error: string | null;
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
  lease_expires_at: Date | null;
  next_retry_at: Date | null;
  completed_at: Date | null;
  result_json: Diagnosis | null;
};
async function jobRow(db: SQL, id: string): Promise<JobRow> {
  const [row] = await db<JobRow[]>`SELECT status,error,attempts,max_attempts,worker_id,lease_expires_at,next_retry_at,completed_at,result_json
    FROM investigations WHERE id=${id}`;
  return row;
}

integration("expired leases are recovered: requeued inside the budget, terminalized at the budget", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const provider = await seedProvider(db);
    const incidentId = await seedIncident(db);
    const expired = new Date(Date.now() - 1_000);
    const requeueJob = await insertJob(db, incidentId, provider, {
      status: "running", attempts: 1, max_attempts: 3, worker_id: "dead-worker", lease_expires_at: expired,
    });
    const spentJob = await insertJob(db, incidentId, provider, {
      status: "running", attempts: 3, max_attempts: 3, worker_id: "dead-worker", lease_expires_at: expired,
    });
    // A live lease must not be recovered.
    const liveJob = await insertJob(db, incidentId, provider, {
      status: "running", attempts: 1, max_attempts: 3, worker_id: "live-worker", lease_expires_at: new Date(Date.now() + 60_000),
    });

    expect(await recoverExpiredLeases(db)).toBe(true);

    const requeued = await jobRow(db, requeueJob);
    expect(requeued.status).toBe("queued");
    expect(requeued.error).toBe("worker_lease_expired");
    expect(requeued.lease_expires_at).toBeNull();
    expect(requeued.worker_id).toBeNull();
    expect(requeued.next_retry_at).not.toBeNull();
    expect(requeued.attempts).toBe(1);
    expect(requeued.completed_at).toBeNull();

    const spent = await jobRow(db, spentJob);
    expect(spent.status).toBe("failed");
    expect(spent.error).toBe("worker_lease_expired");
    expect(spent.lease_expires_at).toBeNull();
    expect(spent.worker_id).toBeNull();
    expect(spent.completed_at).not.toBeNull();

    const live = await jobRow(db, liveJob);
    expect(live.status).toBe("running");
    expect(live.worker_id).toBe("live-worker");

    const audits = await db<{ action: string; data: { workerId: string; attempts: number; maxAttempts: number; outcome: string } }[]>`
      SELECT action,data FROM audit_events WHERE action='investigation.lease_expired' ORDER BY id`;
    expect(audits.length).toBe(2);
    expect(audits.map((row) => row.data.outcome).sort()).toEqual(["failed", "requeued"]);
    expect(audits.every((row) => row.data.workerId === "dead-worker")).toBe(true);

    // Nothing left to recover.
    expect(await recoverExpiredLeases(db)).toBe(false);

    // The requeued job is immediately claimable by the next worker and completes.
    let calls = 0;
    const okGenerate: typeof generateDiagnosis = async () => { calls++; return diagnosis("recovered"); };
    expect(await runOneInvestigation(db, masterKey, okGenerate, { workerId: "next-worker", retryBackoffMs: 0 })).toBe(true);
    const done = await jobRow(db, requeueJob);
    expect(done.status).toBe("completed");
    expect(done.error).toBeNull();
    expect(done.attempts).toBe(2);
    expect(done.result_json?.probable_cause).toBe("recovered");
    expect(done.worker_id).toBeNull();
    expect(done.lease_expires_at).toBeNull();
    expect(calls).toBe(1);
  });
}, 30_000);

integration("a stale worker whose lease was recovered cannot overwrite the new owner's state", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const provider = await seedProvider(db);
    const incidentId = await seedIncident(db);
    const jobId = await insertJob(db, incidentId, provider);

    const gate = deferred();
    let calls = 0;
    // The stale worker hangs inside the provider call until its lease is taken over.
    const staleGenerate: typeof generateDiagnosis = async () => {
      calls++;
      await gate.promise;
      throw new ProviderError("provider_timeout"); // retryable, but the guard must block it
    };
    const pending = runOneInvestigation(db, masterKey, staleGenerate, { workerId: "stale-worker", leaseMs: 60_000 });
    await eventually(async () => (calls === 1 ? true : undefined), "stale worker claim");
    let row = await jobRow(db, jobId);
    expect(row.status).toBe("running");
    expect(row.worker_id).toBe("stale-worker");
    expect(row.attempts).toBe(1);
    expect(row.lease_expires_at).not.toBeNull();

    // Lease expires; recovery requeues the job inside its budget.
    await db`UPDATE investigations SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=${jobId}`;
    expect(await recoverExpiredLeases(db)).toBe(true);
    row = await jobRow(db, jobId);
    expect(row.status).toBe("queued");
    expect(row.error).toBe("worker_lease_expired");

    // A fresh worker claims it and fails permanently (HTTP 400 is never retried).
    const failGenerate: typeof generateDiagnosis = async () => { throw new ProviderError("provider_http", 400); };
    expect(await runOneInvestigation(db, masterKey, failGenerate, { workerId: "fresh-worker", retryBackoffMs: 0 })).toBe(true);
    row = await jobRow(db, jobId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("provider_http");
    expect(row.attempts).toBe(2);
    expect(row.worker_id).toBeNull();

    // The stale worker wakes up; neither its completion nor its retry may touch the row.
    gate.release();
    expect(await pending).toBe(true);
    row = await jobRow(db, jobId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("provider_http");
    expect(row.attempts).toBe(2);
    expect(row.result_json).toBeNull();
  });
}, 30_000);

integration("transient failures requeue with backoff until max_attempts, then fail terminally", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const provider = await seedProvider(db);
    const incidentId = await seedIncident(db);
    const jobId = await insertJob(db, incidentId, provider);

    let calls = 0;
    const timeoutGenerate: typeof generateDiagnosis = async () => { calls++; throw new ProviderError("provider_timeout"); };
    const okGenerate: typeof generateDiagnosis = async () => diagnosis("should-not-run");

    // Attempt 1: requeued with a future next_retry_at (backoff), not claimable yet.
    expect(await runOneInvestigation(db, masterKey, timeoutGenerate, { workerId: "w", retryBackoffMs: 60_000 })).toBe(true);
    let row = await jobRow(db, jobId);
    expect(row.status).toBe("queued");
    expect(row.error).toBe("provider_timeout");
    expect(row.attempts).toBe(1);
    expect(row.next_retry_at).not.toBeNull();
    expect(row.next_retry_at!.getTime()).toBeGreaterThan(Date.now());
    expect(row.lease_expires_at).toBeNull();
    expect(row.worker_id).toBeNull();
    // A job waiting on its retry budget is not claimed.
    expect(await runOneInvestigation(db, masterKey, okGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(false);
    row = await jobRow(db, jobId);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);

    // Attempt 2: budget still available, requeued again with a larger backoff.
    await db`UPDATE investigations SET next_retry_at=NOW()-INTERVAL '1 second' WHERE id=${jobId}`;
    expect(await runOneInvestigation(db, masterKey, timeoutGenerate, { workerId: "w", retryBackoffMs: 60_000 })).toBe(true);
    row = await jobRow(db, jobId);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(2);
    expect(row.next_retry_at!.getTime()).toBeGreaterThan(Date.now());

    // Attempt 3: budget exhausted (attempts == max_attempts), terminal failure.
    await db`UPDATE investigations SET next_retry_at=NOW()-INTERVAL '1 second' WHERE id=${jobId}`;
    expect(await runOneInvestigation(db, masterKey, timeoutGenerate, { workerId: "w", retryBackoffMs: 60_000 })).toBe(true);
    row = await jobRow(db, jobId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("provider_timeout");
    expect(row.attempts).toBe(3);
    expect(row.completed_at).not.toBeNull();
    expect(row.lease_expires_at).toBeNull();
    expect(row.worker_id).toBeNull();
    expect(calls).toBe(3);
    // Nothing left to claim.
    expect(await runOneInvestigation(db, masterKey, okGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(false);
  });
}, 30_000);

integration("HTTP 429 and 5xx are retried; a later success completes within the budget", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const provider = await seedProvider(db);
    const incidentId = await seedIncident(db);
    const jobId = await insertJob(db, incidentId, provider);

    let calls = 0;
    const flakyGenerate: typeof generateDiagnosis = async () => {
      calls++;
      if (calls === 1) throw new ProviderError("provider_http", 429);
      if (calls === 2) throw new ProviderError("provider_http", 503);
      return diagnosis("flaky-recovered");
    };
    for (const expected of ["queued", "queued", "completed"] as const) {
      expect(await runOneInvestigation(db, masterKey, flakyGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
      const row = await jobRow(db, jobId);
      expect(row.status).toBe(expected);
    }
    const row = await jobRow(db, jobId);
    expect(row.attempts).toBe(3);
    expect(row.error).toBeNull();
    expect(row.result_json?.probable_cause).toBe("flaky-recovered");
    expect(calls).toBe(3);
  });
}, 30_000);

integration("permanent errors fail immediately on attempt 1 without any retry", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const provider = await seedProvider(db);
    const incidentId = await seedIncident(db);

    // Provider-call permanent errors: HTTP 4xx (other than 429) and invalid responses.
    for (const [makeError, expected] of [
      [() => new ProviderError("provider_http", 400), "provider_http"],
      [() => new ProviderError("provider_http", 403), "provider_http"],
      [() => new ProviderError("provider_invalid_response"), "provider_invalid_response"],
    ] as const) {
      const jobId = await insertJob(db, incidentId, provider);
      let calls = 0;
      const failGenerate: typeof generateDiagnosis = async () => { calls++; throw makeError(); };
      expect(await runOneInvestigation(db, masterKey, failGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
      const row = await jobRow(db, jobId);
      expect(row.status).toBe("failed");
      expect(row.error).toBe(expected);
      expect(row.attempts).toBe(1);
      expect(row.completed_at).not.toBeNull();
      expect(calls).toBe(1);
      // No requeue happened: nothing is claimable afterwards.
      expect(await runOneInvestigation(db, masterKey, failGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(false);
      expect(calls).toBe(1);
    }

    // Configuration permanent errors fail before any outbound call.
    const changedJob = await insertJob(db, incidentId, provider);
    await db`UPDATE ai_providers SET revision=revision+1 WHERE id=${provider.id}`;
    let calls = 0;
    const okGenerate: typeof generateDiagnosis = async () => { calls++; return diagnosis("never"); };
    expect(await runOneInvestigation(db, masterKey, okGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
    let row = await jobRow(db, changedJob);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("provider_changed");
    expect(row.attempts).toBe(1);
    expect(calls).toBe(0);
    // Restore the revision the remaining fixtures were inserted with.
    await db`UPDATE ai_providers SET revision=${provider.revision} WHERE id=${provider.id}`;

    const disabledJob = await insertJob(db, incidentId, provider);
    await db`UPDATE ai_providers SET enabled=false WHERE id=${provider.id}`;
    expect(await runOneInvestigation(db, masterKey, okGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
    row = await jobRow(db, disabledJob);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("provider_disabled");
    expect(row.attempts).toBe(1);

    const credentialJob = await insertJob(db, incidentId, provider);
    await db`UPDATE ai_providers SET enabled=true, api_key_ciphertext='v1.corrupted.ciphertext.tag' WHERE id=${provider.id}`;
    expect(await runOneInvestigation(db, masterKey, okGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
    row = await jobRow(db, credentialJob);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("credential_unavailable");
    expect(row.attempts).toBe(1);
    expect(calls).toBe(0);
  });
}, 30_000);

integration("the partial unique index atomically rejects duplicate active dedupe keys", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const provider = await seedProvider(db);
    const incidentId = await seedIncident(db);
    const key = "ab".repeat(32);
    await insertJob(db, incidentId, provider, { dedupe_key: key, status: "queued" });
    for (const status of ["queued", "running"]) {
      let errno: unknown;
      try {
        await insertJob(db, incidentId, provider, { dedupe_key: key, status });
      } catch (error) {
        errno = (error as { errno?: unknown }).errno;
      }
      expect(String(errno)).toBe("23505");
    }
    // Terminal rows never collide: a fresh investigation is allowed after completion/failure.
    await insertJob(db, incidentId, provider, { dedupe_key: key, status: "completed" });
    await insertJob(db, incidentId, provider, { dedupe_key: key, status: "failed" });
    expect((await db`SELECT id FROM investigations WHERE dedupe_key=${key}`).length).toBe(3);
  });
}, 30_000);

integration("investigate endpoint deduplicates active investigations and allows fresh ones after terminal state", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const hub = await startHub(url);
    try {
      const created = await json<{ provider: AiProvider }>(await hub.request(providerPath, "POST", {
        name: "Reliability hub fixture", protocol: "openai-compatible",
        baseUrl: "https://provider.example/v1", apiKey: dummyKey, defaultModel: "fixture-model", enabled: true,
      }), 201);
      const provider = created.provider;
      const incidentId = await seedIncident(db);
      const body = { providerId: provider.id, providerRevision: provider.revision, model: "m" };
      const investigatePath = `/api/incidents/${incidentId}/investigate`;

      const first = await json<{ id: string; status: string; deduplicated: boolean; liveAgent: boolean }>(
        await hub.request(investigatePath, "POST", body), 202);
      expect(first.status).toBe("queued");
      expect(first.deduplicated).toBe(false);
      expect(first.liveAgent).toBe(false);

      // Same parameters while active: returns the existing row, no duplicate.
      const second = await json<{ id: string; status: string; deduplicated: boolean }>(
        await hub.request(investigatePath, "POST", body), 202);
      expect(second.id).toBe(first.id);
      expect(second.status).toBe("queued");
      expect(second.deduplicated).toBe(true);

      // Concurrent identical requests: exactly one row, one deduplicated response.
      const concurrentBody = { ...body, model: "concurrent" };
      const [r1, r2] = await Promise.all([
        json<{ id: string; deduplicated: boolean }>(await hub.request(investigatePath, "POST", concurrentBody), 202),
        json<{ id: string; deduplicated: boolean }>(await hub.request(investigatePath, "POST", concurrentBody), 202),
      ]);
      expect(r1.id).toBe(r2.id);
      expect([r1.deduplicated, r2.deduplicated].sort()).toEqual([false, true]);

      // A different model is a different investigation.
      const other = await json<{ id: string; deduplicated: boolean }>(
        await hub.request(investigatePath, "POST", { ...body, model: "other" }), 202);
      expect(other.id).not.toBe(first.id);
      expect(other.deduplicated).toBe(false);
      expect((await db`SELECT id FROM investigations WHERE incident_id=${incidentId}`).length).toBe(3);

      // Stored dedupe key is a deterministic SHA-256 hex scoped to the request parameters.
      const [row] = await db`SELECT dedupe_key,attempts,max_attempts FROM investigations WHERE id=${first.id}`;
      expect(row.dedupe_key).toMatch(/^[a-f0-9]{64}$/);
      expect(row.attempts).toBe(0);
      expect(row.max_attempts).toBe(3);

      // GET exposes the reliability fields.
      const detail = await json<{ investigations: Record<string, unknown>[] }>(await hub.request(`/api/incidents/${incidentId}`));
      const entry = detail.investigations.find((item) => item.id === first.id)!;
      expect(entry.attempts).toBe(0);
      expect(entry.max_attempts).toBe(3);
      expect(entry).toHaveProperty("next_retry_at");
      expect(entry).toHaveProperty("lease_expires_at");

      // Run all active investigations to completion; the same request must then create a fresh row.
      const okGenerate: typeof generateDiagnosis = async () => diagnosis("done");
      expect(await runOneInvestigation(db, masterKey, okGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
      expect(await runOneInvestigation(db, masterKey, okGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
      expect(await runOneInvestigation(db, masterKey, okGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
      expect((await db`SELECT status FROM investigations WHERE incident_id=${incidentId}`).every((r) => r.status === "completed")).toBe(true);

      const fourth = await json<{ id: string; deduplicated: boolean }>(await hub.request(investigatePath, "POST", body), 202);
      expect(fourth.deduplicated).toBe(false);
      expect(fourth.id).not.toBe(first.id);
      expect((await db`SELECT id FROM investigations WHERE incident_id=${incidentId}`).length).toBe(4);
    } finally {
      const logs = await hub.stop();
      expect(logs).not.toContain(dummyKey);
    }
  });
}, 60_000);
