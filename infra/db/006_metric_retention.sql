-- Hourly rollups of raw telemetry; raw rows are deleted once they leave the raw retention window.
CREATE TABLE metric_samples_hourly (
 agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 hour TIMESTAMPTZ NOT NULL,
 sample_count INTEGER NOT NULL CHECK (sample_count > 0),
 cpu_min DOUBLE PRECISION NOT NULL,
 cpu_max DOUBLE PRECISION NOT NULL,
 cpu_avg DOUBLE PRECISION NOT NULL,
 memory_min DOUBLE PRECISION NOT NULL,
 memory_max DOUBLE PRECISION NOT NULL,
 memory_avg DOUBLE PRECISION NOT NULL,
 disk_min DOUBLE PRECISION NOT NULL,
 disk_max DOUBLE PRECISION NOT NULL,
 disk_avg DOUBLE PRECISION NOT NULL,
 network_rx_bytes BIGINT NOT NULL,
 network_tx_bytes BIGINT NOT NULL,
 PRIMARY KEY (agent_id, hour)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_metric_samples_hourly_hour ON metric_samples_hourly(hour);
-- statement-breakpoint
-- Retention scans locate the oldest retained raw sample by time alone.
CREATE INDEX IF NOT EXISTS idx_metric_samples_sampled_at ON metric_samples(sampled_at DESC);
