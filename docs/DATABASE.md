# Data Design — PostgreSQL

Migration source: numbered `infra/db/*.sql`, applied lexicographically by `bun run db:init`. `schema_migrations(name PRIMARY KEY,checksum,applied_at)` records SHA-256 content checksums. Each file and ledger insert run in one transaction under advisory lock `73460712`; changed applied files stop the runner, failures roll back the active file. Do not edit applied migrations. Starter DBs without a ledger rerun idempotent 001 before recording it; 002 runs once. PostgreSQL init mounts only 001; Compose's one-shot migration service owns subsequent application.

## Logical ER diagram

```mermaid
erDiagram
  agents ||--o{ metric_samples : records
  agents ||--o{ metric_samples_hourly : rolls_up
  agents ||--o{ alert_thresholds : overrides
  agents ||--o{ alert_conditions : tracks
  agents ||--o{ config_snapshots : observes
  agents ||--o{ incidents : generates
  incidents ||--o{ evidence : has
  incidents ||--o{ investigations : undergoes
  incidents ||--o| incident_memory : resolves_to
  incidents ||--o{ incident_memory_sources : contributes_to
  incident_memory ||--o{ incident_memory_sources : has
  incident_memory ||--o{ incident_memory : merges_into
  incidents ||--o{ alert_conditions : links
  incidents ||--o{ incident_change_links : curates
  agents ||--o{ change_events : records
  change_events ||--o{ incident_change_links : targeted_by
  config_snapshots ||--o{ incident_change_links : targeted_by
  ai_providers ||--o{ incident_memory : embeds
  agents { uuid id PK; text hostname; text token_hash; int protocol_version; text[] capabilities; timestamptz last_seen_at }
  metric_samples { bigint id PK; uuid agent_id FK; timestamptz sampled_at; float cpu_percent; float memory_percent; float disk_percent }
  metric_samples_hourly { uuid agent_id PK; timestamptz hour PK; int sample_count; float cpu_min; float cpu_max; float cpu_avg; bigint network_rx_bytes }
  alert_thresholds { uuid agent_id PK; float cpu_percent; float memory_percent; float disk_percent }
  alert_conditions { uuid agent_id PK; text metric PK; text state; int consecutive; timestamptz cooldown_until; uuid incident_id FK }
  config_snapshots { uuid id PK; uuid agent_id FK; text file_path; text checksum_sha256; uuid previous_snapshot_id FK; text diff_status; text unavailable_reason; text content_format; text content_redacted; bool content_truncated; int redaction_count; jsonb semantic_diff_json; text diff_summary; uuid incident_id FK; timestamptz captured_at }
  incidents { uuid id PK; uuid agent_id FK; text title; text category; text status; text resolution }
  evidence { uuid id PK; uuid incident_id FK; text source; text content }
  investigations { uuid id PK; uuid incident_id FK; uuid provider_id FK; text provider_name; text provider_protocol; text provider_model; text status; jsonb result_json; jsonb retrieved_memories_json }
  ai_providers ||--o{ investigations : snapshots
  ai_providers { uuid id PK; text protocol; int revision; text api_key_ciphertext; uuid last_test_id; text last_test_status }
  incident_memory { uuid id PK; uuid incident_id FK; text summary; text resolution; text content_fingerprint; uuid canonical_memory_id FK self; int occurrence_count; timestamptz last_confirmed_at; float8[] embedding_values; int embedding_dimensions; text embedding_model; uuid embedding_provider_id FK; timestamptz embedded_at; bool embedding_consent }
  incident_memory_sources { uuid memory_id PK FK; uuid incident_id PK FK; uuid agent_id FK; text hostname; text category; text incident_title; timestamptz resolved_at }
  change_events { uuid id PK; uuid agent_id FK; text kind; text title; text service_name; text version; text summary; text source; timestamptz occurred_at }
  incident_change_links { uuid id PK; uuid incident_id FK; uuid change_event_id FK; uuid config_snapshot_id FK; text status; text note }
```

## Data table contracts

| Table | Purpose | Retention proposal |
|---|---|---|
| `agents` | enrollment identity hash, name, wire protocol version, negotiated capabilities, last contact | until deletion |
| `enrollment_tokens` | one-time SHA256 token + TTL/used flag | worker deletes spent/expired rows after 24h |
| `metric_samples` | 15s telemetry samples per host | raw window `METRIC_RAW_RETENTION_HOURS` (default 168 = 7d), then rolled up and deleted by the worker |
| `config_snapshots` | allowlisted file hash history, plus opt-in redacted snapshots, semantic diffs and drift incident links (migration 012) | 90d or per-policy |
| `incidents` | incident lifecycle & human resolution | until archive |
| `evidence` | bounded diagnostic output | 30–90d based on privacy |
| `ai_providers` | connection metadata, encrypted key, one bounded asynchronous test slot | credential deleted with connection; no test history table |
| `investigations` | immutable non-secret provider snapshot, status, validated JSON, safe error | 90d |
| `incident_memory` | canonical, deduplicated human-confirmed resolution (`canonical_memory_id IS NULL` = active canonical; non-NULL = merged into that memory) | opt-in long term |
| `incident_memory_sources` | multi-incident provenance for each memory: contributing incident, agent/hostname, category, title, resolved_at | cascades with memory/incident |
| `audit_events` | important admin actions | 90d, tamper protection later |
| `host_systemd_reports`, `host_services` | latest collector report and up to one real systemd observation per host | replaced on new report/observation, cascade on host deletion; no history |
| `metric_samples_hourly` | hourly rollups (count, min/max/avg per resource, last network counters) | `METRIC_ROLLUP_RETENTION_DAYS` (default 90d), deleted by the worker |
| `alert_thresholds` | per-host alert limit overrides (null = environment default) | until host deletion or reset; changes audited |
| `alert_conditions` | persisted per-metric condition state (ok/breaching/breached/cooldown, streak, cooldown, incident link) | until host deletion; survives Hub restarts |
| `endpoint_monitors` | admin-configured HTTP monitor: target, expected status, server-side `probe_location`, `enabled`, per-monitor `check_interval_seconds`, latest `last_*` result | until deletion; cascade |
| `endpoint_monitor_runs` | one persisted probe execution: named `probe_location`, status/HTTP status/latency/error, `started_at`/`finished_at` source timestamps | bounded to 200 rows per monitor, pruned per insert; cascade on monitor deletion |
| `change_events` | operator/agent-recorded change on one host: kind (`deployment|config_change|service_restart|maintenance`), title, optional service/version/summary, source, `occurred_at` | until deletion; cascade on host deletion |
| `incident_change_links` | one manual link or dismissal of a change event XOR config snapshot to an incident (CHECK exactly one target; partial unique per target) | until deletion; cascade on incident/target deletion |

## SQL invariants

- Incident `status`: `open | resolved`.
- Investigation `status`: `queued | running | completed | failed`.
- Agent secret: only SHA-256 of random 256-bit bearer credential in DB. Enrollment token: same.
- Agent ID and incident ID generated server-side with UUID.
- `incident_memory.incident_id` unique: one memory row per incident; repeat root causes merge into a shared canonical row and stay traceable via `incident_memory_sources` (see migration 015).
- All timestamps are TIMESTAMPTZ UTC; display in client locale.
- Evidence IDs are generated by DB and validated against LLM citations.
- Provider create/import serialize the 100-connection limit under advisory lock `73460713`; mutation/queue/claim use provider row locks.
- Every real configuration change, including key replacement, increments positive revision; queued jobs/tests carry their captured revision and explicit model.
- Investigation snapshots include name/protocol/base URL/model/revision, never key/ciphertext. `provider_id` is nullable with `ON DELETE SET NULL`; report snapshots survive rename/delete.
- Migration 002 backfills legacy brand names/protocols, leaves unrecorded model/base URL null and preserves terminal results/errors/timestamps. Legacy queued/running jobs become failed with a migration notice. Old binaries must be stopped before dropping the old `provider` column.
- `last_test_*` columns retain one slot per connection, including model/revision and 90-second expiry. Conditional result writes and audits cannot overwrite replaced/expired slots.
- Migration 004 adds the report status, source timestamp and socket session ID separate from the measured unit/state in `host_services`. The two rows change atomically and only on an increasing observation timestamp. Read-time freshness does not mutate rows. A new configured name or explicit opt-out removes the old live unit; `demo_fixture` rows are not read as live observations.
- Migration 005 adds `alert_thresholds` (per-host overrides, CHECK 0-100 or NULL), `alert_conditions` (state machine `ok|breaching|breached|cooldown`, `consecutive`, `cooldown_until`, nullable incident FK) and the `agents.protocol_version`/`agents.capabilities` columns recorded at enrollment/hello. Threshold changes reset that host's condition rows; threshold mutations are audited.
- Migration 006 adds `metric_samples_hourly` and a `sampled_at` index on `metric_samples` for retention scans.
- Migration 007 adds `host_workload_reports` and optional `cpu_percent`/`memory_bytes` columns on `host_services` for opt-in bounded Docker/systemd workload inventory (`source='agent_workloads'`).
- Migration 008 adds `enabled` and `check_interval_seconds` (15–86400 s, default 60) to `endpoint_monitors` and creates `endpoint_monitor_runs` with a named `probe_location` and `started_at`/`finished_at` source timestamps per probe execution. Runs cascade on monitor deletion; retention is bounded to 200 rows per monitor, pruned in the same transaction as each insert. The Worker scheduler claims at most 8 due enabled monitors per tick with `FOR UPDATE SKIP LOCKED`; run counts read via `monitor_id`-scoped LATERAL aggregates, never fleet-wide. Audit events for monitor mutations never contain the target URL.
- Migration 010 adds investigation reliability columns to `investigations`: `lease_expires_at`, `worker_id`, `attempts` (default 0), `max_attempts` (default 3), `next_retry_at` and `dedupe_key`. A partial unique index allows at most one active (`queued`/`running`) investigation per `dedupe_key`, so terminal rows can always be re-investigated; claim and lease-recovery partial indexes serve worker polling. Lease expiries are audited as `investigation.lease_expired` with only non-secret fields (incident id, worker id, attempts, outcome).
- Migration 012 extends `config_snapshots` backwards-compatibly for the drift timeline: `previous_snapshot_id` (self FK, `ON DELETE SET NULL`), `diff_status` (`hash_only`|`diff_available`|`unavailable`, default `hash_only`), `unavailable_reason`, `content_format`, `content_redacted` (always redacted; never raw file bytes), `content_truncated`, `redaction_count` (default 0, CHECK >= 0), `semantic_diff_json` (JSONB, redacted + bounded), `diff_summary` and `incident_id` (FK to `incidents`, `ON DELETE SET NULL`), plus `captured_at DESC` and `(agent_id, captured_at DESC)` indexes for timeline queries. Existing hash-only rows keep `diff_status='hash_only'` and remain valid; a `config_snapshot` frame whose checksum matches the latest telemetry-inserted row enriches that row instead of duplicating it.
- Migration 013 adds `change_events` (per-host recorded changes with `kind` CHECK, `source` default `operator`, `occurred_at`, index `(agent_id, occurred_at DESC)`) and `incident_change_links` (incident + exactly one of `change_event_id`/`config_snapshot_id`, `status` `linked|dismissed`, partial unique indexes per target). Links are operator curation only — they never record a causation claim. The migration reads only standard columns from 001 (`agents`, `incidents`, `config_snapshots`), so it applies cleanly on top of 011 and after 012.
- Migration 014 adds hybrid-retrieval embedding columns to `incident_memory`: `embedding_values DOUBLE PRECISION[]` (always persisted, so hybrid retrieval works on plain PostgreSQL 16 via an exact bounded cosine-similarity fallback), `embedding_dimensions`, `embedding_model`, `embedding_provider_id UUID REFERENCES ai_providers(id) ON DELETE SET NULL`, `embedded_at` and `embedding_consent BOOLEAN NOT NULL DEFAULT FALSE` (opt-in). When `pg_available_extensions` contains `'vector'` (e.g. `pgvector/pgvector:pg16`, but NOT plain `postgres:16-alpine`) the migration also runs `CREATE EXTENSION IF NOT EXISTS vector` and adds a nullable `embedding_vector vector` column used for native `<=>` cosine-distance queries. Partial indexes serve the pending-embedding scan (`embedding_consent AND embedded_at IS NULL`) and the embedded-rows retrieval scan (`embedding_values IS NOT NULL`).

- Migration 015 adds memory deduplication/provenance: `incident_memory.content_fingerprint` (SHA-256 over redacted, normalized summary+resolution), `canonical_memory_id` (self-FK, NULL = canonical active memory, `ON DELETE SET NULL`), `occurrence_count` (>= 1, default 1) and `last_confirmed_at` on `incident_memory`, plus the `incident_memory_sources` provenance table (`PRIMARY KEY (memory_id, incident_id)`, cascades, incident-indexed) backfilled from existing rows, and `investigations.retrieved_memories_json` (bounded `InvestigationMemoryAttribution[]` snapshot). Partial indexes cover canonical fingerprint lookups and merged-row scans. Resolve-time dedup matches an exact fingerprint or a near-duplicate (token Jaccard on the resolution >= 0.85) among recent canonical memories; merges move all source rows and recompute the target's `occurrence_count`/`last_confirmed_at` from distinct sources. Only columns from 001..011 are referenced, so 015 applies on top of 011 and after 012..014.

## Hybrid full-text + vector retrieval over canonical memories (implemented)

```sql
-- FTS leg (always runs, bounded; canonical rows only):
SELECT id, incident_id, summary, resolution, created_at, embedding_model,
       occurrence_count, last_confirmed_at, content_fingerprint,
       ts_rank_cd(to_tsvector('simple', summary || ' ' || resolution),
                  plainto_tsquery('simple', $1)) AS fts_score
FROM incident_memory
WHERE canonical_memory_id IS NULL
  AND to_tsvector('simple', summary || ' ' || resolution) @@ plainto_tsquery('simple', $1)
ORDER BY fts_score DESC, created_at DESC, id ASC LIMIT 50;

-- Vector leg when pgvector is present ($2 is the query vector literal; canonical rows only):
SELECT id, occurrence_count, last_confirmed_at,
       1 - (embedding_vector <=> $2::vector) AS vector_score
FROM incident_memory
WHERE canonical_memory_id IS NULL
  AND embedding_vector IS NOT NULL AND embedding_dimensions = $3
  AND 1 - (embedding_vector <=> $2::vector) >= 0.2
ORDER BY embedding_vector <=> $2::vector LIMIT 50;
-- Otherwise the same candidates come from `embedding_values` with exact cosine
-- similarity computed in the app (bounded candidate set, matching dimensions).
```

Both legs are fused with Reciprocal Rank Fusion (k=60) in `packages/ai/src/memory-retrieval.ts`; results are tagged `retrieval_method: "fts" | "hybrid_rrf"` with `fts_score`, `vector_score`, `hybrid_score` and `embedding_model`, plus the dedup provenance (`occurrence_count`, `last_confirmed_at`, `content_fingerprint`, `sources[]` from `incident_memory_sources`). `searchIncidentMemories` (apps/hub, reused by the Worker) implements this; `GET /api/memory` returns the backwards-compatible array with all of these per-record fields, and merged (non-canonical) rows are never returned.

Only canonical memories are retrieved or embedded: exact/near-duplicate candidates are deduplicated (fingerprint + token Jaccard >= 0.85) before the LLM call, the Worker embeds only rows with `canonical_memory_id IS NULL AND embedding_consent = TRUE AND embedded_at IS NULL`, and the bounded attribution snapshot is persisted on the investigation row.

Limitations: exact-token FTS alone misses synonyms and root-cause paraphrases (measured: FTS-only Recall@5 0.375 vs hybrid 1.0 on the repeat-incident eval corpus, see `tests/memory-retrieval.eval.test.ts`). Embeddings are opt-in per memory row (`embedding_consent`) and only ever cover redacted human-confirmed `summary + resolution`; Anthropic reasoning models do not imply an Anthropic embedding service, so Anthropic-only deployments use FTS-only retrieval.

## Retention and downsampling (implemented)

The Worker runs `runMetricRetention` on every poll, bounded to at most one 6-hour window per call:

1. Delete `metric_samples_hourly` rows older than `METRIC_ROLLUP_RETENTION_DAYS` (default 90).
2. Delete spent/expired `enrollment_tokens` older than 24 hours.
3. Roll up raw samples that left the raw window (`METRIC_RAW_RETENTION_HOURS`, default 168) into `metric_samples_hourly` (per agent and hour: count, min/max/avg per resource, last network counters) and delete the raw rows in the same transaction. Insert and delete are atomic, so a crash can never lose or double-count a window.

Historical reads: `GET /api/hosts/:id/metrics?from=&to=&resolution=hourly` serves rollups; `resolution=auto` picks hourly once the span exceeds the raw window. Still planned: daily partitioning by `sampled_at` or a time-series store if measured need arises, retention exceptions for evidence tied to unresolved investigations, and a backup/restore drill.

## Query budgets

Hub limits: 100 hosts, 100 recent incidents, 120 samples/host, 50 evidence items, 10 investigations, 20 memories. Make pagination and query-key indexes part of a future scale milestone.
