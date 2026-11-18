import { SQL } from "bun";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL missing");
}

/** Shared PostgreSQL connection pool for the OpsPilot Hub. */
export const db = new SQL({
  url: process.env.DATABASE_URL,
  max: 10,
  idleTimeout: 30,
  connectionTimeout: 10,
});

/** Records an immutable audit event in the `audit_events` table. */
export const audit = async (
  action: string,
  targetId: string | null,
  data: object = {},
) => {
  await db`INSERT INTO audit_events(action,target_id,data) VALUES(${action},${targetId},${JSON.stringify(data)}::jsonb)`;
};

/** Returns a lowercase hex SHA-256 digest for storing or comparing tokens/secrets. */
export const hashSecret = (s: string) =>
  new Bun.CryptoHasher("sha256").update(s).digest("hex");
