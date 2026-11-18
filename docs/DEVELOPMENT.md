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

Run `bun run dev:web`, then open `http://localhost:3100/design-system`. This public reference route requires no Hub, database, `.env`, login, or provider credentials. Its examples and interactions are explicitly synthetic and local-only.

If port 3100 is occupied: `bun run --cwd apps/web dev --port 3200`, then open `http://localhost:3200/design-system`.

- Semantic CSS tokens: `apps/web/app/tokens.css`, imported once by `globals.css`.
- Shared native React components: `apps/web/components/ui.tsx`.
- Interactive reference: `apps/web/app/design-system/`.
- Visual specification: root `DESIGN.md`; Impeccable extensions: `.impeccable/design.json`.
- Backend implementation design: `docs/BACKEND-DESIGN.md` (not the visual specification).

Use shared primitives instead of introducing parallel button/field styles. Connect field hints and errors with `aria-describedby`, use explicit submit button types, and retain written status/provenance labels. Unknown metrics are not zero. Check keyboard focus, reduced motion, and desktop/mobile rendering after visual changes.

For dashboard changes, follow the [Fleet & services target contract](UI-UX.md#fleet-services-dashboard-contract-target) and [staged data/security gates](ROADMAP.md#fleet-services-dashboard-delivery-planned). Root `DESIGN.md` separates implemented tokens/primitives from the target composition; do not treat the reference screenshot as proof of an API capability. Keep `.impeccable/design.json` narrative aligned when updating the shared design rules, and keep synthetic reference states separate from live data. Use the [planned acceptance scenarios](TESTING.md#fleet-services-dashboard-acceptance-planned) when implementing the target.

## GitHub Actions, releases and packages

| Workflow | Trigger | Responsibility |
| --- | --- | --- |
| `CI — Tests & builds` (`checks.yml`) | Branch pushes, pull requests, manual runs and reusable calls | Bun tests, workspace typechecks, Web production build and Linux Go tests |
| `Release — Versioned binaries & images` (`release.yml`) | Push of a `v*` tag | Validate version/main ancestry, run CI, build agent archives, publish images, then create the GitHub Release |
| `Packages — Publish multi-platform GHCR images` (`packages.yml`) | Reusable call from Release only | Publish Hub, Worker, Web and Agent images for Linux AMD64/ARM64 |

CI uses Bun 1.4.2 with a frozen lockfile. All actions are pinned to full commit SHAs; update the SHA and version comment together after reviewing upstream changes. Checkout never persists credentials. PR validation has only `contents: read`; it cannot publish or deploy. Browser checks using synthetic API responses verify UI behavior only, not live authentication, diagnostics or AI integrations.

Configure a GitHub branch rule for `main` requiring pull requests and the **`TypeScript — Tests, types & Web build`** and **`Go agent — Tests`** checks from CI. These replace the old displayed check names `typescript` and `go`; update existing required-check selections when adopting the workflow. Require checks against the latest base branch and disallow bypasses/direct pushes. Workflow YAML alone does not enforce this gate.

### Publish a version

Merge the workflow changes and intended release code into `main` first. Choose an unused SemVer tag; development builds should use a prerelease such as `v0.1.0-rc.1`, not imply production readiness:

```bash
git switch main
git pull --ff-only
git tag -a v0.1.0-rc.1 -m "OpsPilot v0.1.0-rc.1"
git push origin v0.1.0-rc.1
```

Tags must be `vMAJOR.MINOR.PATCH`, optionally with a SemVer prerelease suffix; numeric identifiers cannot have leading zeroes. Build metadata (`+build`) is unsupported, and the version without `v` must fit Docker's 128-character tag limit. The tag commit must be contained in `origin/main`. A tag does not bypass CI. Never move a published tag; use a new version for changed source.

Release assets are `opspilot-agent_<version>_linux_amd64.tar.gz`, the matching `arm64` archive, and `SHA256SUMS`. Each archive contains the executable `opspilot-agent`, `opspilot-agent.service` and `agent.env.example`. Assets are unsigned. GitHub generates release notes; prerelease tags create prereleases without changing GitHub's latest release. Stable tags become latest.

GHCR publishes `ghcr.io/kuenobaikbanget/opspilot-{hub,worker,web,agent}` (forks use their own lowercase owner/repository). `v1.2.3` publishes `1.2.3`, `1.2`, `1` and `latest`; `v0.2.3` omits the `0` alias. Prereleases publish only their full version, never stable aliases. The version comes from the tag, not the private workspace package versions. No npm packages are published.

Only image-publishing jobs get `packages: write`; only the final GitHub Release job gets `contents: write`. Both use the built-in `GITHUB_TOKEN`, not a PAT or production credentials. GitHub Release creation waits for both archives and all images, but publishing is not transactional: failed runs can leave images/aliases already pushed. Inspect a failure before rerunning; already-published releases must not be overwritten.

After first publication, check each package's **Package settings → Manage Actions access** and visibility. GHCR packages default to private, even for public repositories; make them public only deliberately and after selecting a distribution license. Private pulls require package access. See [deployment instructions](DEPLOYMENT.md#published-release-assets-and-container-images) and the [publishing trust boundary](SECURITY.md#release-and-package-publishing).

Nothing deploys automatically. A green release is build/publication evidence, not proof of live DB/auth/WSS/provider integration or production security.

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

## Local dashboard demo data

After initializing the local database, run `bun run db:seed:demo` from the repository root with the same `DATABASE_URL` used by the Hub (Bun loads the root `.env`).

The seed adds six `Demo data` hosts, 365 historical metric samples with a collection gap, five incidents (three open, two resolved), synthetic evidence, completed/failed authored investigation examples and two searchable resolution memories. One host has no measurements. All hosts remain offline because connectivity comes from actual agent sockets, not database status.

The script refuses `NODE_ENV=production` and non-loopback database connections. It inserts atomically under reserved fixture identities, never deletes or overwrites existing records, and a complete existing host set makes reruns a no-op. Partial/colliding fixture identities fail rather than repairing user data. Samples intentionally remain historical; rerunning does not make them live or refresh timestamps.

No agent, diagnostic, HTTP probe or model request is started. Investigation examples have terminal states so the Worker does not execute them. Workload inventory and endpoint checks remain unavailable; this seed does not implement their APIs. Refresh the dashboard and use Incidents, Configuration drift and Incident memory to inspect the persisted examples.

Run the isolated safety negatives with `bun test tests/seed-demo.test.ts`; these reject production and non-loopback targets before connecting to any database.

## Do not overengineer initially

No Redis, NATS, OpenTelemetry backend, Kubernetes Helm chart, advanced agent plugin system, auto-remediation or vector DB until the deterministic core passes test cases. Design for extension, build only what has measured need.

## Dependencies

Bun workspaces install TS frontend dependencies; backend uses built-in Bun HTTP/WebSocket/Postgres for small footprint. `bun.lock` and `agent/go.sum` are committed. Use `bun install --frozen-lockfile` for reproducible installation; update locks intentionally when dependencies change. `go mod tidy` updates Go dependency metadata. The agent targets Linux; use Linux, WSL2, or a Linux container for agent builds and tests rather than native Windows. Keep dependency versions up to date and pin for production.

## Technology References

Primary documentation considered when choosing this starter stack (reviewed as design references, not end-to-end benchmark results):

- Bun workspaces: https://bun.com/docs/pm/workspaces
- Bun workspace scripts / filters: https://bun.com/docs/pm/filter
- Bun HTTP/WebSocket: https://bun.com/docs/runtime/http/websockets
- Bun native SQL: https://bun.com/docs/runtime/sql
- Next.js installation and App Router: https://nextjs.org/docs/app/getting-started/installation
- PostgreSQL indexes: https://www.postgresql.org/docs/current/indexes.html
- Go exec.CommandContext: https://pkg.go.dev/os/exec#CommandContext
- Gorilla WebSocket: https://github.com/gorilla/websocket
- OpenAI API documentation: https://platform.openai.com/docs
- Anthropic Messages API: https://docs.anthropic.com/en/api/messages
- Gemini API: https://ai.google.dev/gemini-api/docs

Versions and model availability change. Verify against upstream documentation when implementing each integration.
