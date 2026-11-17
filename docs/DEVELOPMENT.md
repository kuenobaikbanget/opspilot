# Development Workflow

## Standards

- Package manager / runtime: **Bun** for TypeScript code; Go modules for agent.
- TypeScript: strict mode, shared contracts in `packages/contracts`; do not add global `any` for new API routes.
- Go: simple standard library collectors; no shell invocation; validate all server-provided values locally.
- Git: short commits by vertical slice; PRs with test evidence and user-facing changelog.
- Feature branches: `feat/agent-enrollment`, `feat/config-drift`, etc.

## Running services

```bash
bun install --frozen-lockfile
bun run db:init
bun run dev                 # Hub, Worker, Web
bun test                    # Bun tests
bun run typecheck           # TypeScript checks
(cd agent && go test ./...)
```

Backend can be run individually with `bun run dev:hub`, `bun run dev:worker`, `bun run dev:web`. Ensure the root `.env` is exported/loaded in each isolated process.

## Design system preview

Run `bun run dev:web`, then open `http://localhost:3000/design-system`. This public reference route requires no Hub, database, `.env`, login, or provider credentials. Its examples and interactions are explicitly synthetic and local-only.

If port 3000 is occupied: `bun run --cwd apps/web dev --port 3100`, then open `http://localhost:3100/design-system`.

- Semantic CSS tokens: `apps/web/app/tokens.css`, imported once by `globals.css`.
- Shared native React components: `apps/web/components/ui.tsx`.
- Interactive reference: `apps/web/app/design-system/`.
- Visual specification: root `DESIGN.md`; Impeccable extensions: `.impeccable/design.json`.
- Backend implementation design: `docs/DESIGN.md` (not the visual specification).

Use shared primitives instead of introducing parallel button/field styles. Connect field hints and errors with `aria-describedby`, use explicit submit button types, and retain written status/provenance labels. Unknown metrics are not zero. Check keyboard focus, reduced motion, and desktop/mobile rendering after visual changes.

For dashboard changes, follow the [Fleet & services target contract](UI-UX.md#fleet-services-dashboard-contract-target) and [staged data/security gates](ROADMAP.md#fleet-services-dashboard-delivery-planned). Root `DESIGN.md` separates implemented tokens/primitives from the target composition; do not treat the reference screenshot as proof of an API capability. Keep `.impeccable/design.json` narrative aligned when updating the shared design rules, and keep synthetic reference states separate from live data. Use the [planned acceptance scenarios](TESTING.md#fleet-services-dashboard-acceptance-planned) when implementing the target.

GitHub Actions uses Bun 1.4.2 and frozen installation, then runs existing tests, all workspace typechecks, the Web production build, and Go tests on Linux. Browser checks using synthetic API responses verify UI behavior only, not live authentication, diagnostics, or AI integrations.

The workflow is **CI-only**: pushes and pull requests run validation, with no deployment, release publishing, or production credentials. Actions are pinned to full commit SHAs; update the SHA and version comment together after reviewing upstream changes. Checkout does not persist credentials, and the workflow token has only `contents: read`.

Configure a GitHub branch rule for `main` requiring pull requests and successful `typescript` and `go` checks before merge; require checks against the latest base branch and disallow bypasses/direct pushes. Workflow YAML alone does not enforce this merge gate. A green CI run covers the commands above, not live DB/auth/WSS/provider integration or production security.

## Definition of done for code changes

- [ ] Update relevant API/DB/contracts/design docs.
- [ ] Add positive and negative tests; include invalid agent payload case.
- [ ] Verify with actual local Hub + one agent + DB.
- [ ] No secrets in test fixtures or logs.
- [ ] Describe metrics impact and backpressure.
- [ ] Preserve read-only tools policy.
- [ ] Verify browser UI in responsive widths.

## First implementation slices (good order)

1. Run DB, Hub health, login, web UI.
2. Enroll Go agent and get first metrics.
3. Confirm threshold incident generated after 2 high samples.
4. Run manual incident + diagnostic evidence.
5. Configure one model API key; investigate and validate evidence IDs.
6. Resolve incident, query memory and reuse previous resolution in subsequent investigation.
7. Change a deliberately monitored harmless file; verify baseline/change behavior.

For the host-only dashboard slice, follow [the executed smoke coverage](TESTING.md#host-only-slice-verification--2026-11-17): verify first enrollment, selected CPU history, disconnect/historical values, stale samples and reconnect gaps. Host reads poll every 10 seconds; the list is capped at 100 and history at 120, while host totals cover the full fleet. This slice adds no telemetry stream, sampling frequency or metric writes; retention/backpressure remains unchanged and unbounded storage still requires the roadmap work.

## Do not overengineer initially

No Redis, NATS, OpenTelemetry backend, Kubernetes Helm chart, advanced agent plugin system, auto-remediation or vector DB until the deterministic core passes test cases. Design for extension, build only what has measured need.

## Dependencies

Bun workspaces install TS frontend dependencies; backend uses built-in Bun HTTP/WebSocket/Postgres for small footprint. `bun.lock` and `agent/go.sum` are committed. Use `bun install --frozen-lockfile` for reproducible installation; update locks intentionally when dependencies change. `go mod tidy` updates Go dependency metadata. The agent targets Linux; use Linux, WSL2, or a Linux container for agent builds and tests rather than native Windows. Keep dependency versions up to date and pin for production.
