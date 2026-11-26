import type { SQL } from "bun";
import { db, audit } from "./db";
import { redact } from "@opspilot/ai";
import type { HostThresholds } from "@opspilot/contracts";

/** Creates a new incident, optionally records initial evidence, and writes an audit event. */
export async function createIncident(
  agentId: string,
  category: string,
  title: string,
  source?: string,
  evidenceText?: string,
  executor: SQL = db,
): Promise<string> {
  const rows =
    await executor`INSERT INTO incidents(agent_id,category,title) VALUES(${agentId},${category},${title}) RETURNING id`;
  const id = rows[0].id as string;
  if (source && evidenceText) {
    await addEvidence(id, source, evidenceText, executor);
  }
  await audit("incident.created", id, { agentId, category }, executor);
  return id;
}

/** Redacts, truncates, and stores an evidence entry for an incident. */
export async function addEvidence(
  incidentId: string,
  source: string,
  content: string,
  executor: SQL = db,
) {
  const cleaned = redact(content).slice(0, 6000);
  await executor`INSERT INTO evidence(incident_id,source,content) VALUES(${incidentId},${source.slice(0, 100)},${cleaned})`;
}

function envLimit(configured: string | undefined, fallback: number): number | null {
  const value = Number(configured || fallback);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/** Global default alert limits from Hub environment configuration; invalid values disable the limit. */
export function hostThresholds(): HostThresholds {
  return {
    cpu_percent: envLimit(process.env.ALERT_CPU_THRESHOLD, 95),
    memory_percent: envLimit(process.env.ALERT_MEMORY_THRESHOLD, 90),
    disk_percent: envLimit(process.env.ALERT_DISK_THRESHOLD, 90),
  };
}

/** Effective limits for one host: a persisted override row wins entirely (null disables); otherwise env defaults. */
export async function effectiveThresholds(
  agentId: string,
  executor: SQL = db,
): Promise<HostThresholds> {
  const defaults = hostThresholds();
  const rows =
    await executor<{ cpu_percent: number | null; memory_percent: number | null; disk_percent: number | null }[]>`
      SELECT cpu_percent,memory_percent,disk_percent FROM alert_thresholds WHERE agent_id=${agentId}`;
  if (!rows.length) return defaults;
  // An override row is authoritative: an explicit null disables that metric's alert.
  return { cpu_percent: rows[0].cpu_percent, memory_percent: rows[0].memory_percent, disk_percent: rows[0].disk_percent };
}

/** Cooldown window in seconds applied after a breach before the condition returns to ok. */
export function cooldownSeconds(): number {
  const value = Number(process.env.ALERT_COOLDOWN_SECONDS || 900);
  return Number.isFinite(value) && value >= 0 && value <= 86_400 ? Math.trunc(value) : 900;
}

const METRICS = ["cpu", "memory", "disk"] as const;
type Metric = (typeof METRICS)[number];
const METRIC_VALUE: Record<Metric, "cpuPercent" | "memoryPercent" | "diskPercent"> = {
  cpu: "cpuPercent",
  memory: "memoryPercent",
  disk: "diskPercent",
};
const METRIC_LIMIT: Record<Metric, keyof HostThresholds> = {
  cpu: "cpu_percent",
  memory: "memory_percent",
  disk: "disk_percent",
};

type ConditionRow = {
  metric: Metric;
  state: "ok" | "breaching" | "breached" | "cooldown";
  consecutive: number;
  cooldown_until: Date | null;
  incident_id: string | null;
};

/**
 * Evaluates host telemetry against effective thresholds and persists the condition state
 * (breach streak, breached incident, cooldown) so Hub restarts keep alerting context.
 * Opens a deduplicated incident after two consecutive breaches, as before.
 */
export async function checkThresholds(
  agentId: string,
  values: { cpuPercent: number; memoryPercent: number; diskPercent: number },
) {
  const thresholds = await effectiveThresholds(agentId);
  const cooldownMs = cooldownSeconds() * 1000;
  const now = Date.now();
  await db.begin(async (tx) => {
    const rows =
      await tx<ConditionRow[]>`SELECT metric,state,consecutive,cooldown_until,incident_id
        FROM alert_conditions WHERE agent_id=${agentId} FOR UPDATE`;
    const byMetric = new Map(rows.map((row) => [row.metric, row]));

    for (const metric of METRICS) {
      const limit = thresholds[METRIC_LIMIT[metric]];
      const value = values[METRIC_VALUE[metric]];
      const row = byMetric.get(metric);
      const state = row?.state ?? "ok";
      let consecutive = row?.consecutive ?? 0;
      let nextState = state;
      let cooldownUntil: Date | null = row?.cooldown_until ?? null;
      let incidentId: string | null = row?.incident_id ?? null;

      if (limit === null) {
        nextState = "ok";
        consecutive = 0;
        cooldownUntil = null;
        incidentId = null;
      } else if (value >= limit) {
        consecutive += 1;
        if (consecutive >= 2 && state !== "breached") {
          const recent =
            await tx<{ id: string }[]>`SELECT id FROM incidents
              WHERE agent_id=${agentId} AND category=${metric} AND created_at>NOW()-INTERVAL '15 minutes' LIMIT 1`;
          if (!recent.length) {
            incidentId = await createIncident(
              agentId,
              metric,
              `${metric.toUpperCase()} threshold exceeded`,
              "metrics",
              `${metric}=${value.toFixed(1)}% >= ${limit}% (2 consecutive samples)`,
              tx,
            );
          }
          nextState = "breached";
          cooldownUntil = new Date(now + cooldownMs);
        } else if (state !== "breached") {
          nextState = "breaching";
        }
      } else {
        consecutive = 0;
        if (state === "breached" || state === "breaching") {
          nextState = "cooldown";
          cooldownUntil = new Date(now + cooldownMs);
        } else if (state === "cooldown" && (!cooldownUntil || cooldownUntil.getTime() <= now)) {
          nextState = "ok";
          cooldownUntil = null;
        }
      }

      await tx`INSERT INTO alert_conditions(agent_id,metric,state,consecutive,cooldown_until,incident_id,updated_at)
        VALUES(${agentId},${metric},${nextState},${consecutive},${cooldownUntil},${incidentId},NOW())
        ON CONFLICT (agent_id,metric) DO UPDATE SET
          state=excluded.state,consecutive=excluded.consecutive,cooldown_until=excluded.cooldown_until,
          incident_id=excluded.incident_id,updated_at=NOW()`;
    }
  });
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
