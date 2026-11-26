import { SQL } from "bun";
import { readProviderMasterKey } from "@opspilot/ai/credentials";
import { runDueEndpointChecks } from "./endpoint-scheduler";
import { runMetricRetention, runOneInvestigation, runOneProviderTest, type WorkerReliabilityOptions } from "./jobs";
import { indexPendingMemoryEmbeddings } from "./memory-embeddings";

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

// Stable per-process identity plus bounded lease/retry knobs; invalid values fall back to defaults.
const envNumber = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const reliability: WorkerReliabilityOptions = {
  workerId: process.env.WORKER_ID || undefined,
  leaseMs: envNumber("WORKER_LEASE_MS"),
  retryBackoffMs: envNumber("WORKER_RETRY_BACKOFF_MS"),
};

console.log("OpsPilot worker started");
if (!masterKey) {
  console.error("AI provider encryption is unavailable; AI jobs are paused. Configure AI_PROVIDER_ENCRYPTION_KEY.");
}

// Never overlap polls in one worker; DB SKIP LOCKED protects multiple workers.
while (true) {
  try {
    await runOneInvestigation(db, masterKey, undefined, reliability);
    await runOneProviderTest(db, masterKey);
    await runDueEndpointChecks(db);
    await runMetricRetention(db);
    // Opt-in embedding indexer: no-op unless OPSPILOT_MEMORY_EMBEDDINGS_ENABLED=true,
    // a master key exists and an embedding-capable provider is configured.
    await indexPendingMemoryEmbeddings(db, masterKey);
  } catch {
    console.error("Worker poll failed");
  }
  await Bun.sleep(interval);
}
