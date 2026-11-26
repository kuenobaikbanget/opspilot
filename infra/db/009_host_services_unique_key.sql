-- Scope host_services uniqueness by source and runtime so single-unit systemd reports
-- (source='agent_systemd'), workload inventory (source='agent_workloads'), and distinct
-- runtimes sharing a name never overwrite each other.
ALTER TABLE host_services DROP CONSTRAINT IF EXISTS host_services_agent_id_name_key;
-- statement-breakpoint
ALTER TABLE host_services ADD CONSTRAINT host_services_agent_source_runtime_name_key UNIQUE (agent_id, source, runtime, name);
