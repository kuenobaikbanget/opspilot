-- Stop legacy Hub/Worker processes before applying this migration.
CREATE TABLE ai_providers (
 id UUID PRIMARY KEY,
 name TEXT NOT NULL,
 protocol TEXT NOT NULL CHECK(protocol IN ('openai-compatible','anthropic','gemini')),
 base_url TEXT NOT NULL,
 default_model TEXT NOT NULL,
 enabled BOOLEAN NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
 api_key_ciphertext TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_test_id UUID,
 last_test_status TEXT CHECK(last_test_status IN ('queued','running','completed','failed')),
 last_test_revision INTEGER CHECK(last_test_revision > 0),
 last_test_model TEXT,
 last_test_error_code TEXT,
 last_test_http_status INTEGER,
 last_test_requested_at TIMESTAMPTZ,
 last_test_started_at TIMESTAMPTZ,
 last_test_completed_at TIMESTAMPTZ,
 last_test_expires_at TIMESTAMPTZ
);
-- statement-breakpoint
ALTER TABLE investigations
 ADD COLUMN provider_id UUID REFERENCES ai_providers(id) ON DELETE SET NULL,
 ADD COLUMN provider_revision INTEGER CHECK(provider_revision > 0),
 ADD COLUMN provider_name TEXT,
 ADD COLUMN provider_protocol TEXT CHECK(provider_protocol IN ('openai-compatible','anthropic','gemini')),
 ADD COLUMN provider_base_url TEXT,
 ADD COLUMN provider_model TEXT;
-- statement-breakpoint
-- Legacy rows recorded only the provider brand, not the destination or model.
UPDATE investigations SET
 provider_name = CASE provider
  WHEN 'openai' THEN 'OpenAI'
  WHEN 'anthropic' THEN 'Anthropic'
  WHEN 'gemini' THEN 'Gemini'
 END,
 provider_protocol = CASE provider
  WHEN 'openai' THEN 'openai-compatible'
  ELSE provider
 END;
-- statement-breakpoint
-- Terminal results, errors and timestamps are deliberately left untouched.
UPDATE investigations SET
 status = 'failed',
 error = 'Provider configuration migrated; start a new investigation.',
 completed_at = NOW()
WHERE status IN ('queued','running');
-- statement-breakpoint
ALTER TABLE investigations
 ALTER COLUMN provider_name SET NOT NULL,
 ALTER COLUMN provider_protocol SET NOT NULL,
 DROP CONSTRAINT investigations_provider_check,
 DROP COLUMN provider;
