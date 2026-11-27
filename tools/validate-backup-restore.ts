#!/usr/bin/env bun
/**
 * Backup/restore validation helpers for OpsPilot.
 *
 * Exported functions are reused by tests/retention-backup-restore.test.ts; the CLI covers
 * operator runbooks:
 *
 *   bun run tools/validate-backup-restore.ts verify-checksum <backup.dump>
 *   bun run tools/validate-backup-restore.ts verify-archive <backup.dump> [pg_restore]
 *   bun run tools/validate-backup-restore.ts compare <sourceUrl> <targetUrl>
 *
 * `compare` verifies that a restored database matches the source: identical applied
 * migrations (name + checksum), identical table sets, and identical row counts per table.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { SQL } from "bun";

export type ChecksumResult = {
  ok: boolean;
  expected?: string;
  actual?: string;
  reason?: string;
};

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

/**
 * Verifies a `<archive>.sha256` sidecar (sha256sum format: `<hex>  <filename>`) against the
 * archive bytes. Negative cases (missing sidecar, malformed line, tampered archive) all
 * return ok:false with a reason; they never throw.
 */
export async function verifyChecksumSidecar(dumpPath: string, sidecarPath = `${dumpPath}.sha256`): Promise<ChecksumResult> {
  let sidecar: string;
  try {
    sidecar = await readFile(sidecarPath, "utf8");
  } catch {
    return { ok: false, reason: `missing checksum sidecar: ${sidecarPath}` };
  }
  const line = sidecar.split("\n").find((l) => l.trim() !== "");
  const match = /^([0-9a-fA-F]{64})\s+[* ]?(.+)$/.exec(line ?? "");
  if (!match) return { ok: false, reason: "sidecar is not in sha256sum format" };
  const expected = match[1].toLowerCase();
  const actual = await sha256File(dumpPath);
  if (expected !== actual) {
    return { ok: false, expected, actual, reason: "SHA-256 mismatch: archive is corrupt or tampered" };
  }
  if (match[2].trim() !== basename(dumpPath)) {
    return { ok: false, expected, actual, reason: `sidecar names '${match[2]}' but archive is '${basename(dumpPath)}'` };
  }
  return { ok: true, expected, actual };
}

/** Structural archive check: pg_restore --list must parse the custom-format archive. */
export async function verifyArchive(dumpPath: string, pgRestoreBin = process.env.PG_RESTORE_BIN || "pg_restore"): Promise<{ ok: boolean; reason?: string }> {
  const proc = Bun.spawn([pgRestoreBin, "--list", dumpPath], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code === 0) return { ok: true };
  const stderr = await new Response(proc.stderr).text();
  return { ok: false, reason: `pg_restore --list exited ${code}: ${stderr.trim().split("\n")[0] ?? "unreadable archive"}` };
}

export type CompareResult = {
  ok: boolean;
  migrationsMatch: boolean;
  tablesMatch: boolean;
  differences: string[];
};

async function tableNames(db: SQL): Promise<string[]> {
  const rows = await db<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  return rows.map((r) => r.name);
}

async function rowCount(db: SQL, table: string): Promise<number> {
  // Identifiers come from information_schema, never from user input.
  const [row] = await db.unsafe(`SELECT COUNT(*)::bigint AS n FROM public."${table.replaceAll('"', '""')}"`);
  return Number((row as { n: number | string }).n);
}

async function migrationNames(db: SQL): Promise<Map<string, string>> {
  const rows = await db<{ name: string; checksum: string }[]>`SELECT name, checksum FROM schema_migrations ORDER BY name`;
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

/** Compares a restored target database against its source after a backup/restore drill. */
export async function compareDatabases(sourceUrl: string, targetUrl: string): Promise<CompareResult> {
  const source = new SQL(sourceUrl);
  const target = new SQL(targetUrl);
  const differences: string[] = [];
  try {
    const sourceMigrations = await migrationNames(source).catch(() => new Map<string, string>());
    const targetMigrations = await migrationNames(target).catch(() => new Map<string, string>());
    const migrationsMatch = sourceMigrations.size === targetMigrations.size &&
      [...sourceMigrations].every(([name, checksum]) => targetMigrations.get(name) === checksum);
    if (!migrationsMatch) differences.push("schema_migrations differ between source and target");

    const sourceTables = await tableNames(source);
    const targetTables = await tableNames(target);
    const tablesMatch = sourceTables.length === targetTables.length &&
      sourceTables.every((t, i) => t === targetTables[i]);
    if (!tablesMatch) {
      differences.push(`table set differs: source=[${sourceTables.join(",")}] target=[${targetTables.join(",")}]`);
    }

    for (const table of sourceTables) {
      if (!targetTables.includes(table)) continue;
      const a = await rowCount(source, table);
      const b = await rowCount(target, table);
      if (a !== b) differences.push(`row count differs for ${table}: source=${a} target=${b}`);
    }
    return { ok: differences.length === 0, migrationsMatch, tablesMatch, differences };
  } finally {
    await source.close();
    await target.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "verify-checksum" && rest[0]) {
    const result = await verifyChecksumSidecar(rest[0]);
    if (!result.ok) {
      console.error(`FAIL: ${result.reason ?? "checksum mismatch"}`);
      process.exit(1);
    }
    console.log(`OK: ${rest[0]} sha256=${result.actual}`);
    return;
  }
  if (command === "verify-archive" && rest[0]) {
    const result = await verifyArchive(rest[0], rest[1]);
    if (!result.ok) {
      console.error(`FAIL: ${result.reason ?? "unreadable archive"}`);
      process.exit(1);
    }
    console.log(`OK: ${rest[0]} is a readable pg_dump custom-format archive`);
    return;
  }
  if (command === "compare" && rest[0] && rest[1]) {
    const result = await compareDatabases(rest[0], rest[1]);
    if (!result.ok) {
      for (const d of result.differences) console.error(`DIFF: ${d}`);
      process.exit(1);
    }
    console.log(`OK: target matches source (migrations, tables, row counts)`);
    return;
  }
  console.error("usage: validate-backup-restore.ts verify-checksum <dump> | verify-archive <dump> [pg_restore] | compare <sourceUrl> <targetUrl>");
  process.exit(2);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
