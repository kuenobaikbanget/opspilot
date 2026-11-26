-- Hybrid incident-memory retrieval (FTS + optional pgvector).
--
-- The normalized float array in `embedding_values` is ALWAYS persisted so hybrid
-- retrieval works on plain PostgreSQL 16 via the exact bounded cosine-similarity
-- fallback. When the pgvector extension is available (e.g. pgvector/pgvector:pg16)
-- it is enabled automatically and a native `embedding_vector vector` column is
-- added for `<=>` cosine-distance queries. Embeddings are opt-in per memory row
-- (`embedding_consent`) and only ever cover curated human-confirmed
-- `summary + resolution`, never raw logs or unredacted evidence.

ALTER TABLE incident_memory
 ADD COLUMN IF NOT EXISTS embedding_values DOUBLE PRECISION[],
 ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER,
 ADD COLUMN IF NOT EXISTS embedding_model TEXT,
 ADD COLUMN IF NOT EXISTS embedding_provider_id UUID REFERENCES ai_providers(id) ON DELETE SET NULL,
 ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS embedding_consent BOOLEAN NOT NULL DEFAULT FALSE;
-- statement-breakpoint
-- Enable pgvector only when the server actually ships it (plain postgres:16-alpine does not).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'incident_memory' AND column_name = 'embedding_vector'
    ) THEN
      ALTER TABLE incident_memory ADD COLUMN embedding_vector vector;
    END IF;
  END IF;
END $$;
-- statement-breakpoint
-- Pending opt-in embeddings are scanned through this partial index (max 5 per worker tick).
CREATE INDEX IF NOT EXISTS idx_incident_memory_embedding_pending
 ON incident_memory (created_at)
 WHERE embedding_consent AND embedded_at IS NULL;
-- statement-breakpoint
-- Bounded scan of embedded rows for retrieval.
CREATE INDEX IF NOT EXISTS idx_incident_memory_embedded_at
 ON incident_memory (embedded_at)
 WHERE embedding_values IS NOT NULL;
