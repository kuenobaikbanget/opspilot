import type { SQL } from "bun";
import { generateDiagnosis, type ProviderConnection } from "@opspilot/ai";
import { decryptProviderKey, ProviderCredentialError } from "@opspilot/ai/credentials";
import { ProviderError, type ProviderErrorCode } from "@opspilot/ai/provider-http";
import type { ProviderProtocol } from "@opspilot/contracts";

type FailureCode = ProviderErrorCode | "provider_unavailable" | "provider_disabled" | "provider_changed" | "credential_unavailable";
type Failure = { code: FailureCode; httpStatus: number | null };
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

async function failInvestigation(tx: SQL, job: InvestigationJob, failure: Failure): Promise<void> {
  await tx`UPDATE investigations SET status='failed',error=${failure.code},completed_at=NOW()
    WHERE id=${job.id} AND status='running'`;
  console.error("Investigation failed", job.id, job.provider_id, failure.code, failure.httpStatus);
}

/** Claims at most one investigation; importing this module never starts a polling loop. */
export async function runOneInvestigation(
  db: SQL,
  masterKey: Uint8Array | null,
  generate: typeof generateDiagnosis = generateDiagnosis,
): Promise<boolean> {
  if (!masterKey) return false;

  const claimed = await db.begin(async (tx) => {
    const [candidate] = await tx<Pick<InvestigationJob, "id" | "provider_id">[]>`SELECT id,provider_id
      FROM investigations WHERE status='queued' ORDER BY created_at,id LIMIT 1`;
    if (!candidate) return null;

    // Provider first, then investigation: deletion takes this same order through its FK.
    const providers = candidate.provider_id
      ? await tx<ProviderRow[]>`SELECT id,protocol,base_url,enabled,revision,api_key_ciphertext
          FROM ai_providers WHERE id=${candidate.provider_id} FOR UPDATE`
      : [];
    const jobs = await tx<InvestigationJob[]>`UPDATE investigations SET status='running',started_at=NOW()
      WHERE id=(SELECT id FROM investigations WHERE id=${candidate.id} AND status='queued' FOR UPDATE SKIP LOCKED)
      RETURNING id,incident_id,provider_id,provider_revision,provider_model`;
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
    if (failure) await failInvestigation(tx, job, failure);
    return { job, connection };
  });
  if (!claimed) return false;
  const { job, connection } = claimed;
  if (!connection) return true;

  try {
    const incidents = await db<{ title: string; category: string }[]>`SELECT title,category FROM incidents WHERE id=${job.incident_id}`;
    const incident = incidents[0];
    if (!incident) {
      await failInvestigation(db, job, { code: "provider_unavailable", httpStatus: null });
      return true;
    }
    const evidence = await db<Parameters<typeof generateDiagnosis>[2]>`SELECT id,source,content FROM evidence
      WHERE incident_id=${job.incident_id} ORDER BY created_at DESC LIMIT 12`;
    const memories = await db<Parameters<typeof generateDiagnosis>[3]>`SELECT id,summary,resolution FROM incident_memory
      WHERE to_tsvector('simple',summary || ' ' || resolution) @@ plainto_tsquery('simple',${incident.title})
      ORDER BY created_at DESC LIMIT 5`;
    const diagnosis = await generate(connection, incident, evidence, memories);
    await db`UPDATE investigations SET status='completed',result_json=${diagnosis}::jsonb,error=NULL,completed_at=NOW()
      WHERE id=${job.id} AND status='running'`;
    console.log("Completed investigation", job.id, connection.id);
  } catch (error: unknown) {
    await failInvestigation(db, job, failureFrom(error));
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
