-- Recorded change events (deployments, config changes, service restarts, maintenance)
-- and operator-curated links between incidents and change targets.
--
-- Non-causal invariant: change_events and linked config_snapshots are temporal
-- context only. incident_change_links never record a causation claim.
-- This migration only reads standard columns from 001 (agents, incidents,
-- config_snapshots), so it applies cleanly on top of 011 and after 012.
CREATE TABLE IF NOT EXISTS change_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK (kind IN ('deployment','config_change','service_restart','maintenance')),
 title TEXT NOT NULL,
 service_name TEXT,
 version TEXT,
 summary TEXT,
 source TEXT NOT NULL DEFAULT 'operator',
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_change_events_agent_time ON change_events(agent_id, occurred_at DESC);
-- statement-breakpoint
-- Exactly one target per link row: a change event XOR a config snapshot.
CREATE TABLE IF NOT EXISTS incident_change_links (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
 change_event_id UUID REFERENCES change_events(id) ON DELETE CASCADE,
 config_snapshot_id UUID REFERENCES config_snapshots(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK (status IN ('linked','dismissed')),
 note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT incident_change_links_one_target CHECK ((change_event_id IS NOT NULL) <> (config_snapshot_id IS NOT NULL))
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_incident_change_links_incident ON incident_change_links(incident_id);
-- statement-breakpoint
-- At most one link row per (incident, change event).
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_change_links_event
 ON incident_change_links(incident_id, change_event_id)
 WHERE change_event_id IS NOT NULL;
-- statement-breakpoint
-- At most one link row per (incident, config snapshot).
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_change_links_snapshot
 ON incident_change_links(incident_id, config_snapshot_id)
 WHERE config_snapshot_id IS NOT NULL;
