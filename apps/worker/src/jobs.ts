import type { SQL } from "bun";
import { generateDiagnosis, generateDiagnosisWithUsage, supportsEmbeddings, generateEmbedding, type GeneratedEmbedding, type ProviderConnection } from "@opspilot/ai";
import { decryptProviderKey, ProviderCredentialError } from "@opspilot/ai/credentials";
import { ProviderError, type ProviderErrorCode } from "@opspilot/ai/provider-http";
import type { InvestigationMemoryAttribution, ProviderProtocol, RetrievedMemoryItem } from "@opspilot/contracts";
import { searchIncidentMemories } from "../../hub/src/memory-retrieval";
import { deduplicateMemoryCandidates, MEMORY_RETRIEVAL_LIMIT } from "../../hub/src/memory-dedup";
import { memoryEmbeddingsEnabled, type EmbedFn } from "./memory-embeddings";

type FailureCode = ProviderErrorCode | "provider_unavailable" | "provider_disabled" | "provider_changed" | "credential_unavailable" | "worker_lease_expired";
export type Failure = { code: FailureCode; httpStatus: number | null };
type ProviderRow = {
  id: string;
  protocol: ProviderProtocol;
  base_url: string;
  enabled: boolean;
  revision: number;
  api_key_ciphertext: string;
};
type InvestigationJob = {
  id: string;
  incident_id: string;
  provider_id: string | null;
  provider_revision: number | null;
  provider_model: string | null;
  attempts: number;
  max_attempts: number;
};
type TestIdentity = {
  id: string;
  protocol: ProviderProtocol;
  last_test_id: string;
  last_test_revision: number;
};
type TestRow = ProviderRow & TestIdentity & { last_test_model: string; test_unexpired: boolean };
type TestClaim = { slot: TestRow; connection: ProviderConnection | null };

function failureFrom(error: unknown): Failure {
  if (error instanceof ProviderCredentialError) {
    return { code: "credential_unavailable", httpStatus: null };
  }
  if (error instanceof ProviderError) {
    const status = error.httpStatus;
    return {
      code: error.code,
      httpStatus: status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    };
  }
  // Unknown exceptions must never cross the database/log boundary.
  return { code: "provider_unavailable", httpStatus: null };
}

function configurationFailure(provider: ProviderRow | undefined, revision: number | null): Failure | null {
  if (!provider) return { code: "provider_unavailable", httpStatus: null };
  if (provider.revision !== revision) return { code: "provider_changed", httpStatus: null };
  if (!provider.enabled) return { code: "provider_disabled", httpStatus: null };
  return null;
}

function captureConnection(provider: ProviderRow, model: string, masterKey: Uint8Array): ProviderConnection {
  return {
    id: provider.id,
    protocol: provider.protocol,
    baseUrl: provider.base_url,
    apiKey: decryptProviderKey(provider.id, provider.api_key_ciphertext, masterKey),
    model,
  };
}

export type WorkerReliabilityOptions = {
  /** Stable worker identity persisted on claimed rows; injectable for tests. */
  workerId?: string;
  /** Claim lease duration; expired leases make a job claimable by recovery. */
  leaseMs?: number;
  /** Base delay before the first retry; grows exponentially per attempt. */
  retryBackoffMs?: number;
  /**
   * Optional override for the prior-memory query embedding (tests). By default
   * the query is embedded only when `OPSPILOT_MEMORY_EMBEDDINGS_ENABLED=true`
   * and the claimed provider supports embeddings; otherwise retrieval is FTS-only.
   */
  memoryEmbedFn?: EmbedFn;
};

const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_RETRY_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;
const MAX_LEASE_MS = 3_600_000;

// One stable default identity per worker process.
let processWorkerId: string | undefined;
function resolveWorkerId(explicit?: string): string {
  return explicit ?? (processWorkerId ??= crypto.randomUUID());
}

function boundedMs(raw: number | undefined, fallback: number, max: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 0 || raw > max) return fallback;
  return Math.trunc(raw);
}

/** Attempts are 1-based here: attempt N gets base * 2^(N-1) delay, capped. Exported for tests. */
export function retryDelayMs(retryBackoffMs: number, attempts: number): number {
  return Math.min(retryBackoffMs * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/**
 * Conservative cost guardrail: only transient/unbounded failures replay a paid
 * provider call. Configuration, credentials, blocked egress and invalid
 * responses are deterministic and fail immediately regardless of budget.
 * Exported for tests.
 */
export function isRetryableFailure(failure: Failure): boolean {
  switch (failure.code) {
    case "provider_timeout":
    case "provider_network":
    case "dns_failed":
    case "worker_lease_expired":
      return true;
    case "provider_http":
      return failure.httpStatus === 429 || (failure.httpStatus !== null && failure.httpStatus >= 500);
    default:
      // provider_changed, provider_disabled, provider_unavailable, credential_unavailable,
      // provider_invalid_response, provider_egress-class codes, and HTTP 4xx (other than 429)
      // are permanent: retrying them would only repeat a deterministic failure.
      return false;
  }
}

/**
 * Recovers expired leases before new claims: requeues jobs still inside their
 * retry budget, terminalizes exhausted ones, with one audit per transition.
 */
export async function recoverExpiredLeases(db: SQL): Promise<boolean> {
  return db.begin(async (tx) => {
    // The FROM subquery locks the expired rows and preserves their pre-update worker_id
    // for the RETURNING clause (the UPDATE itself clears it).
    const expired = await tx<(InvestigationJob & { worker_id: string | null })[]>`UPDATE investigations i SET
        status=CASE WHEN e.attempts >= e.max_attempts THEN 'failed' ELSE 'queued' END,
        error='worker_lease_expired',
        lease_expires_at=NULL,worker_id=NULL,
        next_retry_at=CASE WHEN e.attempts < e.max_attempts THEN NOW() ELSE NULL END,
        completed_at=CASE WHEN e.attempts >= e.max_attempts THEN NOW() ELSE NULL END
      FROM (SELECT id,incident_id,provider_id,provider_revision,provider_model,worker_id,attempts,max_attempts
        FROM investigations
        WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= NOW()
        ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED) e
      WHERE i.id = e.id
      RETURNING i.id,e.incident_id,e.provider_id,e.provider_revision,e.provider_model,e.worker_id,e.attempts,e.max_attempts`;
    for (const job of expired) {
      const requeued = job.attempts < job.max_attempts;
      await tx`INSERT INTO audit_events(action,target_id,data)
        VALUES('investigation.lease_expired',${job.id},${{
          incidentId: job.incident_id,
          workerId: job.worker_id,
          attempts: job.attempts,
          maxAttempts: job.max_attempts,
          outcome: requeued ? "requeued" : "failed",
        }}::jsonb)`;
      if (!requeued) console.error("Investigation lease expired", job.id, job.provider_id, "worker_lease_expired");
      else console.error("Investigation lease expired; requeued", job.id, job.provider_id);
    }
    return expired.length > 0;
  });
}


async function auditTest(tx: SQL, slot: TestIdentity, failure: Failure | null): Promise<void> {
  const action = failure ? "ai.provider.test_failed" : "ai.provider.test_completed";
  const data = {
    protocol: slot.protocol,
    revision: slot.last_test_revision,
    testId: slot.last_test_id,
    ...(failure ? { errorCode: failure.code, httpStatus: failure.httpStatus } : {}),
  };
  await tx`INSERT INTO audit_events(action,target_id,data)
    VALUES(${action},${slot.id},${data}::jsonb)`;
}

/**
 * Persists a failure with the conservative retry policy: retryable failures requeue
 * inside the budget with backoff, everything else terminalizes immediately. The
 * worker guard keeps a stale worker from touching a lease-recovered row.
 */
async function failInvestigation(tx: SQL, job: InvestigationJob, failure: Failure, workerId: string, retryBackoffMs: number): Promise<boolean> {
  if (isRetryableFailure(failure) && job.attempts < job.max_attempts) {
    const delay = retryDelayMs(retryBackoffMs, job.attempts);
    const requeued = await tx<{ id: string }[]>`UPDATE investigations SET
        status='queued',error=${failure.code},lease_expires_at=NULL,worker_id=NULL,
        next_retry_at=NOW()+${delay} * INTERVAL '1 millisecond'
      WHERE id=${job.id} AND status='running' AND worker_id=${workerId} RETURNING id`;
    if (requeued.length) {
      console.error(
        "Investigation failed; requeued", job.id, job.provider_id, failure.code, failure.httpStatus, job.attempts, job.max_attempts,
      );
      return true;
    }
  }
  await tx`UPDATE investigations SET status='failed',error=${failure.code},lease_expires_at=NULL,worker_id=NULL,completed_at=NOW()
    WHERE id=${job.id} AND status='running' AND worker_id=${workerId}`;
  console.error("Investigation failed", job.id, job.provider_id, failure.code, failure.httpStatus);
  return false;
}

/** Accepts either the usage-returning call or the backwards-compatible diagnosis-only call. */
type GenerateInvestigation = typeof generateDiagnosis | typeof generateDiagnosisWithUsage;

/**
 * Gathers prior memories for an investigation via hybrid memory retrieval (FTS always,
 * vector/RRF when enabled). Only canonical memories are returned. The optional query
 * embedding is attempted only when embeddings are enabled and the claimed provider
 * supports them; any embedding failure falls back cleanly to FTS, and any retrieval
 * failure yields an empty context so investigations never block on memory.
 */
async function fetchPriorResolutions(
  db: SQL,
  connection: ProviderConnection,
  query: string,
  memoryEmbedFn?: EmbedFn,
): Promise<RetrievedMemoryItem[]> {
  let queryVector: number[] | null = null;
  const embed: EmbedFn | undefined =
    memoryEmbedFn ?? (memoryEmbeddingsEnabled() && supportsEmbeddings(connection.protocol) ? generateEmbedding : undefined);
  if (embed) {
    try {
      const embedding: GeneratedEmbedding = await embed(connection, query);
      queryVector = embedding.vector;
    } catch {
      queryVector = null; // FTS-only fallback; never fail the investigation on embeddings.
    }
  }
  try {
    // Canonical memories only (searchIncidentMemories filters canonical_memory_id IS
    // NULL); each item carries dedup provenance plus retrieval metadata.
    const search = await searchIncidentMemories(db, query, { queryVector, limit: MEMORY_RETRIEVAL_LIMIT });
    return search.results;
  } catch {
    return [];
  }
}

/** Claims at most one investigation; importing this module never starts a polling loop. */
export async function runOneInvestigation(
  db: SQL,
  masterKey: Uint8Array | null,
  generate: GenerateInvestigation = generateDiagnosisWithUsage,
  options: WorkerReliabilityOptions = {},
): Promise<boolean> {
  const workerId = resolveWorkerId(options.workerId);
  const leaseMs = boundedMs(options.leaseMs, DEFAULT_LEASE_MS, MAX_LEASE_MS);
  const retryBackoffMs = boundedMs(options.retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS, MAX_BACKOFF_MS);

  // Recover expired leases before claiming: a dead worker's job re-enters the queue
  // (or terminalizes when its retry budget is spent).
  await recoverExpiredLeases(db);
  if (!masterKey) return false;

  const claimed = await db.begin(async (tx) => {
    const [candidate] = await tx<Pick<InvestigationJob, "id" | "provider_id">[]>`SELECT id,provider_id
      FROM investigations
      WHERE status='queued' AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      ORDER BY created_at,id LIMIT 1`;
    if (!candidate) return null;

    // Provider first, then investigation: deletion takes this same order through its FK.
    const providers = candidate.provider_id
      ? await tx<ProviderRow[]>`SELECT id,protocol,base_url,enabled,revision,api_key_ciphertext
          FROM ai_providers WHERE id=${candidate.provider_id} FOR UPDATE`
      : [];
    const jobs = await tx<InvestigationJob[]>`UPDATE investigations SET
        status='running',
        started_at=COALESCE(started_at,NOW()),
        attempts=attempts+1,
        worker_id=${workerId},
        lease_expires_at=NOW()+${leaseMs} * INTERVAL '1 millisecond',
        next_retry_at=NULL
      WHERE id=(SELECT id FROM investigations WHERE id=${candidate.id} AND status='queued'
        AND (next_retry_at IS NULL OR next_retry_at <= NOW()) FOR UPDATE SKIP LOCKED)
      RETURNING id,incident_id,provider_id,provider_revision,provider_model,attempts,max_attempts`;
    const job = jobs[0];
    if (!job) return null;

    const provider = providers[0];
    let failure = configurationFailure(provider, job.provider_revision);
    if (!failure && !job.provider_model) failure = { code: "provider_unavailable", httpStatus: null };
    let connection: ProviderConnection | null = null;
    if (!failure && provider && job.provider_model) {
      try {
        connection = captureConnection(provider, job.provider_model, masterKey);
      } catch (error: unknown) {
        failure = failureFrom(error);
      }
    }
    if (failure) await failInvestigation(tx, job, failure, workerId, retryBackoffMs);
    return { job, connection };
  });
  if (!claimed) return false;
  const { job, connection } = claimed;
  if (!connection) return true;

  try {
    const incidents = await db<{ title: string; category: string }[]>`SELECT title,category FROM incidents WHERE id=${job.incident_id}`;
    const incident = incidents[0];
    if (!incident) {
      await failInvestigation(db, job, { code: "provider_unavailable", httpStatus: null }, workerId, retryBackoffMs);
      return true;
    }
    const evidence = await db<Parameters<typeof generateDiagnosis>[2]>`SELECT id,source,content FROM evidence
      WHERE incident_id=${job.incident_id} ORDER BY created_at DESC LIMIT 12`;
    // Hybrid retrieval (FTS always; vector/RRF when embeddings are enabled and the
    // provider supports them) over canonical memories only — merged duplicates are
    // never candidates. Any retrieval failure yields empty context so investigations
    // never block on memory.
    const priorMemories = await fetchPriorResolutions(db, connection, incident.title, options.memoryEmbedFn);
    // Exact/near-duplicate canonical memories are collapsed before the LLM or the
    // persisted attribution ever sees them.
    const candidates = deduplicateMemoryCandidates(priorMemories, MEMORY_RETRIEVAL_LIMIT);
    const memories = candidates.map((item) => ({ id: item.id, summary: item.summary, resolution: item.resolution }));
    // Bounded, non-secret attribution snapshot of what this investigation retrieved.
    const retrievedMemories: InvestigationMemoryAttribution[] = candidates.map((item) => ({
      memory_id: item.id,
      summary: item.summary,
      resolution_preview: item.resolution.slice(0, 200),
      occurrence_count: item.occurrence_count,
      source_incident_ids: item.sources.map((source) => source.incident_id),
      retrieval_method: item.retrieval_method,
      score: item.retrieval_method === "hybrid_rrf" ? item.hybrid_score : item.fts_score,
      last_confirmed_at: item.last_confirmed_at,
    }));
    const outcome = await generate(connection, incident, evidence, memories);
    const diagnosis = "diagnosis" in outcome ? outcome.diagnosis : outcome;
    const usage = "usage" in outcome ? outcome.usage : null;
    // The worker guard keeps a slow worker whose lease expired and was recovered
    // from overwriting the row's new state or emitting a duplicate completion audit.
    const completed = await db<{ id: string }[]>`UPDATE investigations SET status='completed',result_json=${diagnosis}::jsonb,error=NULL,completed_at=NOW(),
      lease_expires_at=NULL,worker_id=NULL,
      input_tokens=${usage?.inputTokens ?? null},output_tokens=${usage?.outputTokens ?? null},
      thinking_tokens=${usage?.thinkingTokens ?? null},total_tokens=${usage?.totalTokens ?? null},
      estimated_cost_usd=${usage?.estimatedCostUsd ?? null},
      retrieved_memories_json=${retrievedMemories}::jsonb
      WHERE id=${job.id} AND status='running' AND worker_id=${workerId}
      RETURNING id`;
    if (completed.length) {
      // Non-secret usage metadata only; never keys, prompts, evidence content or raw responses.
      await db`INSERT INTO audit_events(action,target_id,data)
        VALUES('ai.investigation.completed',${job.id},${{
          incidentId: job.incident_id,
          providerId: job.provider_id,
          model: job.provider_model,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          thinkingTokens: usage?.thinkingTokens ?? null,
          totalTokens: usage?.totalTokens ?? null,
          estimatedCostUsd: usage?.estimatedCostUsd ?? null,
        }}::jsonb)`;
    }
    console.log("Completed investigation", job.id, connection.id);
  } catch (error: unknown) {
    await failInvestigation(db, job, failureFrom(error), workerId, retryBackoffMs);
  }
  return true;
}

/** Terminalizes one expired/invalidated active slot, with its audit in the same transaction. */
async function retireStaleTest(db: SQL): Promise<boolean> {
  return db.begin(async (tx) => {
    const slots = await tx<(TestIdentity & { error_code: "provider_timeout" | "provider_changed" | "provider_disabled" })[]>`
      UPDATE ai_providers SET last_test_status='failed',
        last_test_error_code=CASE
          WHEN last_test_expires_at <= NOW() THEN 'provider_timeout'
          WHEN revision <> last_test_revision THEN 'provider_changed'
          ELSE 'provider_disabled' END,
        last_test_http_status=NULL,last_test_completed_at=NOW()
      WHERE id=(SELECT id FROM ai_providers
        WHERE last_test_status IN ('queued','running') AND
          (last_test_expires_at <= NOW() OR revision <> last_test_revision OR NOT enabled)
        ORDER BY last_test_requested_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id,protocol,last_test_id,last_test_revision,last_test_error_code AS error_code`;
    const slot = slots[0];
    if (!slot) return false;
    await auditTest(tx, slot, { code: slot.error_code, httpStatus: null });
    return true;
  });
}

/** Claims at most one synthetic connection test; expiry processing also runs without a master key. */
export async function runOneProviderTest(
  db: SQL,
  masterKey: Uint8Array | null,
  generate: typeof generateDiagnosis = generateDiagnosis,
): Promise<boolean> {
  if (await retireStaleTest(db)) return true;
  if (!masterKey) return false;

  const claimed: TestClaim | null = await db.begin(async (tx) => {
    const slots = await tx<TestRow[]>`SELECT id,protocol,base_url,enabled,revision,api_key_ciphertext,
        last_test_id,last_test_revision,last_test_model,last_test_expires_at > NOW() AS test_unexpired
      FROM ai_providers WHERE last_test_status='queued'
      ORDER BY last_test_requested_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    const slot = slots[0];
    if (!slot) return null;
    let failure: Failure | null = !slot.test_unexpired
      ? { code: "provider_timeout", httpStatus: null }
      : configurationFailure(slot, slot.last_test_revision);
    let connection: ProviderConnection | null = null;
    if (!failure) {
      try {
        connection = captureConnection(slot, slot.last_test_model, masterKey);
      } catch (error: unknown) {
        failure = failureFrom(error);
      }
    }
    if (failure) {
      const updated = await tx<TestIdentity[]>`UPDATE ai_providers SET last_test_status='failed',
          last_test_error_code=${failure.code},last_test_http_status=${failure.httpStatus},last_test_completed_at=NOW()
        WHERE id=${slot.id} AND last_test_id=${slot.last_test_id} AND last_test_status='queued'
        RETURNING id,protocol,last_test_id,last_test_revision`;
      if (updated[0]) await auditTest(tx, updated[0], failure);
    } else {
      const updated = await tx<{ id: string }[]>`UPDATE ai_providers SET last_test_status='running',last_test_started_at=NOW()
        WHERE id=${slot.id} AND last_test_id=${slot.last_test_id} AND revision=${slot.revision}
          AND last_test_status='queued' AND last_test_expires_at > NOW() RETURNING id`;
      if (!updated.length) connection = null;
    }
    return { slot, connection };
  });
  if (!claimed) return false;
  const { slot, connection } = claimed;
  if (!connection) return true;

  let failure: Failure | null = null;
  try {
    await generate(connection, { title: "OpsPilot connection test", category: "connection_test" }, [], []);
  } catch (error: unknown) {
    failure = failureFrom(error);
  }

  const persisted = await db.begin(async (tx) => {
    const updated = await tx<TestIdentity[]>`UPDATE ai_providers SET
        last_test_status=${failure ? "failed" : "completed"},last_test_error_code=${failure?.code ?? null},
        last_test_http_status=${failure?.httpStatus ?? null},last_test_completed_at=NOW()
      WHERE id=${slot.id} AND last_test_id=${slot.last_test_id} AND revision=${slot.revision}
        AND last_test_status='running' AND last_test_expires_at > NOW()
      RETURNING id,protocol,last_test_id,last_test_revision`;
    if (updated[0]) {
      await auditTest(tx, updated[0], failure);
      return true;
    }
    // A request may finish after its deadline or a configuration edit. Never publish its late result.
    const stale = await tx<(TestIdentity & { error_code: "provider_timeout" | "provider_changed" | "provider_disabled" })[]>`
      UPDATE ai_providers SET last_test_status='failed',
        last_test_error_code=CASE
          WHEN last_test_expires_at <= NOW() THEN 'provider_timeout'
          WHEN revision <> last_test_revision THEN 'provider_changed'
          ELSE 'provider_disabled' END,
        last_test_http_status=NULL,last_test_completed_at=NOW()
      WHERE id=${slot.id} AND last_test_id=${slot.last_test_id} AND last_test_status='running'
        AND (last_test_expires_at <= NOW() OR revision <> last_test_revision OR NOT enabled)
      RETURNING id,protocol,last_test_id,last_test_revision,last_test_error_code AS error_code`;
    if (stale[0]) await auditTest(tx, stale[0], { code: stale[0].error_code, httpStatus: null });
    return false;
  });
  if (persisted) {
    if (failure) console.error("Provider test failed", slot.last_test_id, slot.id, failure.code, failure.httpStatus);
    else console.log("Completed provider test", slot.last_test_id, slot.id);
  }
  return true;
}

const HOUR_MS = 3_600_000;
const RETENTION_WINDOW_MS = 6 * HOUR_MS;

function retentionConfig() {
  const raw = Number(process.env.METRIC_RAW_RETENTION_HOURS || 168);
  const rollup = Number(process.env.METRIC_ROLLUP_RETENTION_DAYS || 90);
  return {
    rawHours: Number.isFinite(raw) && raw >= 1 && raw <= 8760 ? Math.trunc(raw) : 168,
    rollupDays: Number.isFinite(rollup) && rollup >= 1 && rollup <= 3650 ? Math.trunc(rollup) : 90,
  };
}

/**
 * Bounded retention pass: expires old hourly rollups and spent enrollment tokens, then
 * rolls up and deletes one 6-hour window of raw samples that left the raw retention
 * window. Each call does at most one window so the poll loop stays bounded.
 */
export async function runMetricRetention(db: SQL, now: Date = new Date()): Promise<boolean> {
  const { rawHours, rollupDays } = retentionConfig();

  await db`DELETE FROM metric_samples_hourly WHERE hour < NOW() - make_interval(days => ${rollupDays})`;
  await db`DELETE FROM enrollment_tokens
    WHERE (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '24 hours')
       OR (used_at IS NULL AND expires_at < NOW() - INTERVAL '24 hours')`;

  // Truncate to a full hour boundary so only complete hours are rolled up and deleted.
  const horizon = new Date(Math.floor((now.getTime() - rawHours * HOUR_MS) / HOUR_MS) * HOUR_MS);
  const [oldest] =
    await db<{ min: Date | null }[]>`SELECT MIN(sampled_at) AS min FROM metric_samples WHERE sampled_at < ${horizon}`;
  const min = oldest?.min;
  if (!min) return false;

  const windowStart = new Date(Math.floor(min.getTime() / RETENTION_WINDOW_MS) * RETENTION_WINDOW_MS);
  const windowEnd = new Date(Math.min(windowStart.getTime() + RETENTION_WINDOW_MS, horizon.getTime()));
  await db.begin(async (tx) => {
    await tx`INSERT INTO metric_samples_hourly(
        agent_id,hour,sample_count,
        cpu_min,cpu_max,cpu_avg,memory_min,memory_max,memory_avg,disk_min,disk_max,disk_avg,
        network_rx_bytes,network_tx_bytes)
      SELECT agent_id, date_trunc('hour', sampled_at), COUNT(*)::int,
        MIN(cpu_percent), MAX(cpu_percent), AVG(cpu_percent),
        MIN(memory_percent), MAX(memory_percent), AVG(memory_percent),
        MIN(disk_percent), MAX(disk_percent), AVG(disk_percent),
        (array_agg(network_rx_bytes ORDER BY sampled_at DESC, id DESC))[1],
        (array_agg(network_tx_bytes ORDER BY sampled_at DESC, id DESC))[1]
      FROM metric_samples
      WHERE sampled_at >= ${windowStart} AND sampled_at < ${windowEnd} AND sampled_at < ${horizon}
      GROUP BY agent_id, date_trunc('hour', sampled_at)
      ON CONFLICT (agent_id, hour) DO NOTHING`;
    await tx`DELETE FROM metric_samples
      WHERE sampled_at >= ${windowStart} AND sampled_at < ${windowEnd} AND sampled_at < ${horizon}`;
  });
  return true;
}
