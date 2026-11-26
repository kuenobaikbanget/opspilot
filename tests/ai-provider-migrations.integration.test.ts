import { expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, readdir, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AI_PROVIDER_PRESETS } from "../packages/contracts/src";
import { decryptProviderKey } from "../packages/ai/src/credentials";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

const root = new URL("../", import.meta.url).pathname;
const master = Buffer.alloc(32).toString("base64");
const migrationNames = ["001_init.sql", "002_ai_providers.sql", "003_services_endpoints.sql", "004_systemd_reports.sql", "005_alert_state.sql", "006_metric_retention.sql", "007_workload_inventory.sql", "008_endpoint_monitor_runs.sql", "009_host_services_unique_key.sql", "010_investigation_reliability.sql", "011_investigation_usage_cost.sql", "012_config_drift_diffs.sql"];
const ids = [1, 2, 3].map((n) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const presets = [AI_PROVIDER_PRESETS.openai, AI_PROVIDER_PRESETS.anthropic, AI_PROVIDER_PRESETS.gemini];
const keys = ["dummy-openai-secret", "dummy-anthropic-secret", "dummy-gemini-secret"];
const legacyEnv = {
  OPENAI_API_KEY: keys[0]!, OPENAI_MODEL: "import-openai-model",
  ANTHROPIC_API_KEY: keys[1]!, ANTHROPIC_MODEL: "import-anthropic-model",
  GEMINI_API_KEY: keys[2]!, GEMINI_MODEL: "import-gemini-model",
};

async function run(script: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", script], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { code, output: stdout + stderr };
}
async function migrate(url: string, script = join(root, "tools/migrate.ts")) {
  const result = await run(script, { DATABASE_URL: url });
  expect(result.code).toBe(0);
}
async function copiedRunner(callback: (directory: string, runner: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "opspilot-migrations-"));
  try {
    await mkdir(join(directory, "tools"));
    await mkdir(join(directory, "infra/db"), { recursive: true });
    await copyFile(join(root, "tools/migrate.ts"), join(directory, "tools/migrate.ts"));
    for (const name of await readdir(join(root, "infra/db"))) {
      if (/^\d+_[^/]+\.sql$/.test(name)) await copyFile(join(root, "infra/db", name), join(directory, "infra/db", name));
    }
    await callback(directory, join(directory, "tools/migrate.ts"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const integration = providerTestDatabaseAvailable ? test : test.skip;

integration("fresh migrations create ledger and reruns preserve data", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const ledger = await db`SELECT * FROM schema_migrations ORDER BY name`;
    expect(ledger.map((row) => row.name)).toEqual(migrationNames);
    expect(ledger.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
    await db`INSERT INTO ai_providers (id,name,protocol,base_url,default_model,enabled,api_key_ciphertext)
      VALUES (${randomUUID()},'sentinel','openai-compatible','https://example.com/v1','model',true,'ciphertext-sentinel')`;
    await migrate(url);
    expect(await db`SELECT * FROM schema_migrations ORDER BY name`).toEqual(ledger);
    expect((await db`SELECT count(*)::int AS count FROM ai_providers`)[0].count).toBe(1);
    expect((await db`SELECT column_name FROM information_schema.columns WHERE table_name='investigations' AND column_name='provider'`).length).toBe(0);
  });
}, 30000);

integration("legacy migration preserves terminal history and terminates unfinished investigations", async () => {
  await withProviderTestDb(async (db, url) => {
    const initial = await Bun.file(join(root, "infra/db/001_init.sql")).text();
    for (const statement of initial.split("-- statement-breakpoint").filter((s) => s.trim())) await db.unsafe(statement);
    const agent = randomUUID(), incident = randomUUID();
    await db`INSERT INTO agents(id,hostname,token_hash) VALUES (${agent},'legacy','dummy')`;
    await db`INSERT INTO incidents(id,agent_id,title,category) VALUES (${incident},${agent},'legacy','test')`;
    for (const [index, status] of ["completed", "failed", "queued", "running"].entries()) {
      await db`INSERT INTO investigations(incident_id,provider,status,result_json,error,created_at,started_at,completed_at)
        VALUES (${incident},${["openai", "anthropic", "gemini", "openai"][index]},${status},${JSON.stringify({ legacy: status })}::jsonb,
          ${`legacy-${status}`},'2021-01-01T00:00:00Z','2021-01-02T00:00:00Z',${index < 2 ? "2021-01-03T00:00:00Z" : null}::timestamptz)`;
    }
    const before = await db`SELECT * FROM investigations ORDER BY error`;
    await migrate(url);
    const after = await db`SELECT * FROM investigations ORDER BY created_at,id`;
    for (const old of before) {
      const row = after.find((item) => item.id === old.id)!;
      expect(row.provider_id).toBeNull(); expect(row.provider_revision).toBeNull();
      expect(row.provider_base_url).toBeNull(); expect(row.provider_model).toBeNull();
      expect(row.provider_name).toBe(({ openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini" } as Record<string, string>)[old.provider]);
      expect(row.provider_protocol).toBe(old.provider === "openai" ? "openai-compatible" : old.provider);
      for (const field of ["result_json", "created_at", "started_at"]) expect(row[field]).toEqual(old[field]);
      if (["completed", "failed"].includes(old.status)) {
        for (const field of ["status", "error", "completed_at"]) expect(row[field]).toEqual(old[field]);
      } else {
        expect(row.status).toBe("failed");
        expect(row.error).toBe("Provider configuration migrated; start a new investigation.");
        expect(row.completed_at).not.toBeNull();
      }
    }
    await migrate(url);
    expect(await db`SELECT * FROM investigations ORDER BY created_at,id`).toEqual(after);
  });
}, 30000);

integration("checksum mismatch stops runner and failed files roll back without applying successors", async () => {
  await withProviderTestDb(async (db, url) => {
    await copiedRunner(async (directory, runner) => {
      await migrate(url, runner);
      await appendFile(join(directory, "infra/db/002_ai_providers.sql"), "\n-- changed checksum\n");
      const mismatch = await run(runner, { DATABASE_URL: url });
      expect(mismatch.code).not.toBe(0); expect(mismatch.output).toContain("checksum mismatch");
      expect((await db`SELECT count(*)::int AS count FROM schema_migrations`)[0].count).toBe(migrationNames.length);
    });
    await copiedRunner(async (directory, runner) => {
      await Bun.write(join(directory, "infra/db/004_failure.sql"), "CREATE TABLE rollback_sentinel(id integer);\n-- statement-breakpoint\nSELECT * FROM deliberately_missing_relation;");
      await Bun.write(join(directory, "infra/db/005_never.sql"), "CREATE TABLE successor_sentinel(id integer);");
      expect((await run(runner, { DATABASE_URL: url })).code).not.toBe(0);
      const [tables] = await db`SELECT to_regclass('rollback_sentinel') AS rollback, to_regclass('successor_sentinel') AS successor`;
      expect(tables.rollback).toBeNull(); expect(tables.successor).toBeNull();
      expect((await db`SELECT count(*)::int AS count FROM schema_migrations`)[0].count).toBe(migrationNames.length);
    });
  });
}, 30000);

const importer = join(root, "tools/import-ai-providers.ts");
test("import without legacy keys needs neither master key nor database", async () => {
  expect((await run(importer)).code).toBe(0);
});
test("import rejects malformed or missing master before opening database", async () => {
  for (const encryption of [undefined, "invalid", Buffer.alloc(31).toString("base64")]) {
    const result = await run(importer, { OPENAI_API_KEY: keys[0]!, DATABASE_URL: "postgres://127.0.0.1:1/unreachable", ...(encryption === undefined ? {} : { AI_PROVIDER_ENCRYPTION_KEY: encryption }) });
    expect(result.code).not.toBe(0);
    expect(result.output).not.toMatch(/ECONNREFUSED|Failed to connect|Connection refused/i);
    expect(result.output).not.toContain(keys[0]!);
  }
});

test("package import command ignores retained .env but validates explicitly exported keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opspilot-import-env-"));
  try {
    for (const relative of [
      "package.json",
      "tools/import-ai-providers.ts",
      "packages/contracts/src/index.ts",
      "packages/contracts/src/drift.ts",
      "packages/contracts/src/changes.ts",
      "packages/ai/src/credentials.ts",
      "packages/ai/src/provider-http.ts",
    ]) {
      const destination = join(directory, relative);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(root, relative), destination);
    }
    await Bun.write(join(directory, ".env"), "OPENAI_API_KEY=dummy-retained-env-secret\n");
    const invoke = async (env: Record<string, string>) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", "run", "ai:import-env"], {
        cwd: directory,
        // Do not inherit credentials, database URLs or Bun options from the test runner.
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, NODE_ENV: "test", ...env },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { code, output: stdout + stderr };
    };
    const empty = await invoke({});
    expect(empty.code).toBe(0);
    expect(empty.output).toContain("No legacy provider credentials found; no changes made.");
    const explicit = await invoke({ OPENAI_API_KEY: "dummy-explicit-env-secret" });
    expect(explicit.code).not.toBe(0);
    expect(explicit.output).toContain("AI provider import failed. Check master key");
    expect(explicit.output).not.toContain("DATABASE_URL is required");
    for (const result of [empty, explicit]) {
      expect(result.output).not.toContain("dummy-retained-env-secret");
      expect(result.output).not.toContain("dummy-explicit-env-secret");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

integration("import all presets encrypts keys, honors explicit models and identical reruns are no-op", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    const env = { DATABASE_URL: url, AI_PROVIDER_ENCRYPTION_KEY: master, ...legacyEnv };
    const first = await run(importer, env); expect(first.code).toBe(0);
    const rows = await db`SELECT * FROM ai_providers ORDER BY id`;
    expect(rows.length).toBe(3);
    for (const [index, row] of rows.entries()) {
      const preset = presets[index]!;
      expect(row.id).toBe(ids[index]); expect(row.name).toBe(preset.name);
      expect(row.protocol).toBe(preset.protocol); expect(row.base_url).toBe(preset.baseUrl);
      expect(row.enabled).toBe(true); expect(row.revision).toBe(1);
      expect(row.default_model).toBe([legacyEnv.OPENAI_MODEL, legacyEnv.ANTHROPIC_MODEL, legacyEnv.GEMINI_MODEL][index]);
      expect(row.api_key_ciphertext).not.toContain(keys[index]!);
      expect(decryptProviderKey(row.id, row.api_key_ciphertext, Buffer.alloc(32))).toBe(keys[index]!);
      expect(first.output).not.toContain(keys[index]!);
    }
    expect((await run(importer, env)).code).toBe(0);
    expect(await db`SELECT * FROM ai_providers ORDER BY id`).toEqual(rows);
    const failed = await run(importer, { ...env, GEMINI_API_KEY: "different-dummy-key" });
    expect(failed.code).not.toBe(0); expect(failed.output).not.toContain("different-dummy-key");
    expect(await db`SELECT * FROM ai_providers ORDER BY id`).toEqual(rows);
  });
}, 30000);

integration("import collisions roll back earlier inserts and defaults use shared presets", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    await db`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,api_key_ciphertext)
      VALUES (${ids[2]!},'collision','gemini','https://example.com/v1','other',true,'invalid-envelope')`;
    const before = await db`SELECT * FROM ai_providers`;
    const result = await run(importer, { DATABASE_URL: url, AI_PROVIDER_ENCRYPTION_KEY: master, ...legacyEnv });
    expect(result.code).not.toBe(0); expect(await db`SELECT * FROM ai_providers`).toEqual(before);
    for (const key of keys) expect(result.output).not.toContain(key);
    await db`DELETE FROM ai_providers`;
    expect((await run(importer, { DATABASE_URL: url, AI_PROVIDER_ENCRYPTION_KEY: master, OPENAI_API_KEY: keys[0]! })).code).toBe(0);
    expect((await db`SELECT default_model FROM ai_providers`)[0].default_model).toBe(AI_PROVIDER_PRESETS.openai.defaultModel);
  });
}, 30000);

integration("import enforces connection limit atomically", async () => {
  await withProviderTestDb(async (db, url) => {
    await migrate(url);
    await db`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,api_key_ciphertext)
      SELECT gen_random_uuid(),'filler','openai-compatible','https://example.com/v1','model',true,'dummy' FROM generate_series(1,99)`;
    const env = { DATABASE_URL: url, AI_PROVIDER_ENCRYPTION_KEY: master };
    expect((await run(importer, { ...env, ...legacyEnv })).code).not.toBe(0);
    expect((await db`SELECT count(*)::int AS count FROM ai_providers`)[0].count).toBe(99);
    expect((await run(importer, { ...env, OPENAI_API_KEY: keys[0]! })).code).toBe(0);
    expect((await db`SELECT count(*)::int AS count FROM ai_providers`)[0].count).toBe(100);
    expect((await run(importer, { ...env, ANTHROPIC_API_KEY: keys[1]! })).code).not.toBe(0);
    expect((await db`SELECT count(*)::int AS count FROM ai_providers`)[0].count).toBe(100);
  });
}, 30000);
