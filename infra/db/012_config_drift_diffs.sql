-- Config drift timeline & semantic diffs (Phase 3.1).
-- Backwards-compatible extension of config_snapshots: every new column is nullable or has a
-- safe default, so existing hash-only rows (agent_id, file_path, checksum_sha256, captured_at)
-- remain valid and keep diff_status='hash_only'.
ALTER TABLE config_snapshots
 ADD COLUMN previous_snapshot_id UUID REFERENCES config_snapshots(id) ON DELETE SET NULL,
 ADD COLUMN diff_status TEXT NOT NULL DEFAULT 'hash_only' CHECK (diff_status IN ('hash_only','diff_available','unavailable')),
 ADD COLUMN unavailable_reason TEXT,
 ADD COLUMN content_format TEXT,
 ADD COLUMN content_redacted TEXT,
 ADD COLUMN content_truncated BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN redaction_count INTEGER NOT NULL DEFAULT 0 CHECK (redaction_count >= 0),
 ADD COLUMN semantic_diff_json JSONB,
 ADD COLUMN diff_summary TEXT,
 ADD COLUMN incident_id UUID REFERENCES incidents(id) ON DELETE SET NULL;
-- statement-breakpoint
-- Drift timeline queries: fleet-wide chronological and per-agent chronological.
CREATE INDEX IF NOT EXISTS idx_config_snapshots_captured_at ON config_snapshots(captured_at DESC);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_config_snapshots_agent_captured ON config_snapshots(agent_id, captured_at DESC);
-- statement-breakpoint
-- Snapshots linked to a config_drift incident (evidence-first diagnosis reads these).
CREATE INDEX IF NOT EXISTS idx_config_snapshots_incident ON config_snapshots(incident_id) WHERE incident_id IS NOT NULL;
