CREATE TABLE IF NOT EXISTS host_services (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 runtime TEXT NOT NULL DEFAULT 'systemd' CHECK (runtime IN ('systemd', 'docker', 'process')),
 state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('running', 'stopped', 'failed', 'unknown')),
 source TEXT NOT NULL DEFAULT 'demo_fixture',
 observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE (agent_id, name)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_host_services_agent ON host_services(agent_id, name);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS endpoint_monitors (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
 service_name TEXT,
 name TEXT NOT NULL,
 target_url TEXT NOT NULL,
 expected_status INTEGER NOT NULL DEFAULT 200 CHECK (expected_status BETWEEN 100 AND 599),
 probe_location TEXT NOT NULL DEFAULT 'hub-local',
 last_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN ('up', 'down', 'unknown')),
 last_http_status INTEGER,
 last_latency_ms INTEGER,
 last_error TEXT,
 last_checked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_endpoint_monitors_created ON endpoint_monitors(created_at DESC);
