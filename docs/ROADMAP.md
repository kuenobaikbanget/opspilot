# Roadmap & Implementation Plan

## Phase 0 — Bootstrap and validate stack

- [x] Bun workspace and TS/Go folder structure
- [x] Web/Hub/Worker/Agent source entrypoints
- [x] PostgreSQL initial migration
- [x] Docker Compose and systemd templates
- [x] Run `bun install`, generate/commit bun.lock
- [x] Run `go mod tidy`, commit go.sum
- [x] Verify local services and Linux AMD64/ARM64 binary builds
- [x] Verify Next.js production build on developer machine
- [x] Verify Docker builds on developer machine
- [x] Extract shared UI tokens/components and verify desktop/mobile design-system catalog

- [x] **Exit gate:** `healthz`, login and first enrolled host all work.

## Phase 1 — Monitoring foundation

- [x] Basic Linux metrics from `/proc`, disk via `statfs`
- [x] Host list, gauges and last-seen state
- [x] 2-sample CPU/RAM/disk alert and cooldown
- [ ] Improve metric validation & real-time plots
- [ ] Persist thresholds and condition state across restarts
- [ ] Retention and downsampling
- [ ] Durable agent-side metric queue
- [ ] Agent version/capability negotiation

<a id="fleet-services-dashboard-delivery-planned"></a>

### Fleet & services dashboard delivery (planned)

The [Monochrome workspace](UI-UX.md#fleet-services-dashboard-contract-target) implements the threshold-first Overview, host inventory, incident inspector and agent setup against existing data. Selected-host systemd status now reports one explicitly configured unit, observation time and collection availability. Broader workload and endpoint capabilities still depend on the gates below:

- [ ] Define typed host/workload/endpoint read models, source timestamps, capability/unavailable reasons, stale policy and correctly scoped aggregate counts. Keep collection within the existing Hub/Worker/Go-agent module boundaries.
- [ ] Implement opt-in, locally validated, bounded read-only Docker/systemd inventory and resource collection. Update `packages/contracts`, Go agent, API documentation and interoperability/negative tests together for any wire change; do not infer continuous inventory from `docker_status`.
- [ ] Implement persisted HTTP monitor configuration/results and bounded scheduling in the existing Hub/Worker boundary, with an actual named probe location. Complete SSRF, DNS/redirect, egress, authorization and audit controls before enabling checks; no generic URL-fetch diagnostic or new microservice by default.
- [x] Add network counter-delta estimates from adjacent Hub receipt samples, with gaps, resets, ambiguous zero reads and stale samples marked unavailable or historical. Per-host sampling cadence and per-interface rates remain unavailable.
- [ ] Connect Services, Add service and endpoint investigation to supported workload/endpoint APIs. The current screens explicitly report unavailable capabilities.
- [ ] Verify independent process/endpoint states, offline-agent/reachable-endpoint behavior, truthful freshness and no causality claims; verify actual browser layout and keyboard access at 1440px, 1024px and 390px using the [acceptance scenarios](TESTING.md#fleet-services-dashboard-acceptance-planned).

**Dashboard exit gate:** The fleet table and inspector, workload inventory, independent HTTP checks, and timestamped trends work against real authorized data. Negative security/interoperability tests pass, and desktop/mobile browser evidence exists. The current `/design-system` preview is not evidence that inventory or endpoint monitoring works.

**Exit gate:** stable 24h test with a few hosts, bounded DB growth and reconnect handling.

## Phase 2 — Evidence-first AI diagnosis

- [x] Manual incident + enumerated diagnostics
- [x] Async PostgreSQL queue + worker
- [x] OpenAI/Anthropic/Gemini BYOK adapters
- [x] Server-side JSON schema checks + evidence IDs
- [x] Encrypted stored provider connections, manual protocol/model routing, revision snapshots and bounded asynchronous connection tests
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
- [x] Checksummed transactional numbered DB migrations and explicit legacy-provider import
- [ ] Signed binary releases amd64/arm64 + SBOM, pinned images
- [ ] Load/chaos tests and public security documentation

**Exit gate:** production checklist green and external review.

## Phase 5 — Optional expansion

Cross-server RCA, alert notifications, OTel/Prometheus integrations, read-only plugins with capability policy, local LLM via Ollama, team RBAC, pluggable time-series backend. Avoid automatic remediation until least-privilege controls and approvals have been evaluated separately.
