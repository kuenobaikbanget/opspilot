import { SQL } from "bun";
import { randomBytes } from "node:crypto";

const configuredUrl = process.env.AI_PROVIDER_TEST_DATABASE_URL;
export const providerTestDatabaseAvailable = Boolean(configuredUrl);

export function providerTestDatabaseUrl(): URL {
  if (!configuredUrl) throw new Error("AI_PROVIDER_TEST_DATABASE_URL is required for provider integration tests");
  const url = new URL(configuredUrl);
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^opspilot_byok_test[a-zA-Z0-9_]*$/.test(url.pathname.slice(1)) ||
      url.search || url.hash) {
    throw new Error("Provider tests require a loopback opspilot_byok_test database");
  }
  return url;
}

export async function withProviderTestDb<T>(callback: (db: SQL, databaseUrl: string) => Promise<T>): Promise<T> {
  const base = providerTestDatabaseUrl();
  const name = `opspilot_byok_test_${randomBytes(12).toString("hex")}`;
  const admin = new SQL(base.href);
  let db: SQL | undefined;
  let created = false;
  try {
    // The identifier is generated here, never taken from environment or a caller.
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const child = new URL(base);
    child.pathname = `/${name}`;
    db = new SQL(child.href);
    return await callback(db, child.href);
  } finally {
    try {
      if (db) await db.close();
    } finally {
      try {
        if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await admin.close();
      }
    }
  }
}
