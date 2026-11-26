-- Memory deduplication and provenance (Phase 3.4).
-- Canonical incident memories: repeat resolutions merge into one canonical row
-- (occurrence_count grows, last_confirmed_at refreshes) while every contributing
-- incident stays traceable in incident_memory_sources. Merged (non-canonical) rows
-- keep their incident_id but point at the surviving canonical memory.
-- Only columns from migrations 001..011 are referenced, so this file applies cleanly
-- both directly on top of 011 and after 012..014 are merged.
ALTER TABLE incident_memory
 ADD COLUMN IF NOT EXISTS content_fingerprint TEXT,
 ADD COLUMN IF NOT EXISTS canonical_memory_id UUID REFERENCES incident_memory(id) ON DELETE SET NULL,
 ADD COLUMN IF NOT EXISTS occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
 ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- statement-breakpoint
-- NULL canonical_memory_id marks the active canonical memory; merged rows point at it.
CREATE INDEX IF NOT EXISTS idx_incident_memory_fingerprint
 ON incident_memory(content_fingerprint) WHERE canonical_memory_id IS NULL;
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_incident_memory_canonical
 ON incident_memory(canonical_memory_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS incident_memory_sources (
 memory_id UUID NOT NULL REFERENCES incident_memory(id) ON DELETE CASCADE,
 incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
 agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
 hostname TEXT,
 category TEXT,
 incident_title TEXT,
 resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (memory_id, incident_id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_incident_memory_sources_incident
 ON incident_memory_sources(incident_id);
-- statement-breakpoint
-- Backfill: every existing memory row gets its own provenance row from its incident,
-- joining the agent for the originating hostname. Idempotent on re-run.
INSERT INTO incident_memory_sources(memory_id,incident_id,agent_id,hostname,category,incident_title,resolved_at)
SELECT m.id, m.incident_id, i.agent_id, a.hostname, i.category, i.title, COALESCE(i.resolved_at, m.created_at)
FROM incident_memory m
JOIN incidents i ON i.id = m.incident_id
LEFT JOIN agents a ON a.id = i.agent_id
ON CONFLICT DO NOTHING;
-- statement-breakpoint
-- Bounded per-investigation snapshot of which prior memories were retrieved
-- (InvestigationMemoryAttribution[]), stored when the investigation completes.
ALTER TABLE investigations
 ADD COLUMN IF NOT EXISTS retrieved_memories_json JSONB;
