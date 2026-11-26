-- Persisted endpoint monitor scheduling configuration and bounded check-result history.
-- 005-007 are reserved by parallel branches; this file is the next free number.
ALTER TABLE endpoint_monitors
 ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true,
 ADD COLUMN IF NOT EXISTS check_interval_seconds INTEGER NOT NULL DEFAULT 60
  CHECK (check_interval_seconds BETWEEN 15 AND 86400);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS endpoint_monitor_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 monitor_id UUID NOT NULL REFERENCES endpoint_monitors(id) ON DELETE CASCADE,
 probe_location TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('up', 'down')),
 http_status INTEGER,
 latency_ms INTEGER,
 error TEXT,
 started_at TIMESTAMPTZ NOT NULL,
 finished_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_endpoint_monitor_runs_monitor ON endpoint_monitor_runs(monitor_id, started_at DESC, id DESC);
-- statement-breakpoint
-- Retention support: prune per-monitor history in started_at order.
CREATE INDEX IF NOT EXISTS idx_endpoint_monitor_runs_started ON endpoint_monitor_runs(started_at DESC);
-- statement-breakpoint
-- Bounded scheduling: due monitors by per-monitor interval and enabled flag.
CREATE INDEX IF NOT EXISTS idx_endpoint_monitors_scheduling ON endpoint_monitors(enabled, last_checked_at NULLS FIRST, created_at);
