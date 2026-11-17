# Product Requirements Document — OpsPilot

**Version:** 0.1 (starter specification)  
**Status:** Draft for development  
**Product type:** Self-hosted monitoring + AI-assisted incident investigation  
**Owner:** Independent developer  
**Target deployment:** Linux VPS and homelab; single administrator, 1–20 hosts initially.

## 1. Problem

Small infrastructure operators often have data from CPU/RAM/disk dashboards but must pivot manually through `journalctl`, Docker, Nginx, service state, and config files to explain *why* a failure happened. Enterprise AIOps can be expensive, operationally heavy, or opaque. OpsPilot aims to bridge the gap while keeping credentials and infrastructure control with the operator.

## 2. Product hypothesis

A self-hosted Hub + lightweight Go agent, combined with bounded read-only evidence collection and explainable LLM analysis, can reduce time-to-first-useful-hypothesis without introducing automatic high-risk remediation.

**Distinctive hypotheses requiring validation** (not proven novelty): sub-10-minute onboarding for small VPS, configuration drift context attached to an incident, evidence-referenced diagnoses, no broad agent shell permissions.

## 3. Personas

- **Solo VPS operator:** hosts websites and Docker services; needs fast causes for HTTP 502, disk exhaustion, and stopped services.
- **Homelab operator:** manages mixed x86/ARM Linux, prefers binary/containers and self-hosting.
- **Small IT team (later):** wants shared incident notes and notification routing; out of scope for single-admin MVP.

## 4. Jobs-to-be-done

- When a server is unhealthy, see which host and resource are affected without SSH.
- When an incident occurs, collect a small set of **allowed** checks and receive a cautious hypothesis with stored evidence.
- When config changes, see that a drift occurred and when, without automatically uploading sensitive content.
- When a similar issue recurs, find the earlier confirmed resolution.
- Deploy an agent as a Linux binary or container without needing Kubernetes.

## 5. MVP scope (the user's chosen feature envelope)

| ID | Requirement | Priority | Definition of acceptance |
|---|---|---|---|
| FR-01 | Single-admin password login | P0 | Protected dashboard and incident routes; signed expiring HttpOnly session |
| FR-02 | One-time agent enrollment | P0 | 10-minute TTL, one use; agent receives independent credential |
| FR-03 | Go agent: binary + Docker | P0 | Same codebase builds AMD64/ARM64; connects outbound over WSS |
| FR-04 | Telemetry and trends | P0 | CPU, memory, disk, rx/tx, uptime visible for each host |
| FR-05 | Threshold alert incidents | P0 | CPU/memory/disk rule after consecutive elevated samples, cooldown |
| FR-06 | Host configuration drift | P0 | Hash baseline, changed hash emits drift incident, not file contents |
| FR-07 | Safe diagnostic executor | P1 | Only enumerated tools, enforce allowlist in agent, timeout + output cap |
| FR-08 | Manual + automatic incidents | P1 | Stored incident/evidence lifecycle: open -> resolved |
| FR-09 | Multi-provider BYOK | P1 | Select among OpenAI / Gemini / Anthropic keys configured in Hub/Worker environment |
| FR-10 | Evidence-grounded LLM report | P1 | JSON schema enforced; reported evidence references exist in DB |
| FR-11 | Incident memory | P1 | Confirmed resolution stored; relevant prior resolutions retrieved by full-text search |
| FR-12 | Security + audit | P1 | Audit login, enrollment, incident creation/resolution and investigation queue |

**Delivered as starter:** basic implementation of FR-01 to FR-12. This does not imply production-grade completion; see README limitations. Enhanced config diff and vector similarity are explicitly **post-starter** milestones, rather than dishonestly presented as complete.

### Dashboard direction — planned extension, not delivered starter scope

The supplied **Fleet & services** reference defines the dashboard direction; [UI/UX](UI-UX.md#fleet-services-dashboard-contract-target) owns the screen contract. The host-only table, selection/inspector and raw CPU-history slice is implemented. Preserve the starter requirements above while adding the remaining capabilities below; the host slice alone does not complete FR-13–FR-16.

| ID | Planned requirement | Definition of acceptance |
|---|---|---|
| FR-13 | Table-led fleet and contextual inspection | Host table, selected-host services and a shared inspector follow the reference; independent host/endpoint summary counts, keyboard selection, freshness and responsive states are explicit. |
| FR-14 | Read-only workload inventory | Supported, explicitly enabled Docker/systemd inventory exposes process state, source/time and available per-workload resources; denied/unsupported collection is not an empty healthy list. Docker socket access remains disabled by default. |
| FR-15 | Independent HTTP endpoint monitoring | Persist a validated target, host/service association, expected response, supported probe identity, interval/timeout and timestamped results. A running process can have a down endpoint; an offline agent can have an up endpoint. SSRF/egress controls and negative tests are mandatory before enabling checks. |
| FR-16 | Honest trends and status provenance | Real time axes, gaps, actual alert policy, source timestamps and correctly derived network rates; distinguish unknown, stale and not configured. Correlation never becomes an inferred root cause. |

Implementation requires the [roadmap gates](ROADMAP.md#fleet-services-dashboard-delivery-planned), typed data/API contracts and security validation. A visual mockup or synthetic catalog example alone does not satisfy FR-13–FR-16.

## 6. Non-goals for the MVP

- Auto-restart of services, automatic shell remediation, privilege escalation.
- General arbitrary command execution, SSH gateway, server root credential storage.
- Distributed tracing, Kubernetes-native operators, metric-label cardinality at scale.
- Team RBAC, SSO, payments, hosted SaaS, agent marketplace.
- Full centralized log warehouse or long-term Prometheus-compatible TSDB.
- Secrets / private key harvesting, unrestricted log ingestion.

## 7. Functional flows

### Onboarding
Admin sets up hub → login → creates one-time token → installs binary/Docker agent → agent enrolls over HTTPS → saves agent identity → opens outbound WSS → sends telemetry → host appears online.

### Automatic alert
Agent telemetry → threshold evaluator → 2 consecutive high samples → recent-incident dedup → `incident.open` → dashboard. LLM **not** invoked merely because a metric exists.

### Fleet and service inspection (planned)
Admin opens Fleet & services → selects host → inspects read-only workload inventory → selects service → compares process state with independently timestamped endpoint checks and host trends. The inspector defaults to `No root cause inferred`. Opening details does not call an LLM; an explicit investigation remains a separate flow.

### Drift
Agent computes SHA-256 for explicit regular files ≤1 MiB → hub stores baseline → different hash creates snapshot + incident → operator may ask for bounded diagnostics → evidence-based summary. SHA delta alone cannot prove causality.

### Investigation
Admin selects incident & provider → hub requests allowlisted checks from online agent → responses stored/redacted → investigation queued → worker fetches relevant evidence & past resolutions → calls provider → validates output → dashboard displays hypothesis and confidence.

### Memory
Human validates/fixes issue → enters resolution → incident resolved → searchable memory created → next investigation can retrieve similar confirmed resolution. Historical resolution is context, not a command to run.

## 8. Quality / nonfunctional targets (MVP validation goals)

- Setup: a technical operator should get Hub + first agent working in under 10 minutes **after dependencies are installed** (hypothesis to benchmark).
- Resource footprint: record CPU/RAM of Go agent; target low idle usage and document measured hardware; do not claim a benchmark not run.
- Availability: monitor connection/heartbeat staleness; reconnect after transient failure; metrics samples may be lost during disconnect in starter.
- Data minimization: only basic telemetry and selected diagnostic outputs, capped to 6KB per evidence.
- LLM correctness: evidence ID precision target 100%; root-cause accuracy to be measured on labeled incident fixtures.
- Cost: opt-in investigation and per-request timeout; hard monthly budget limits planned before public exposure.
- Privacy: no external AI call without configured key and explicit investigate action in starter.

## 9. Success metrics

Primary: **useful diagnosis rate** (% of test incidents where user verifies a useful cause + next check). Secondary: time-to-first-hypothesis, mean tokens per investigation, false confidence rate, evidence citation validity, onboarding completion rate, agent overhead, unsuccessful/unsafe tool requests.

## 10. Release gates

- Complete security checklist and negative authorization tests.
- Pin/lock dependencies; validate AM64 + ARM64 agent builds.
- Execute 10+ incident fixtures, label observed root cause and required evidence.
- Implement retention + memory cleanup, CSRF protection, login rate limiting, credential rotation, agent revocation, TLS via trusted reverse proxy before public-network deployment.
- No actionable secret material must enter provider requests during redaction tests.
