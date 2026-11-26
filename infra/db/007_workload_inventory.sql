-- Workload inventory: latest per-host collection report plus scoped resource columns on host_services.
-- Rows written by the workload collector use source='agent_workloads'; the single-unit systemd
-- collector keeps source='agent_systemd' and never touches these columns.
ALTER TABLE host_services ADD COLUMN IF NOT EXISTS cpu_percent DOUBLE PRECISION;
ALTER TABLE host_services ADD COLUMN IF NOT EXISTS memory_bytes BIGINT;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS host_workload_reports (
 agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
 session_id UUID NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('ok','disabled','unsupported','unavailable')),
 reason TEXT CHECK (reason IS NULL OR reason IN ('docker_cli_missing','docker_daemon_unreachable','systemd_manager_missing','permission_denied','command_failed','command_timeout','output_overflow')),
 skipped TEXT[] NOT NULL DEFAULT '{}' CHECK (array_length(skipped,1) IS NULL OR array_length(skipped,1) <= 2),
 observed_at TIMESTAMPTZ NOT NULL
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_host_services_source_time ON host_services(source, observed_at DESC);
