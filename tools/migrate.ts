import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required");
}

const sql = new SQL(url);
const directory = new URL("../infra/db/", import.meta.url);

try {
  const names = (await readdir(directory))
    .filter((name) => /^\d+_[^/]+\.sql$/.test(name))
    .sort();

  for (const name of names) {
    const raw = await Bun.file(new URL(name, directory)).text();
    const checksum = createHash("sha256").update(raw).digest("hex");
    // Functions and comments can contain semicolons; only explicit boundaries split SQL.
    const statements = raw
      .split("-- statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    const applied = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(73460712)`;
      await tx`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      const [existing] = await tx`
        SELECT checksum FROM schema_migrations WHERE name = ${name}
      `;
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`Migration checksum mismatch: ${name}`);
        }
        return false;
      }

      for (const statement of statements) {
        await tx.unsafe(statement);
      }
      await tx`
        INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${checksum})
      `;
      return true;
    });

    console.log(`${applied ? "Applied" : "Already applied"} migration ${name}`);
  }
} finally {
  await sql.close();
}
