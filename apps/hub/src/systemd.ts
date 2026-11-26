import {
  SYSTEMD_STALE_AFTER_SECONDS,
  type HostSystemdStatus,
  type SystemdReport,
  type SystemdState,
} from "@opspilot/contracts";
import { db } from "./db";

const source = "agent_systemd";

export async function storeSystemdReport(agentId: string, sessionId: string, report: SystemdReport) {
  const unit = "unit" in report ? report.unit ?? null : null;
  await db.begin(async tx => {
    const accepted = await tx`INSERT INTO host_systemd_reports(agent_id,session_id,status,observed_at)
      VALUES(${agentId},${sessionId},${report.status},${report.observedAt})
      ON CONFLICT (agent_id) DO UPDATE SET session_id=excluded.session_id,status=excluded.status,observed_at=excluded.observed_at
      WHERE host_systemd_reports.observed_at < excluded.observed_at RETURNING agent_id`;
    if (!accepted.length) return;
    await tx`DELETE FROM host_services WHERE agent_id=${agentId} AND source=${source} AND name IS DISTINCT FROM ${unit}::text`;
    if (report.status === "observed") {
      await tx`INSERT INTO host_services(agent_id,name,runtime,state,source,observed_at)
        VALUES(${agentId},${report.unit},'systemd',${report.state},${source},${report.observedAt})
        ON CONFLICT (agent_id,source,runtime,name) DO UPDATE SET state=excluded.state,
          observed_at=excluded.observed_at`;
    }
  });
}

type StatusRow = {
  agent_id: string;
  session_id: string | null;
  status: SystemdReport["status"] | null;
  reported_at: Date | null;
  id: string | null;
  name: string | null;
  state: SystemdState | null;
  observed_at: Date | null;
};

export async function readSystemdStatus(agentId: string, getSession: (id: string) => string | undefined): Promise<HostSystemdStatus | null> {
  const [row] = await db<StatusRow[]>`SELECT a.id AS agent_id,r.session_id,r.status,r.observed_at AS reported_at,
      s.id,s.name,s.state,s.observed_at
    FROM agents a LEFT JOIN host_systemd_reports r ON r.agent_id=a.id
    LEFT JOIN LATERAL (
      SELECT id,name,state,observed_at FROM host_services WHERE agent_id=a.id AND runtime='systemd' AND source=${source}
      ORDER BY observed_at DESC LIMIT 1
    ) s ON r.agent_id IS NOT NULL WHERE a.id=${agentId}`;
  if (!row) return null;

  const session = getSession(row.agent_id);
  const now = new Date();
  const report = row.status && row.reported_at ? {
    status: row.status,
    observed_at: row.reported_at.toISOString(),
    current: reportIsCurrent(row.session_id, session, row.reported_at, SYSTEMD_STALE_AFTER_SECONDS, now),
  } : null;
  return {
    agent_id: row.agent_id,
    online: !!session,
    checked_at: now.toISOString(),
    report,
    service: row.id && row.name && row.state && row.observed_at ? {
      id: row.id,
      agent_id: row.agent_id,
      name: row.name,
      runtime: "systemd",
      source,
      state: row.state,
      observed_at: row.observed_at.toISOString(),
      freshness: report?.current && report.status === "observed" ? "fresh" : "stale",
    } : null,
  };
}

/** True when a stored report came from the agent's current socket and is inside the stale window. */
export function reportIsCurrent(
  sessionId: string | null,
  currentSession: string | undefined,
  observedAt: Date,
  staleAfterSeconds: number,
  now = new Date(),
): boolean {
  return sessionId !== null && sessionId === currentSession &&
    now.getTime() - observedAt.getTime() <= staleAfterSeconds * 1000;
}
