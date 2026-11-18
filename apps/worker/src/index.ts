import { SQL } from "bun";
import { readProviderMasterKey } from "@opspilot/ai/credentials";
import { runOneInvestigation, runOneProviderTest } from "./jobs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL missing");
}

const db = new SQL({
  url: process.env.DATABASE_URL,
  max: 4,
  idleTimeout: 30,
});

const interval = Math.max(
  1000,
  Number(process.env.INVESTIGATION_POLL_MS || 3000),
);

const masterKey = readProviderMasterKey(process.env);
console.log("OpsPilot worker started");
if (!masterKey) {
  console.error("AI provider encryption is unavailable; AI jobs are paused. Configure AI_PROVIDER_ENCRYPTION_KEY.");
}

// Never overlap polls in one worker; DB SKIP LOCKED protects multiple workers.
while (true) {
  try {
    await runOneInvestigation(db, masterKey);
    await runOneProviderTest(db, masterKey);
  } catch {
    console.error("Worker poll failed");
  }
  await Bun.sleep(interval);
}
