-- Investigation reliability: worker leases, retry budgets and deduplication.
-- Lease/retry columns back the Worker claim loop; dedupe_key enforces at most one
-- active (queued/running) investigation per (incident, provider, revision, model).
ALTER TABLE investigations
 ADD COLUMN lease_expires_at TIMESTAMPTZ,
 ADD COLUMN worker_id TEXT,
 ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
 ADD COLUMN next_retry_at TIMESTAMPTZ,
 ADD COLUMN dedupe_key TEXT;
-- statement-breakpoint
-- PostgreSQL enforces deduplication atomically: only one active investigation per key.
-- Terminal rows do not participate, so a completed/failed investigation can be re-run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_investigations_dedupe_active
 ON investigations(dedupe_key)
 WHERE status IN ('queued','running') AND dedupe_key IS NOT NULL;
-- statement-breakpoint
-- Worker polling: claimable queued jobs (due by retry time), then expired leases.
CREATE INDEX IF NOT EXISTS idx_investigations_claim
 ON investigations(next_retry_at,created_at) WHERE status='queued';
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_investigations_lease_recovery
 ON investigations(lease_expires_at) WHERE status='running';
