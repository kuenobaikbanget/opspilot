import { db, audit } from "./db";
import { redact } from "@opspilot/ai";

/** Creates a new incident, optionally records initial evidence, and writes an audit event. */
export async function createIncident(
  agentId: string,
  category: string,
  title: string,
  source?: string,
  evidenceText?: string,
): Promise<string> {
  const rows =
    await db`INSERT INTO incidents(agent_id,category,title) VALUES(${agentId},${category},${title}) RETURNING id`;
  const id = rows[0].id as string;
  if (source && evidenceText) {
    await addEvidence(id, source, evidenceText);
  }
  await audit("incident.created", id, { agentId, category });
  return id;
}

/** Redacts, truncates, and stores an evidence entry for an incident. */
export async function addEvidence(
  incidentId: string,
  source: string,
  content: string,
) {
  const cleaned = redact(content).slice(0, 6000);
  await db`INSERT INTO evidence(incident_id,source,content) VALUES(${incidentId},${source.slice(0, 100)},${cleaned})`;
}

const history = new Map<string, number>();

export function hostThresholds() {
  const limit = (configured: string | undefined, fallback: number) => {
    const value = Number(configured || fallback);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  };
  return {
    cpu_percent: limit(process.env.ALERT_CPU_THRESHOLD, 95),
    memory_percent: limit(process.env.ALERT_MEMORY_THRESHOLD, 90),
    disk_percent: limit(process.env.ALERT_DISK_THRESHOLD, 90),
  };
}

/** Evaluates host telemetry against alert thresholds and opens deduplicated incidents after two consecutive breaches. */
export async function checkThresholds(
  agentId: string,
  values: { cpuPercent: number; memoryPercent: number; diskPercent: number },
) {
  const thresholds = hostThresholds();
  const checks = [
    ["cpu", values.cpuPercent, thresholds.cpu_percent],
    ["memory", values.memoryPercent, thresholds.memory_percent],
    ["disk", values.diskPercent, thresholds.disk_percent],
  ] as const;

  for (const [category, value, limit] of checks) {
    const key = `${agentId}:${category}`;
    const count = limit !== null && value >= limit ? (history.get(key) || 0) + 1 : 0;
    history.set(key, count);
    if (count !== 2) {
      continue;
    }

    const recent =
      await db`SELECT id FROM incidents WHERE agent_id=${agentId} AND category=${category} AND created_at>NOW()-INTERVAL '15 minutes' LIMIT 1`;
    if (!recent.length) {
      await createIncident(
        agentId,
        category,
        `${category.toUpperCase()} threshold exceeded`,
        "metrics",
        `${category}=${value.toFixed(1)}% >= ${limit}% (2 consecutive samples)`,
      );
    }
  }
}

/** Records updated configuration file SHA-256 snapshots and opens a `config_drift` incident on hash changes. */
export async function checkConfigHashes(
  agentId: string,
  hashes: Record<string, string>,
) {
  for (const [path, checksum] of Object.entries(hashes).slice(0, 20)) {
    if (!path.startsWith("/") || path.length > 256 || !/^[a-f0-9]{64}$/.test(checksum)) {
      continue;
    }

    const prior =
      await db`SELECT checksum_sha256 FROM config_snapshots WHERE agent_id=${agentId} AND file_path=${path} ORDER BY captured_at DESC LIMIT 1`;
    if (!prior.length || prior[0].checksum_sha256 !== checksum) {
      await db`INSERT INTO config_snapshots(agent_id,file_path,checksum_sha256) VALUES(${agentId},${path},${checksum})`;
      if (prior.length) {
        await createIncident(
          agentId,
          "config_drift",
          `Configuration changed: ${path}`,
          "config_hash",
          `File ${path}: prior SHA256 ${prior[0].checksum_sha256}; current SHA256 ${checksum}. Changes are correlated, not proven causal.`,
        );
      }
    }
  }
}
