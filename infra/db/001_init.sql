-- OpsPilot starter schema. ALTER changes should be versioned in future migrations.
CREATE TABLE IF NOT EXISTS agents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 hostname TEXT NOT NULL,
 token_hash TEXT NOT NULL,
 version TEXT NOT NULL DEFAULT 'dev',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_seen_at TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'offline'
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS enrollment_tokens (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 token_hash TEXT NOT NULL UNIQUE,
 expires_at TIMESTAMPTZ NOT NULL,
 used_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS metric_samples (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 cpu_percent DOUBLE PRECISION NOT NULL,
 memory_percent DOUBLE PRECISION NOT NULL,
 disk_percent DOUBLE PRECISION NOT NULL,
 network_rx_bytes BIGINT NOT NULL,
 network_tx_bytes BIGINT NOT NULL,
 uptime_seconds BIGINT NOT NULL
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_metric_samples_agent_time ON metric_samples(agent_id,sampled_at DESC);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS config_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 file_path TEXT NOT NULL,
 checksum_sha256 TEXT NOT NULL,
 captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_config_snapshots_agent_file ON config_snapshots(agent_id,file_path,captured_at DESC);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS incidents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 category TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 resolved_at TIMESTAMPTZ,
 resolution TEXT
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_incidents_time ON incidents(created_at DESC);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
 source TEXT NOT NULL,
 content TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_evidence_incident ON evidence(incident_id,created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS investigations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','gemini')),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
 result_json JSONB,
 error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 started_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_investigations_queue ON investigations(status,created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS incident_memory (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 incident_id UUID NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
 summary TEXT NOT NULL,
 resolution TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_incident_memory_fts ON incident_memory USING GIN(to_tsvector('simple',summary || ' ' || resolution));
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 action TEXT NOT NULL,
 target_id TEXT,
 data JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
