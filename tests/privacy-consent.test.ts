import { expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  PRIVACY_CONSENT_REQUIRED,
  PRIVACY_CONSENT_VERSION,
  hasAiEgressConsent,
  parseUpdatePrivacyConsentRequest,
  rowToPrivacyConsentSettings,
} from "../packages/contracts/src/index";
import { generateDiagnosisWithUsage } from "../packages/ai/src/index";
import type { ProviderPost } from "../packages/ai/src/provider-http";
import { isRetryableFailure } from "../apps/worker/src/jobs";
import {
  PrivacyConsentError,
  getPrivacySettings,
  requireAiEgressConsent,
  updatePrivacySettings,
} from "../apps/hub/src/privacy";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";
import { grantAiEgressConsent, revokeAiEgressConsent } from "./helpers/privacy-consent";
import { csrfFromLogin, withCsrf } from "./helpers/csrf";

const integration = providerTestDatabaseAvailable ? test : test.skip;

// ---------------------------------------------------------------------------
// Contract parsing (unit)
// ---------------------------------------------------------------------------

test("parseUpdatePrivacyConsentRequest accepts valid updates and trims the actor label", () => {
  expect(parseUpdatePrivacyConsentRequest({ aiEgressConsentGranted: true })).toEqual({ aiEgressConsentGranted: true });
  expect(parseUpdatePrivacyConsentRequest({ redactPii: true, consentedBy: "  alice  " })).toEqual({ redactPii: true, consentedBy: "alice" });
  expect(parseUpdatePrivacyConsentRequest({ aiEgressConsentGranted: false, redactPii: false })).toEqual({ aiEgressConsentGranted: false, redactPii: false });
});

test("parseUpdatePrivacyConsentRequest rejects every malformed shape (negative)", () => {
  for (const bad of [
    {},
    null,
    [],
    "yes",
    { aiEgressConsentGranted: "true" },
    { aiEgressConsentGranted: 1 },
    { redactPii: null },
    { consentedBy: "" },
    { consentedBy: "   " },
    { consentedBy: "x".repeat(121) },
    { consentedBy: 42 },
    { unknown: true },
    { aiEgressConsentGranted: true, extra: false },
  ]) {
    expect(parseUpdatePrivacyConsentRequest(bad)).toBeNull();
  }
});

test("rowToPrivacyConsentSettings: absent row is deny-by-default, rows map to the DTO", () => {
  const absent = rowToPrivacyConsentSettings(null);
  expect(absent.aiEgressConsentGranted).toBe(false);
  expect(absent.redactPii).toBe(false);
  expect(absent.consentVersion).toBe(PRIVACY_CONSENT_VERSION);
  expect(absent.consentedAt).toBeNull();
  expect(hasAiEgressConsent(absent)).toBe(false);

  const row = rowToPrivacyConsentSettings({
    ai_egress_consent_granted: true,
    consent_version: PRIVACY_CONSENT_VERSION,
    consented_at: new Date("2026-06-01T12:00:00.000Z"),
    consented_by: "alice",
    redact_pii: true,
    updated_at: "2026-06-01T12:05:00.000Z",
  });
  expect(row).toEqual({
    aiEgressConsentGranted: true,
    consentVersion: PRIVACY_CONSENT_VERSION,
    consentedAt: "2026-06-01T12:00:00.000Z",
    consentedBy: "alice",
    redactPii: true,
    updatedAt: "2026-06-01T12:05:00.000Z",
  });
  expect(hasAiEgressConsent(row)).toBe(true);
  expect(hasAiEgressConsent({ aiEgressConsentGranted: false })).toBe(false);
});

test("privacy_consent_required is a permanent, non-retryable failure", () => {
  expect(isRetryableFailure({ code: "privacy_consent_required", httpStatus: null })).toBe(false);
  expect(PRIVACY_CONSENT_REQUIRED).toBe("privacy_consent_required");
});

// ---------------------------------------------------------------------------
// Consent gate logic with a fake executor (unit)
// ---------------------------------------------------------------------------

type Call = { sql: string; values: unknown[] };

function fakeExecutor(handler: (sql: string, values: unknown[]) => unknown[]): { sql: SQL; calls: Call[] } {
  const calls: Call[] = [];
  const exec = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    calls.push({ sql, values });
    return Promise.resolve(handler(sql, values));
  };
  const sql = Object.assign(exec, {
    begin: async (cb: (tx: unknown) => unknown) => cb(exec),
  }) as unknown as SQL;
  return { sql, calls };
}

const GRANTED_ROW = {
  ai_egress_consent_granted: true,
  consent_version: PRIVACY_CONSENT_VERSION,
  consented_at: new Date("2026-06-01T00:00:00.000Z"),
  consented_by: "alice",
  redact_pii: false,
  updated_at: new Date("2026-06-01T00:00:00.000Z"),
};

test("requireAiEgressConsent fails closed and audits the blocked attempt when consent is absent", async () => {
  const { sql, calls } = fakeExecutor(() => []); // no privacy_settings row
  await expect(requireAiEgressConsent(sql, "investigation.run")).rejects.toBeInstanceOf(PrivacyConsentError);
  try {
    await requireAiEgressConsent(sql, "investigation.run");
    expect.unreachable();
  } catch (error) {
    expect((error as PrivacyConsentError).code).toBe(PRIVACY_CONSENT_REQUIRED);
  }
  const audits = calls.filter((c) => c.sql.includes("INSERT INTO audit_events"));
  expect(audits).toHaveLength(2); // one per blocked call above
  expect(audits[0]!.values[0]).toBe("privacy.egress_blocked");
  expect(JSON.stringify(audits[0]!.values[1])).toContain("ai_egress_consent_not_granted");
  expect(JSON.stringify(audits[0]!.values[1])).toContain("investigation.run");
});

test("requireAiEgressConsent passes when consent is granted and writes no block audit", async () => {
  const { sql, calls } = fakeExecutor((sqlText) => (sqlText.includes("FROM privacy_settings") ? [GRANTED_ROW] : []));
  const settings = await requireAiEgressConsent(sql, "provider.test");
  expect(settings.aiEgressConsentGranted).toBe(true);
  expect(calls.filter((c) => c.sql.includes("privacy.egress_blocked"))).toHaveLength(0);
});

test("updatePrivacySettings audits grant, revoke and settings-only changes", async () => {
  const { sql, calls } = fakeExecutor((sqlText, values) => {
    if (sqlText.includes("FROM privacy_settings")) return []; // currently absent => deny
    if (sqlText.includes("INSERT INTO privacy_settings")) return [GRANTED_ROW];
    return [];
  });
  const granted = await updatePrivacySettings(sql, { aiEgressConsentGranted: true, consentedBy: "alice" }, "alice");
  expect(granted.action).toBe("privacy.consent_granted");
  expect(granted.settings.aiEgressConsentGranted).toBe(true);
  expect(calls.find((c) => c.sql.includes("INSERT INTO audit_events"))!.values[0]).toBe("privacy.consent_granted");

  const { sql: sql2, calls: calls2 } = fakeExecutor((sqlText) => {
    if (sqlText.includes("FROM privacy_settings")) return [GRANTED_ROW];
    if (sqlText.includes("INSERT INTO privacy_settings")) return [{ ...GRANTED_ROW, ai_egress_consent_granted: false, consented_at: null, consented_by: null }];
    return [];
  });
  const revoked = await updatePrivacySettings(sql2, { aiEgressConsentGranted: false });
  expect(revoked.action).toBe("privacy.consent_revoked");
  expect(revoked.settings.aiEgressConsentGranted).toBe(false);
  const audit = calls2.find((c) => c.sql.includes("INSERT INTO audit_events"));
  expect(audit!.values[0]).toBe("privacy.consent_revoked");

  const { sql: sql3, calls: calls3 } = fakeExecutor((sqlText) => {
    if (sqlText.includes("FROM privacy_settings")) return [{ ...GRANTED_ROW, redact_pii: false }];
    if (sqlText.includes("INSERT INTO privacy_settings")) return [{ ...GRANTED_ROW, redact_pii: true }];
    return [];
  });
  const pii = await updatePrivacySettings(sql3, { redactPii: true });
  expect(pii.action).toBe("privacy.settings_updated");
  expect(pii.settings.redactPii).toBe(true);
  expect(pii.settings.aiEgressConsentGranted).toBe(true);
  expect(calls3.find((c) => c.sql.includes("INSERT INTO audit_events"))!.values[0]).toBe("privacy.settings_updated");
});

// ---------------------------------------------------------------------------
// Redaction before the LLM adapter (unit, fake provider post)
// ---------------------------------------------------------------------------

const SECRET_EVIDENCE = "nginx failed: password=hunter2secret db=postgres://svc:hunter2secret@db.internal:5432/prod key=sk-proj-9f8e7d6c5b4a3210ZY admin bob@corp.example.com from 10.0.0.8";

function capturePost(): { post: ProviderPost; bodies: string[] } {
  const bodies: string[] = [];
  const post: ProviderPost = async (_url, _headers, body) => {
    bodies.push(JSON.stringify(body));
    return { choices: [{ message: { content: JSON.stringify({
      probable_cause: "upstream auth failure", confidence: "low", evidence_ids: ["e1"], missing_evidence: [], recommended_checks: [],
    }) } }] };
  };
  return { post, bodies };
}

const CONNECTION = { id: "p1", protocol: "openai-compatible" as const, baseUrl: "https://provider.example/v1", apiKey: "sk-fixture", model: "fixture-model" };

test("even with consent granted, raw secrets in evidence are redacted before reaching the LLM adapter", async () => {
  const { post, bodies } = capturePost();
  const result = await generateDiagnosisWithUsage(
    CONNECTION,
    { title: "nginx 502", category: "service" },
    [{ id: "e1", source: "logs", content: SECRET_EVIDENCE }],
    [],
    post,
  );
  expect(result.diagnosis.probable_cause).toBe("upstream auth failure");
  expect(bodies).toHaveLength(1);
  const raw = bodies[0]!;
  for (const secret of ["hunter2secret", "svc", "sk-proj-9f8e7d6c5b4a3210ZY"]) expect(raw).not.toContain(secret);
  expect(raw).toContain("[REDACTED]");
  // PII stays by default…
  expect(raw).toContain("bob@corp.example.com");
  expect(raw).toContain("10.0.0.8");
});

test("opt-in PII redaction also strips emails and IPs from the outbound prompt", async () => {
  const { post, bodies } = capturePost();
  await generateDiagnosisWithUsage(
    CONNECTION,
    { title: "nginx 502", category: "service" },
    [{ id: "e1", source: "logs", content: SECRET_EVIDENCE }],
    [],
    post,
    { redactPii: true },
  );
  const raw = bodies[0]!;
  for (const secret of ["hunter2secret", "sk-proj-9f8e7d6c5b4a3210ZY", "bob@corp.example.com", "10.0.0.8"]) {
    expect(raw).not.toContain(secret);
  }
  expect(raw).toContain("[REDACTED_EMAIL]");
  expect(raw).toContain("[REDACTED_IP]");
});

// ---------------------------------------------------------------------------
// Integration (real PostgreSQL via AI_PROVIDER_TEST_DATABASE_URL)
// ---------------------------------------------------------------------------

const root = new URL("../", import.meta.url).pathname;

async function migrate(databaseUrl: string): Promise<void> {
  const migration = Bun.spawnSync([process.execPath, "--no-env-file", "tools/migrate.ts"], {
    cwd: root, env: { DATABASE_URL: databaseUrl }, timeout: 20_000,
  });
  if (!migration.success) throw new Error(`Migration failed: ${migration.stderr.toString()}`);
}

const HUB_ORIGIN = "http://localhost:3100";
const HUB_PASSWORD = "opspilot-privacy-integration-only-password";

type Hub = { request(path: string, method?: string, data?: unknown, withOrigin?: boolean): Promise<Response>; stop(): Promise<string> };

async function startHub(databaseUrl: string): Promise<Hub> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const child = Bun.spawn([process.execPath, "--no-env-file", "apps/hub/src/index.ts"], {
    cwd: root,
    env: {
      NODE_ENV: "development",
      DATABASE_URL: databaseUrl,
      ADMIN_PASSWORD: HUB_PASSWORD,
      SESSION_SECRET: "opspilot-disposable-privacy-integration-session-secret",
      COOKIE_SECURE: "false",
      ALLOWED_ORIGIN: HUB_ORIGIN,
      AI_PROVIDER_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      PORT: String(port),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let cookie = "";
  let csrf = "";
  async function request(path: string, method = "GET", data?: unknown, withOrigin = true): Promise<Response> {
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    if (method !== "GET") {
      if (withOrigin) headers.set("origin", HUB_ORIGIN);
      withCsrf(headers, method, csrf);
      headers.set("content-type", "application/json");
    }
    return fetch(`${baseUrl}${path}`, {
      method, headers, body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(5_000),
    });
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Hub exited before startup");
    try {
      if ((await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).ok) break;
    } catch { /* not ready yet */ }
    await Bun.sleep(50);
  }
  const login = await request("/api/auth/login", "POST", { password: HUB_PASSWORD });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  csrf = csrfFromLogin(login);
  return {
    request,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      try { await Promise.race([child.exited, Bun.sleep(2_000)]); } catch { child.kill("SIGKILL"); }
      const out = await new Response(child.stdout).text();
      const err = await new Response(child.stderr).text();
      return `${out}\n${err}`;
    },
  };
}

integration("migration 017 seeds deny-by-default privacy settings and the gate audits blocked egress", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    // Default: no consent.
    const settings = await getPrivacySettings(db);
    expect(settings.aiEgressConsentGranted).toBe(false);
    expect(settings.consentVersion).toBe(PRIVACY_CONSENT_VERSION);

    await expect(requireAiEgressConsent(db, "investigation.run")).rejects.toBeInstanceOf(PrivacyConsentError);
    const audits = await db<{ action: string; data: { context: string; reason: string } }[]>`
      SELECT action,data FROM audit_events WHERE action='privacy.egress_blocked'`;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data.context).toBe("investigation.run");
    expect(audits[0]!.data.reason).toBe("ai_egress_consent_not_granted");

    // Grant consent: audited, persisted.
    const granted = await updatePrivacySettings(db, { aiEgressConsentGranted: true, consentedBy: "integration" });
    expect(granted.action).toBe("privacy.consent_granted");
    expect(granted.settings.aiEgressConsentGranted).toBe(true);
    expect(granted.settings.consentedAt).not.toBeNull();
    expect(granted.settings.consentedBy).toBe("integration");
    await requireAiEgressConsent(db, "investigation.run"); // no throw now

    // Revoke: audited, deny again.
    const revoked = await updatePrivacySettings(db, { aiEgressConsentGranted: false });
    expect(revoked.action).toBe("privacy.consent_revoked");
    expect(revoked.settings.consentedAt).toBeNull();
    await expect(requireAiEgressConsent(db, "investigation.run")).rejects.toBeInstanceOf(PrivacyConsentError);

    const actions = (await db<{ action: string }[]>`SELECT action FROM audit_events WHERE action LIKE 'privacy.%' ORDER BY id`).map((r) => r.action);
    expect(actions).toEqual(["privacy.egress_blocked", "privacy.consent_granted", "privacy.consent_revoked", "privacy.egress_blocked"]);
  });
}, 30_000);

integration("worker fails investigations closed without consent, runs them (redacted) with consent", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const { randomUUID } = await import("node:crypto");
    const { encryptProviderKey, readProviderMasterKey } = await import("../packages/ai/src/credentials");
    const { runOneInvestigation } = await import("../apps/worker/src/jobs");
    const masterKey = readProviderMasterKey({ AI_PROVIDER_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" })!;
    const providerId = randomUUID();
    await db`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,revision,api_key_ciphertext)
      VALUES(${providerId},'Privacy fixture','openai-compatible','https://provider.example/v1','fixture-model',true,1,
        ${encryptProviderKey(providerId, "sk-privacy-fixture-dummy-key-000", masterKey)})`;
    const [host] = await db`INSERT INTO agents(hostname,token_hash) VALUES('privacy-fixture','not-an-agent-token') RETURNING id`;
    const [incident] = await db`INSERT INTO incidents(agent_id,title,category) VALUES(${host.id},'Privacy gate fixture','disk') RETURNING id`;
    const insertJob = async () => {
      const [row] = await db`INSERT INTO investigations(incident_id,provider_id,provider_revision,provider_name,provider_protocol,provider_base_url,provider_model)
        VALUES(${incident.id},${providerId},1,'Privacy fixture','openai-compatible','https://provider.example/v1','fixture-model') RETURNING id`;
      return row.id as string;
    };

    // Without consent: the job fails terminally with privacy_consent_required and the
    // provider call is never made.
    let calls = 0;
    const countingGenerate: typeof import("../packages/ai/src/index").generateDiagnosis = async () => {
      calls++;
      return { probable_cause: "x", confidence: "low", evidence_ids: [], missing_evidence: [], recommended_checks: [] };
    };
    const blockedJob = await insertJob();
    expect(await runOneInvestigation(db, masterKey, countingGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
    const blocked = await db<{ status: string; error: string | null; attempts: number }[]>`SELECT status,error,attempts FROM investigations WHERE id=${blockedJob}`;
    expect(blocked[0]!.status).toBe("failed");
    expect(blocked[0]!.error).toBe("privacy_consent_required");
    expect(blocked[0]!.attempts).toBe(1); // terminal: no retry budget spent
    expect(calls).toBe(0);
    const blockedAudit = await db<{ action: string }[]>`SELECT action FROM audit_events WHERE action='privacy.egress_blocked'`;
    expect(blockedAudit.length).toBe(1);

    // With consent: the same job shape completes.
    await grantAiEgressConsent(db);
    const allowedJob = await insertJob();
    expect(await runOneInvestigation(db, masterKey, countingGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
    const allowed = await db<{ status: string; error: string | null }[]>`SELECT status,error FROM investigations WHERE id=${allowedJob}`;
    expect(allowed[0]!.status).toBe("completed");
    expect(allowed[0]!.error).toBeNull();
    expect(calls).toBe(1);

    // Revoking consent blocks again (fail closed on every attempt).
    await revokeAiEgressConsent(db);
    const blockedAgain = await insertJob();
    expect(await runOneInvestigation(db, masterKey, countingGenerate, { workerId: "w", retryBackoffMs: 0 })).toBe(true);
    const again = await db<{ status: string; error: string | null }[]>`SELECT status,error FROM investigations WHERE id=${blockedAgain}`;
    expect(again[0]!.status).toBe("failed");
    expect(again[0]!.error).toBe("privacy_consent_required");
    expect(calls).toBe(1);
  });
}, 30_000);

integration("Hub API: consent endpoints gate investigate and provider tests, with audit trail", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const hub = await startHub(url);
    try {
      // GET consent: default deny.
      const initial = await hub.request("/api/privacy/consent");
      expect(initial.status).toBe(200);
      const initialBody = await initial.json() as { consent: { aiEgressConsentGranted: boolean; redactPii: boolean } };
      expect(initialBody.consent.aiEgressConsentGranted).toBe(false);
      expect(initialBody.consent.redactPii).toBe(false);

      // PUT validation: unknown keys / wrong types / empty body are 400 invalid_request.
      for (const bad of [{}, { nope: true }, { aiEgressConsentGranted: "yes" }, { consentedBy: "" }]) {
        const res = await hub.request("/api/privacy/consent", "PUT", bad);
        expect(res.status).toBe(400);
        expect((await res.json() as { code: string }).code).toBe("invalid_request");
      }
      // Cross-origin mutation is 403 forbidden_origin.
      const crossOrigin = await hub.request("/api/privacy/consent", "PUT", { aiEgressConsentGranted: true }, false);
      expect(crossOrigin.status).toBe(403);
      expect((await crossOrigin.json() as { code: string }).code).toBe("forbidden_origin");

      // Seed a provider + incident.
      const { randomUUID } = await import("node:crypto");
      const { encryptProviderKey, readProviderMasterKey } = await import("../packages/ai/src/credentials");
      const masterKey = readProviderMasterKey({ AI_PROVIDER_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" })!;
      const providerId = randomUUID();
      await db`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,revision,api_key_ciphertext)
        VALUES(${providerId},'Privacy API fixture','openai-compatible','https://provider.example/v1','fixture-model',true,1,
          ${encryptProviderKey(providerId, "sk-privacy-api-fixture-dummy-key-000", masterKey)})`;
      const [host] = await db`INSERT INTO agents(hostname,token_hash) VALUES('privacy-api-fixture','not-an-agent-token') RETURNING id`;
      const [incident] = await db`INSERT INTO incidents(agent_id,title,category) VALUES(${host.id},'Privacy API fixture','disk') RETURNING id`;

      // Without consent: investigate fails closed with 403 privacy_consent_required and
      // nothing is queued; the provider test is blocked the same way.
      const blocked = await hub.request(`/api/incidents/${incident.id}/investigate`, "POST", { providerId, providerRevision: 1, model: "m" });
      expect(blocked.status).toBe(403);
      expect((await blocked.json() as { code: string }).code).toBe(PRIVACY_CONSENT_REQUIRED);
      const blockedTest = await hub.request(`/api/ai/providers/${providerId}/test`, "POST", {});
      expect(blockedTest.status).toBe(403);
      expect((await blockedTest.json() as { code: string }).code).toBe(PRIVACY_CONSENT_REQUIRED);
      expect((await db`SELECT id FROM investigations WHERE incident_id=${incident.id}`).length).toBe(0);
      const blockAudits = await db<{ action: string; data: { context: string } }[]>`
        SELECT action,data FROM audit_events WHERE action='privacy.egress_blocked' ORDER BY id`;
      expect(blockAudits.map((r) => r.data.context).sort()).toEqual(["incident.investigate", "provider.test"]);

      // Grant consent via the API: audited as privacy.consent_granted.
      const grant = await hub.request("/api/privacy/consent", "PUT", { aiEgressConsentGranted: true, redactPii: true, consentedBy: "integration" });
      expect(grant.status).toBe(200);
      const grantedBody = await grant.json() as { consent: { aiEgressConsentGranted: boolean; redactPii: boolean; consentedBy: string } };
      expect(grantedBody.consent.aiEgressConsentGranted).toBe(true);
      expect(grantedBody.consent.redactPii).toBe(true);
      expect(grantedBody.consent.consentedBy).toBe("integration");

      // Now investigate queues (202) and the provider test queues (202).
      const allowed = await hub.request(`/api/incidents/${incident.id}/investigate`, "POST", { providerId, providerRevision: 1, model: "m" });
      expect(allowed.status).toBe(202);
      expect((await db`SELECT id FROM investigations WHERE incident_id=${incident.id}`).length).toBe(1);
      const testQueued = await hub.request(`/api/ai/providers/${providerId}/test`, "POST", {});
      expect(testQueued.status).toBe(202);

      // Revoke via the API: audited, and egress is blocked again.
      const revoke = await hub.request("/api/privacy/consent", "PUT", { aiEgressConsentGranted: false });
      expect(revoke.status).toBe(200);
      const blockedAgain = await hub.request(`/api/incidents/${incident.id}/investigate`, "POST", { providerId, providerRevision: 1, model: "other" });
      expect(blockedAgain.status).toBe(403);
      expect((await blockedAgain.json() as { code: string }).code).toBe(PRIVACY_CONSENT_REQUIRED);

      const actions = (await db<{ action: string }[]>`SELECT action FROM audit_events WHERE action LIKE 'privacy.%' ORDER BY id`).map((r) => r.action);
      expect(actions).toEqual(["privacy.egress_blocked", "privacy.egress_blocked", "privacy.consent_granted", "privacy.consent_revoked", "privacy.egress_blocked"]);
    } finally {
      await hub.stop();
    }
  });
}, 60_000);

test("addEvidence redacts email and IP addresses before storage when redact_pii is enabled", async () => {
  process.env.DATABASE_URL ??= "postgres://opspilot:opspilot@127.0.0.1:5433/opspilot";
  const { addEvidence } = await import("../apps/hub/src/incidents");

  const runWithPii = async (redactPii: boolean) => {
    const { sql, calls } = fakeExecutor((sqlText) =>
      sqlText.includes("FROM privacy_settings") ? [{ ...GRANTED_ROW, redact_pii: redactPii }] : [],
    );
    await addEvidence(
      "00000000-0000-4000-8000-000000000001",
      "journal",
      "user ops@example.com failed from ::1 and 10.0.0.5 password=hunter2",
      sql,
    );
    const insert = calls.find((c) => c.sql.includes("INSERT INTO evidence"));
    expect(insert).toBeDefined();
    return insert!.values[2] as string;
  };

  const withPii = await runWithPii(true);
  expect(withPii).not.toContain("ops@example.com");
  expect(withPii).not.toContain("::1");
  expect(withPii).not.toContain("10.0.0.5");
  expect(withPii).not.toContain("hunter2");
  expect(withPii).toContain("[REDACTED_EMAIL]");
  expect(withPii).toContain("[REDACTED_IP]");

  const withoutPii = await runWithPii(false);
  expect(withoutPii).toContain("ops@example.com");
  expect(withoutPii).toContain("10.0.0.5");
  expect(withoutPii).not.toContain("hunter2");
});
