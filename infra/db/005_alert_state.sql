-- Per-host alert threshold overrides; NULL columns fall back to Hub environment defaults.
CREATE TABLE alert_thresholds (
 agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
 cpu_percent DOUBLE PRECISION CHECK (cpu_percent IS NULL OR (cpu_percent >= 0 AND cpu_percent <= 100)),
 memory_percent DOUBLE PRECISION CHECK (memory_percent IS NULL OR (memory_percent >= 0 AND memory_percent <= 100)),
 disk_percent DOUBLE PRECISION CHECK (disk_percent IS NULL OR (disk_percent >= 0 AND disk_percent <= 100)),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- statement-breakpoint
-- Persisted breach/cooldown condition state per host and metric, so Hub restarts keep it.
CREATE TABLE alert_conditions (
 agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 metric TEXT NOT NULL CHECK (metric IN ('cpu','memory','disk')),
 state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok','breaching','breached','cooldown')),
 consecutive INTEGER NOT NULL DEFAULT 0 CHECK (consecutive >= 0),
 cooldown_until TIMESTAMPTZ,
 incident_id UUID REFERENCES incidents(id) ON DELETE SET NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (agent_id, metric)
);
-- statement-breakpoint
-- Agent wire protocol version and negotiated capability set reported at enrollment/hello.
ALTER TABLE agents
 ADD COLUMN protocol_version INTEGER CHECK (protocol_version IS NULL OR protocol_version > 0),
 ADD COLUMN capabilities TEXT[] NOT NULL DEFAULT '{}';
