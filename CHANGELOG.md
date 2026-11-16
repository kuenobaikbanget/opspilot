# Changelog

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
