import type { SQL } from "bun";
import { ENDPOINT_RUNS_RETENTION } from "@opspilot/contracts";
import { probeEndpointTarget, type EndpointProbeResult } from "@opspilot/ai/endpoint-probe";

/** Maximum monitors probed per scheduler tick; bounds worker egress and DB writes. */
export const ENDPOINT_SCHEDULER_BATCH = 8;
/** Bounded per-monitor run history; older rows are pruned in the same transaction. */
export const MAX_RUNS_PER_MONITOR = ENDPOINT_RUNS_RETENTION;
type DueMonitor = {
  id: string;
  target_url: string;
  expected_status: number;
  probe_location: string;
  check_interval_seconds: number;
};

type MonitorRow = {
  id: string;
  target_url: string;
  expected_status: number;
  probe_location: string;
};

/** Records one probe outcome as a run row plus the monitor's last_* state, pruning history. */
export async function recordEndpointProbe(
  db: SQL,
  monitor: MonitorRow,
  probeLocation: string,
  result: EndpointProbeResult,
  startedAt: Date,
  finishedAt: Date,
): Promise<void> {
  await db.begin(async (tx) => {
    await tx`INSERT INTO endpoint_monitor_runs(
        monitor_id,probe_location,status,http_status,latency_ms,error,started_at,finished_at
      ) VALUES(
        ${monitor.id},${probeLocation},${result.status},${result.httpStatus},${result.latencyMs},${result.error},${startedAt},${finishedAt}
      )`;
    await tx`UPDATE endpoint_monitors SET
        last_status=${result.status},
        last_http_status=${result.httpStatus},
        last_latency_ms=${result.latencyMs},
        last_error=${result.error},
        last_checked_at=NOW()
      WHERE id=${monitor.id}`;
    await tx`DELETE FROM endpoint_monitor_runs
      WHERE monitor_id=${monitor.id} AND id NOT IN (
        SELECT id FROM endpoint_monitor_runs WHERE monitor_id=${monitor.id}
        ORDER BY started_at DESC, id DESC LIMIT ${MAX_RUNS_PER_MONITOR}
      )`;
  });
}

/**
 * Bounded periodic scheduling inside the existing worker boundary: claims at most
 * `batch` enabled monitors whose per-monitor interval has elapsed (never-checked first),
 * probes each outside any DB transaction, and persists the run with source timestamps
 * and the actual named probe location. SKIP LOCKED keeps multiple workers disjoint.
 */
export async function runDueEndpointChecks(
  db: SQL,
  options: {
    batch?: number;
    env?: NodeJS.ProcessEnv;
    probe?: typeof probeEndpointTarget;
  } = {},
): Promise<number> {
  const batch = Math.max(1, Math.min(ENDPOINT_SCHEDULER_BATCH, options.batch ?? ENDPOINT_SCHEDULER_BATCH));
  const probe = options.probe ?? probeEndpointTarget;
  const env = options.env ?? process.env;

  const claimed = await db.begin(async (tx) => {
    return tx<DueMonitor[]>`SELECT id,target_url,expected_status,probe_location,check_interval_seconds
      FROM endpoint_monitors
      WHERE enabled
        AND (last_checked_at IS NULL
          OR last_checked_at + (check_interval_seconds || ' seconds')::interval <= NOW())
      ORDER BY last_checked_at NULLS FIRST, created_at
      LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
  });

  for (const monitor of claimed) {
    const startedAt = new Date();
    const result = await probe(monitor.target_url, monitor.expected_status, env);
    const finishedAt = new Date();
    try {
      await recordEndpointProbe(db, monitor, monitor.probe_location, result, startedAt, finishedAt);
    } catch (error: unknown) {
      console.error("Endpoint probe persist failed", monitor.id, error);
    }
  }
  return claimed.length;
}
