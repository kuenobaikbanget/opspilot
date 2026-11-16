import { SQL } from "bun";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = new SQL(url);
const raw = await Bun.file(new URL("../infra/db/001_init.sql", import.meta.url)).text();
// Bun SQL can run statements separately. Migration is deliberately single-version starter.
// Avoid naïve splitting on semicolons: SQL functions / comments may contain them.
const statements = raw.split("-- statement-breakpoint").map(s => s.trim()).filter(Boolean);
for (const statement of statements) await sql.unsafe(statement);
console.log(`Applied ${statements.length} idempotent SQL statements`);
await sql.close();
