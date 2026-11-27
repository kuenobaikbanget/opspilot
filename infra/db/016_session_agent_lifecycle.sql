-- Phase 4.1: server-side admin session lifecycle + agent credential lifecycle.
-- Admin sessions are tracked in PostgreSQL by hashed token so logout, revocation,
-- idle timeout and absolute expiry are enforced server-side (a replayed cookie is
-- rejected even when its HMAC signature and exp claim are still valid).
CREATE TABLE IF NOT EXISTS sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 -- SHA-256 hex of the full signed session token; the raw token never touches the DB.
 session_hash TEXT NOT NULL UNIQUE,
 -- SHA-256 hex of the per-session CSRF token bound to this session.
 csrf_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 -- Absolute expiry; mirrors the token exp claim but is enforced server-side.
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ,
 user_agent TEXT,
 ip TEXT
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(session_hash) WHERE revoked_at IS NULL;
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at) WHERE revoked_at IS NULL;
-- statement-breakpoint
-- Agent credential lifecycle: revoked agents are rejected on HTTP and WebSocket
-- auth; last_rotated_at records the most recent credential rotation.
ALTER TABLE agents
 ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS last_rotated_at TIMESTAMPTZ;
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agents_revoked ON agents(revoked_at) WHERE revoked_at IS NOT NULL;
