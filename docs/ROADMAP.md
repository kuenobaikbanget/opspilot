# Roadmap & Implementation Plan

No promise of elapsed time is made here; phases are sequenced by dependencies. The delivered ZIP contains baseline scaffolding for the selected MVP envelope.

## Phase 0 — Bootstrap and validate stack

- [x] Bun workspace and TS/Go folder structure
- [x] Web/Hub/Worker/Agent source entrypoints
- [x] PostgreSQL initial migration
- [x] Docker Compose and systemd templates
- [x] Run `bun install`, generate/commit bun.lock
- [x] Run `go mod tidy`, commit go.sum
- [ ] Verify local services and Linux AMD64/ARM64 binary builds
- [x] Verify Next.js production build on developer machine
- [ ] Verify Docker builds on developer machine
- [x] Extract shared UI tokens/components and verify desktop/mobile design-system catalog

**Exit gate:** `healthz`, login and first enrolled host all work.

## Phase 1 — Monitoring foundation

- [x] Basic Linux metrics from `/proc`, disk via `statfs`
- [x] Host list, gauges and last-seen state
- [x] 2-sample CPU/RAM/disk alert and cooldown
- [ ] Improve metric validation & real-time plots
- [ ] Persist thresholds and condition state across restarts
- [ ] Retention and downsampling
- [ ] Durable agent-side metric queue
- [ ] Agent version/capability negotiation

**Exit gate:** stable 24h test with a few hosts, bounded DB growth and reconnect handling.

## Phase 2 — Evidence-first AI diagnosis

- [x] Manual incident + enumerated diagnostics
- [x] Async PostgreSQL queue + worker
- [x] OpenAI/Anthropic/Gemini BYOK adapters
- [x] Server-side JSON schema checks + evidence IDs
- [ ] Deterministic evidence-relevance scoring / citations UI
- [ ] Worker lease recovery, retry budget, deduplication
- [ ] Prompt-injection test fixtures and provider-cost tracking
- [ ] 10–20 reproducible incident fixtures

**Exit gate:** measured useful diagnosis rate and 0 hallucinated evidence IDs in fixtures.

## Phase 3 — Drift and incident memory

- [x] SHA-256 config baseline / changed-hash detection
- [x] Human resolution stored as FTS memory
- [ ] Drift timeline and semantic diffs with controlled file reading & redaction
- [ ] Link deployments/config changes to incident timeline without claiming causation
- [ ] Hybrid retrieval with pgvector if recall benchmark supports it
- [ ] De-dup memory and attribution/UI provenance

**Exit gate:** repeat-incident memory useful on a measured evaluation set; drift changes observable and explainable.

## Phase 4 — Hardened self-hosted release

- [ ] Rate limiting/CSRF, session lifecycle, agent revoke/rotate
- [ ] TLS reverse-proxy reference deployment / WSS test
- [ ] Privacy consent & tested log redaction pipeline
- [ ] Metrics retention, backup & restore validation
- [ ] Tagged versioned DB migrations
- [ ] Signed binary releases amd64/arm64 + SBOM, pinned images
- [ ] Load/chaos tests and public security documentation

**Exit gate:** production checklist green and external review.

## Phase 5 — Optional expansion

Cross-server RCA, alert notifications, OTel/Prometheus integrations, read-only plugins with capability policy, local LLM via Ollama, team RBAC, pluggable time-series backend. Avoid automatic remediation until least-privilege controls and approvals have been evaluated separately.
