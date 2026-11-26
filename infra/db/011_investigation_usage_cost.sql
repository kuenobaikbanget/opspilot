-- Optional per-investigation LLM token usage and cost estimate recorded by the Worker.
-- All columns stay NULL for failed/queued rows and for investigations run before this migration;
-- an estimate is informational only and never blocks or fails a job.
ALTER TABLE investigations
 ADD COLUMN IF NOT EXISTS input_tokens INTEGER CHECK (input_tokens >= 0),
 ADD COLUMN IF NOT EXISTS output_tokens INTEGER CHECK (output_tokens >= 0),
 ADD COLUMN IF NOT EXISTS thinking_tokens INTEGER CHECK (thinking_tokens >= 0),
 ADD COLUMN IF NOT EXISTS total_tokens INTEGER CHECK (total_tokens >= 0),
 ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(12, 6) CHECK (estimated_cost_usd >= 0);
