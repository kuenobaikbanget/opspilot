-- Phase 4.2 — privacy consent gate and redaction metadata.
-- privacy_settings is a singleton row (id = 1) holding the workspace privacy consent
-- state. External AI/LLM egress (investigations, connection tests, embeddings) fails
-- closed unless ai_egress_consent_granted is TRUE. Every grant/revoke is audited by the
-- Hub (privacy.consent_granted / privacy.consent_revoked / privacy.egress_blocked).
-- Only columns from migrations 001..015 are referenced, so this file applies cleanly on
-- top of 015 and after 016.
CREATE TABLE IF NOT EXISTS privacy_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ai_egress_consent_granted BOOLEAN NOT NULL DEFAULT FALSE,
  consent_version TEXT NOT NULL DEFAULT 'opspilot-privacy-consent-v1',
  consented_at TIMESTAMPTZ,
  consented_by TEXT,
  redact_pii BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- statement-breakpoint
-- Seed the singleton row; existing deployments start without egress consent.
INSERT INTO privacy_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;
-- statement-breakpoint
-- Structured redaction summary (counts by category, never raw matched values) stored
-- alongside redacted evidence at ingestion time.
ALTER TABLE evidence
 ADD COLUMN IF NOT EXISTS redaction_summary JSONB;
