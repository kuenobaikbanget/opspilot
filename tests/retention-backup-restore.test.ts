import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMetricRetention } from "../apps/worker/src/jobs";
import { compareDatabases, verifyArchive, verifyChecksumSidecar } from "../tools/validate-backup-restore";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

/**
 * Metrics retention + backup/restore validation (Phase 4):
 *  - retention prunes old raw samples into hourly rollups and keeps growth bounded
 *  - backup checksum verification: positive + tampered/corrupt negatives
 *  - full backup -> restore into an isolated database -> schema/row-count comparison
 *    (integration tests run only when AI_PROVIDER_TEST_DATABASE_URL points at loopback
 *    postgres and pg_dump/pg_restore are available via PG_DUMP_BIN/PG_RESTORE_BIN)
 */

const integration = providerTestDatabaseAvailable ? test : test.skip;
const root = new URL("../", import.meta.url).pathname;
const pgDump = process.env.PG_DUMP_BIN || "pg_dump";
const pgRestore = process.env.PG_RESTORE_BIN || "pg_restore";
const commandAvailable = (bin: string) => {
  try {
    return Bun.spawnSync([bin, "--version"], { stdout: "ignore", stderr: "ignore" }).success;
  } catch {
    return false; // ENOENT when the binary is not installed
  }
};
const pgToolsAvailable = commandAvailable(pgDump) && commandAvailable(pgRestore);
const backupIntegration = integration as typeof test;
const pgIntegration = pgToolsAvailable ? backupIntegration : test.skip;

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "opspilot-backup-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function migrate(databaseUrl: string) {
  const migration = Bun.spawnSync([process.execPath, "--no-env-file", "tools/migrate.ts"], {
    cwd: root, env: { DATABASE_URL: databaseUrl }, timeout: 20_000,
  });
  if (!migration.success) throw new Error(`Migration failed: ${migration.stderr.toString()}`);
}

// --- Checksum validation: pure, no database needed ---

test("checksum: valid sidecar verifies (positive)", async () => {
  const dump = join(workDir, "ok.dump");
  await writeFile(dump, Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0x00, 0x01]));
  const { sha256File } = await import("../tools/validate-backup-restore");
  const sum = await sha256File(dump);
  await writeFile(`${dump}.sha256`, `${sum}  ok.dump\n`);
  const result = await verifyChecksumSidecar(dump);
  expect(result.ok).toBe(true);
  expect(result.actual).toBe(sum);
});

test("checksum: tampered archive is rejected (negative)", async () => {
  const dump = join(workDir, "tampered.dump");
  await writeFile(dump, "original-archive-bytes");
  const { sha256File } = await import("../tools/validate-backup-restore");
  await writeFile(`${dump}.sha256`, `${await sha256File(dump)}  tampered.dump\n`);
  await writeFile(dump, "tampered-archive-bytes");
  const result = await verifyChecksumSidecar(dump);
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("mismatch");
});

test("checksum: missing or malformed sidecar is rejected (negative)", async () => {
  const dump = join(workDir, "nosidecar.dump");
  await writeFile(dump, "data");
  expect((await verifyChecksumSidecar(dump)).ok).toBe(false);
  await writeFile(`${dump}.sha256`, "not a checksum line\n");
  expect((await verifyChecksumSidecar(dump)).ok).toBe(false);
});

// --- Archive structural validation ---

const pgTest = pgToolsAvailable ? test : test.skip;

pgTest("archive: corrupt/garbage archive fails pg_restore --list (negative)", async () => {
  const garbage = join(workDir, "garbage.dump");
  await writeFile(garbage, "this is not a pg_dump custom-format archive at all");
  const result = await verifyArchive(garbage, pgRestore);
  expect(result.ok).toBe(false);
});

// --- Retention policy (integration) ---

integration("retention prunes raw samples into hourly rollups and preserves rollups", async () => {
  await withProviderTestDb(async (db, databaseUrl) => {
    await migrate(databaseUrl);
    const [agent] = await db<{ id: string }[]>`INSERT INTO agents (hostname, token_hash) VALUES ('retention-host', 'hash') RETURNING id`;

    // 30 raw samples: 24 older than the 168h default raw window, 6 recent.
    const old = new Date(Date.now() - 200 * 3_600_000);
    for (let i = 0; i < 24; i++) {
      await db`INSERT INTO metric_samples (agent_id, sampled_at, cpu_percent, memory_percent, disk_percent, network_rx_bytes, network_tx_bytes, uptime_seconds)
        VALUES (${agent.id}, ${new Date(old.getTime() + i * 3_600_000)}, ${10 + i}, 40, 50, 1000, 500, 60)`;
    }
    for (let i = 0; i < 6; i++) {
      await db`INSERT INTO metric_samples (agent_id, sampled_at, cpu_percent, memory_percent, disk_percent, network_rx_bytes, network_tx_bytes, uptime_seconds)
        VALUES (${agent.id}, ${new Date(Date.now() - (i + 1) * 60_000)}, 5, 40, 50, 1000, 500, 60)`;
    }

    // Drain windows until no old raw samples remain (bounded per-call work).
    for (let i = 0; i < 40; i++) {
      if (!(await runMetricRetention(db))) break;
    }

    const raw = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM metric_samples`;
    const rollups = await db<{ n: number; hours: number }[]>`
      SELECT COUNT(*)::int AS n, COUNT(DISTINCT hour)::int AS hours FROM metric_samples_hourly`;
    expect(raw[0].n).toBe(6); // only recent raw samples survive
    expect(rollups[0].n).toBeGreaterThan(0); // old samples preserved as hourly rollups
    expect(rollups[0].hours).toBe(rollups[0].n);

    // Re-running retention is a no-op once everything old is pruned (bounded growth).
    expect(await runMetricRetention(db)).toBe(false);
    const rawAfter = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM metric_samples`;
    expect(rawAfter[0].n).toBe(6);

    // Rollups themselves expire after the rollup retention window.
    await db`INSERT INTO metric_samples_hourly (agent_id, hour, sample_count, cpu_min, cpu_max, cpu_avg, memory_min, memory_max, memory_avg, disk_min, disk_max, disk_avg, network_rx_bytes, network_tx_bytes)
      VALUES (${agent.id}, NOW() - INTERVAL '400 days', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0)`;
    await runMetricRetention(db);
    const stale = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM metric_samples_hourly WHERE hour < NOW() - INTERVAL '90 days'`;
    expect(stale[0].n).toBe(0);
  });
});

// --- Full backup -> restore drill (integration, needs pg tools + loopback postgres) ---

pgIntegration("backup -> restore into isolated DB preserves schema, migrations and rows", async () => {
  await withProviderTestDb(async (sourceDb, sourceUrl) => {
    await migrate(sourceUrl);
    const [agent] = await sourceDb<{ id: string }[]>`INSERT INTO agents (hostname, token_hash) VALUES ('backup-host', 'hash') RETURNING id`;
    await sourceDb`INSERT INTO metric_samples (agent_id, sampled_at, cpu_percent, memory_percent, disk_percent, network_rx_bytes, network_tx_bytes, uptime_seconds)
      VALUES (${agent.id}, NOW(), 11, 22, 33, 10, 5, 99)`;
    await sourceDb`INSERT INTO incidents (agent_id, title, category) VALUES (${agent.id}, 'disk nearly full', 'disk')`;

    const backupDir = join(workDir, `backup-${crypto.randomUUID()}`);
    const backup = Bun.spawnSync(["bash", "tools/backup-db.sh", backupDir], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: sourceUrl, PG_DUMP_BIN: pgDump },
      stdout: "pipe", stderr: "pipe",
    });
    expect(backup.success).toBe(true);
    const dumpPath = backup.stdout.toString().match(/backup written: (.+)/)?.[1];
    expect(dumpPath).toBeTruthy();

    // Positive: checksum verifies, archive is readable.
    expect((await verifyChecksumSidecar(dumpPath!)).ok).toBe(true);
    expect((await verifyArchive(dumpPath!, pgRestore)).ok).toBe(true);

    // Negative: restore of a tampered archive is refused before touching the target.
    await withProviderTestDb(async (targetDb, targetUrl) => {
      await migrate(targetUrl); // target non-empty on purpose for the negative restore
      const tampered = join(workDir, "tampered-restore.dump");
      await Bun.write(tampered, await readFile(dumpPath!));
      const buf = Buffer.from(await readFile(tampered));
      buf[buf.length - 1] ^= 0xff;
      await writeFile(tampered, buf);
      const { sha256File } = await import("../tools/validate-backup-restore");
      await writeFile(`${tampered}.sha256`, `${await sha256File(dumpPath!)}  ${tampered.split("/").pop()}\n`);
      const bad = Bun.spawnSync(["bash", "tools/restore-db.sh", tampered, "--target-url", targetUrl], {
        cwd: root, env: { ...process.env, PG_RESTORE_BIN: pgRestore, PSQL_BIN: process.env.PSQL_BIN || "psql" },
        stdout: "pipe", stderr: "pipe",
      });
      expect(bad.success).toBe(false);
      expect(bad.stderr.toString() + bad.stdout.toString()).toContain("checksum");

      // Negative: a valid archive is still refused into a non-empty target without --clean.
      const nonEmpty = Bun.spawnSync(["bash", "tools/restore-db.sh", dumpPath!, "--target-url", targetUrl], {
        cwd: root, env: { ...process.env, PG_RESTORE_BIN: pgRestore, PSQL_BIN: process.env.PSQL_BIN || "psql" },
        stdout: "pipe", stderr: "pipe",
      });
      expect(nonEmpty.success).toBe(false);
      expect(nonEmpty.stderr.toString() + nonEmpty.stdout.toString()).toContain("not empty");

      // Positive restore drill into a fresh, empty target.
      await withProviderTestDb(async (_emptyDb, emptyUrl) => {
        const restore = Bun.spawnSync(["bash", "tools/restore-db.sh", dumpPath!, "--target-url", emptyUrl], {
          cwd: root, env: { ...process.env, PG_RESTORE_BIN: pgRestore, PSQL_BIN: process.env.PSQL_BIN || "psql" },
          stdout: "pipe", stderr: "pipe",
        });
        expect(restore.success).toBe(true);
        const comparison = await compareDatabases(sourceUrl, emptyUrl);
        expect(comparison.differences).toEqual([]);
        expect(comparison.migrationsMatch).toBe(true);
        expect(comparison.tablesMatch).toBe(true);
      });
    });
  });
});

// --- restore-db.sh pre-17 transaction_timeout tolerance (pure stubbed binaries) ---

test("restore-db.sh: tolerates only complete pre-17 transaction_timeout error and rejects crash/empty stderr", async () => {
  const { chmod } = await import("node:fs/promises");
  const { sha256File } = await import("../tools/validate-backup-restore");

  const dump = join(workDir, "stub-restore.dump");
  await writeFile(dump, "stub-dump");
  await writeFile(`${dump}.sha256`, `${await sha256File(dump)}  stub-restore.dump\n`);

  const psqlStub = join(workDir, "psql-stub.sh");
  await writeFile(
    psqlStub,
    `#!/usr/bin/env bash
if [[ "$*" == *"SHOW server_version_num"* ]]; then
  echo "\${STUB_SERVER_VERSION:-160004}"
elif [[ "$*" == *"information_schema.tables"* ]]; then
  echo "0"
fi
`,
  );
  await chmod(psqlStub, 0o755);

  const pgRestoreStub = join(workDir, "pg-restore-stub.sh");
  await writeFile(
    pgRestoreStub,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "--list" ]]; then
  exit 0
fi
case "\${STUB_RESTORE_MODE:-}" in
  pre17_ok)
    cat >&2 <<'EOF'
pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"
Command was: SET transaction_timeout = 0;
pg_restore: warning: errors ignored on restore: 1
EOF
    exit 1
    ;;
  killed_mid_restore)
    cat >&2 <<'EOF'
pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"
Command was: SET transaction_timeout = 0;
EOF
    exit 137
    ;;
  empty_stderr)
    exit 1
    ;;
  extra_errors)
    cat >&2 <<'EOF'
pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"
Command was: SET transaction_timeout = 0;
pg_restore: warning: errors ignored on restore: 2
EOF
    exit 1
    ;;
esac
exit 1
`,
  );
  await chmod(pgRestoreStub, 0o755);

  const runRestore = (mode: string, serverVersion = "160004") =>
    Bun.spawnSync(["bash", "tools/restore-db.sh", dump, "--target-url", "postgres://localhost:5432/stub"], {
      cwd: root,
      env: {
        ...process.env,
        PG_RESTORE_BIN: pgRestoreStub,
        PSQL_BIN: psqlStub,
        STUB_RESTORE_MODE: mode,
        STUB_SERVER_VERSION: serverVersion,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

  // Positive: pre-17 server with exact transaction_timeout error + errors ignored on restore: 1.
  const ok = runRestore("pre17_ok", "160004");
  expect(ok.success).toBe(true);
  expect(ok.stdout.toString()).toContain("restore complete");

  // Negative: mid-restore crash/kill (missing final summary line).
  const killed = runRestore("killed_mid_restore", "160004");
  expect(killed.success).toBe(false);
  expect(killed.stderr.toString()).toContain("error: pg_restore failed");

  // Negative: non-zero exit with empty stderr.
  const empty = runRestore("empty_stderr", "160004");
  expect(empty.success).toBe(false);
  expect(empty.stderr.toString()).toContain("error: pg_restore failed");

  // Negative: more than 1 ignored error.
  const extra = runRestore("extra_errors", "160004");
  expect(extra.success).toBe(false);
  expect(extra.stderr.toString()).toContain("error: pg_restore failed");

  // Negative: server >= 17 must not tolerate transaction_timeout error.
  const pg17 = runRestore("pre17_ok", "170000");
  expect(pg17.success).toBe(false);
  expect(pg17.stderr.toString()).toContain("error: pg_restore failed");
});
