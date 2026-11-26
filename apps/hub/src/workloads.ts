import {
  WORKLOAD_LIST_LIMIT,
  WORKLOAD_STALE_AFTER_SECONDS,
  type HostWorkloads,
  type Workload,
  type WorkloadCollection,
  type WorkloadCollector,
  type WorkloadInventoryReport,
  type WorkloadList,
  type WorkloadState,
  type WorkloadUnavailableReason,
} from "@opspilot/contracts";
import { db } from "./db";
import { reportIsCurrent } from "./systemd";

const source = "agent_workloads";

/** Persists the latest accepted inventory report and syncs the host's agent_workloads rows. */
export async function storeWorkloadInventory(agentId: string, sessionId: string, report: WorkloadInventoryReport) {
  const reason = "reason" in report ? report.reason ?? null : null;
  const skipped = report.status === "ok" && report.skipped ? report.skipped : [];
  // Fixed-enum values only; an explicit literal keeps empty arrays valid for the text[] cast.
  const skippedLiteral = `{${skipped.join(",")}}`;
  await db.begin(async tx => {
    const accepted = await tx`INSERT INTO host_workload_reports(agent_id,session_id,status,reason,skipped,observed_at)
      VALUES(${agentId},${sessionId},${report.status},${reason},${skippedLiteral}::text[],${report.observedAt})
      ON CONFLICT (agent_id) DO UPDATE SET session_id=excluded.session_id,status=excluded.status,reason=excluded.reason,
        skipped=excluded.skipped,observed_at=excluded.observed_at
      WHERE host_workload_reports.observed_at < excluded.observed_at RETURNING agent_id`;
    if (!accepted.length) return;
    // A successful empty scan removes every row; disabled/unsupported/unavailable cannot claim what remains.
    if (report.status !== "ok") {
      await tx`DELETE FROM host_services WHERE agent_id=${agentId} AND source=${source}`;
      return;
    }
    const keys = report.workloads.map(w => `${w.runtime}:${w.name}`);
    // Runtimes are fixed enums and names match strict [A-Za-z0-9_.@-] patterns, so a literal is injection-safe here.
    const keysLiteral = `{${keys.join(",")}}`;
    if (keys.length) {
      await tx`DELETE FROM host_services WHERE agent_id=${agentId} AND source=${source} AND NOT ((runtime || ':' || name) = ANY(${keysLiteral}::text[]))`;
    } else {
      await tx`DELETE FROM host_services WHERE agent_id=${agentId} AND source=${source}`;
    }
    for (const w of report.workloads) {
      await tx`INSERT INTO host_services(agent_id,name,runtime,state,source,observed_at,cpu_percent,memory_bytes)
        VALUES(${agentId},${w.name},${w.runtime},${w.state},${source},${report.observedAt},${w.cpuPercent ?? null},${w.memoryBytes ?? null})
        ON CONFLICT (agent_id,source,runtime,name) DO UPDATE SET state=excluded.state,
          observed_at=excluded.observed_at,cpu_percent=excluded.cpu_percent,memory_bytes=excluded.memory_bytes`;
    }
  });
}

type ReportRow = {
  agent_id: string;
  session_id: string | null;
  status: WorkloadCollection["status"] | null;
  reason: string | null;
  skipped: string[] | null;
  reported_at: Date | null;
};

type WorkloadRow = Omit<Workload, "observed_at" | "memory_bytes"> & {
  observed_at: Date;
  memory_bytes: number | null;
};

/** Host-scoped inventory read model: collection status, per-workload freshness and host counts. */
export async function readHostWorkloads(
  agentId: string,
  getSession: (id: string) => string | undefined,
): Promise<HostWorkloads | null> {
  const [row] = await db<ReportRow[]>`SELECT a.id AS agent_id,r.session_id,r.status,r.reason,r.skipped,r.observed_at AS reported_at
    FROM agents a LEFT JOIN host_workload_reports r ON r.agent_id=a.id WHERE a.id=${agentId}`;
  if (!row) return null;
  const rows = await db<WorkloadRow[]>`SELECT id,agent_id,name,runtime,state,source,observed_at,cpu_percent,
      memory_bytes::double precision AS memory_bytes
    FROM host_services WHERE agent_id=${agentId} AND source=${source} ORDER BY runtime,name LIMIT ${WORKLOAD_LIST_LIMIT}`;
  const session = getSession(row.agent_id);
  const now = new Date();
  const current = row.reported_at !== null &&
    reportIsCurrent(row.session_id, session, row.reported_at, WORKLOAD_STALE_AFTER_SECONDS, now);
  const fresh = current && row.status === "ok";
  const collection: WorkloadCollection | null = row.status && row.reported_at ? {
    status: row.status,
    reason: row.reason as WorkloadUnavailableReason | null,
    skipped: (row.skipped ?? []) as WorkloadCollector[],
    observed_at: row.reported_at.toISOString(),
    current,
  } : null;
  const counts = { total: rows.length, running: 0, stopped: 0, failed: 0, unknown: 0 };
  const workloads = rows.map(w => {
    counts[w.state as WorkloadState] += 1;
    return { ...w, observed_at: w.observed_at.toISOString(), freshness: fresh ? "fresh" as const : "stale" as const };
  });
  return {
    agent_id: row.agent_id,
    online: !!session,
    checked_at: now.toISOString(),
    collection,
    workloads,
    counts,
  };
}

/** Fleet inventory listing; totals, host counts and state counts are computed fleet-wide, not per page. */
export async function readWorkloadList(
  getSession: (id: string) => string | undefined,
): Promise<WorkloadList> {
  const now = new Date();
  const [fleet, rows, countRows, reportRows] = await Promise.all([
    db<{ id: string }[]>`SELECT id FROM agents`,
    db<WorkloadRow[]>`SELECT id,agent_id,name,runtime,state,source,observed_at,cpu_percent,
        memory_bytes::double precision AS memory_bytes
      FROM host_services WHERE source=${source} ORDER BY observed_at DESC,id LIMIT ${WORKLOAD_LIST_LIMIT}`,
    db<WorkloadList["counts"][]>`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE state='running')::int AS running,
        COUNT(*) FILTER (WHERE state='stopped')::int AS stopped,
        COUNT(*) FILTER (WHERE state='failed')::int AS failed,
        COUNT(*) FILTER (WHERE state='unknown')::int AS unknown
      FROM host_services WHERE source=${source}`,
    db<{ agent_id: string; session_id: string }[]>`SELECT agent_id,session_id FROM host_workload_reports
      WHERE status='ok' AND observed_at > NOW() - INTERVAL '1 second' * ${WORKLOAD_STALE_AFTER_SECONDS}`,
  ]);
  const counts = countRows[0] ?? { total: 0, running: 0, stopped: 0, failed: 0, unknown: 0 };
  return {
    workloads: rows.map(w => ({ ...w, observed_at: w.observed_at.toISOString() })),
    total: counts.total,
    hosts_total: fleet.length,
    hosts_online: fleet.reduce((count, host) => count + Number(!!getSession(host.id)), 0),
    hosts_collecting: reportRows.filter(r => getSession(r.agent_id) === r.session_id).length,
    counts,
    limit: WORKLOAD_LIST_LIMIT,
    observed_at: now.toISOString(),
    stale_after_seconds: WORKLOAD_STALE_AFTER_SECONDS,
  };
}
