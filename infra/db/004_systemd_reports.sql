CREATE TABLE host_systemd_reports (
 agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
 session_id UUID NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('observed', 'disabled', 'unsupported', 'unavailable')),
 observed_at TIMESTAMPTZ NOT NULL
);
