# Changelog

## Unreleased — 2026-11-17

- Added a desktop sidebar toggle: 232px expanded / 72px icon-only, mint OP abbreviation, accessible navigation names, native hover titles and a browser-persisted preference. Mobile keeps labeled navigation regardless of the desktop preference.
- Replaced dashboard navigation with the Precision Rail: sticky 208px sidebar, outline icons, translating mint active marker, separated utility/account area and keyboard-operable mobile Utilities disclosure. Existing destinations and sign-out behavior are retained; shared reduced-motion rules apply.
- Delivered the live host-only Fleet slice: typed host read models and full-fleet host totals, searchable/selectable table, contextual inspector, raw timestamped CPU history with gap breaks, historical/offline/stale states and explicit unavailable workload/endpoint capabilities.
- Completed admin enrollment instructions, token copy/hide/expiry handling and stale-cache/removal feedback without changing the Go agent protocol or enabling diagnostics/probes from inspection.
- Verified with isolated PostgreSQL + Hub + real Linux amd64 Go agent and browser at 1440/1024/390px, including enrollment, metric persistence, disconnect/reconnect, auth negatives and capped-list totals. Hub/Web typechecks passed; see `docs/TESTING.md` for evidence and limits.
- Hardened the CI-only GitHub Actions workflow with full action commit SHA pins and disabled persisted checkout credentials; no CD or deployment added.
- Documented the CI trust boundary and required branch-rule setup for enforcing TypeScript/Go checks before merge.
- Captured the supplied Fleet & services dashboard reference and aligned the design/UX contract, PRD, roadmap, technical/API boundaries, security requirements and acceptance plan. Host connectivity, workload process state and endpoint reachability remain independent; runtime UI, protocol and monitoring capabilities are unchanged.

## Unreleased — 2026-11-16

- Initialized the private GitHub repository and repeatable CI for Bun tests, workspace typechecks, Web production builds, and Linux Go tests.
- Added committed Bun and Go dependency locks.
- Extracted navy/mint semantic design tokens and native React controls; migrated the existing dashboard to the shared primitives.
- Added a backend-independent `/design-system` catalog with synthetic examples and working validation, loading, meter, empty, and evidence-disclosure states.
- Added visible keyboard focus, reduced-motion support, explicit field labels, and unknown-metric semantics distinct from zero.
- Documented the implemented visual system and kept measured evidence, AI hypotheses, and human-confirmed resolutions distinct.

## 0.1.0 — initial scaffold (2026-11-15)

- Bun workspace structure; Next dashboard; Bun-native Hub, Worker; Linux Go Agent.
- Initial PostgreSQL schema and Docker Compose / systemd templates.
- Single-admin session, agent enrollment, telemetry, thresholds, drift hash detection.
- Incident records, read-only diagnostics, 3 AI-provider adapters and memory FTS.
- PRD, architecture, design, API, security, AI workflow, roadmap and test plan.

**Status:** generated scaffold, pending dependency installation and runtime validation on development host.
