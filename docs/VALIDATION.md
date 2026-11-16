# Artifact Validation Report

**Original archive validation:** 2026-11-15. The first report below is historical; subsequent development-host verification is recorded separately.

## Checks completed here

- ✅ Generated folder/file content inspected for presence and consistency.
- ✅ JSON package configuration and incident fixtures are parseable.
- ✅ TypeScript/TSX syntax parsed by TypeScript transpiler, excluding generated type declaration.
- ✅ Go sources formatted with `gofmt` (Go parser accepts syntax).
- ✅ Compose YAML parses successfully.
- ✅ ZIP archive listing and integrity checked.

## Not executed (tooling / network unavailable)

- ❌ `bun install`, `bun test`, `bun run typecheck`, Next.js build.
- ❌ PostgreSQL init + Docker Compose startup; live agent enrollment and WSS traffic.
- ❌ Go module download / `go test` (requires uncached gorilla/websocket module and package registry access).
- ❌ Live OpenAI/Gemini/Anthropic API calls.

## First-machine acceptance steps

1. Install dependencies and commit generated `bun.lock` and `agent/go.sum`.
2. Execute all scripts in `docs/TESTING.md`.
3. Validate local login, token enrollment, 15-second metrics, manual incident, evidence collection, LLM report, resolve & memory.
4. Test binary and container agent independently on Linux AMD64 and ARM64.
5. Investigate any runtime incompatibilities and update docs before tagging a release.

## Development-host verification — 2026-11-16

- Installed workspace dependencies with Bun 1.4.2 and generated `bun.lock`.
- Downloaded the Go WebSocket dependency using `go mod tidy` and generated `agent/go.sum`.
- `bun test`: 3 passed, 0 failed.
- `bun run typecheck`: Hub, Worker, and Web all passed.
- `bun run --cwd apps/web build`: Next.js 16.4.6 production build passed; `/` and `/design-system` prerendered.
- Impeccable mechanical detector over the changed Web sources returned no findings.
- Ran the actual Next.js development server and exercised `/design-system` in Chromium at 1440px and 390px: form errors and focus recovery, valid local preview, loading/finish/reset, slider keyboard bounds, unknown metrics, and evidence disclosure.
- Observed no catalog API requests or horizontal overflow at those widths. Verified visible keyboard focus and reduced-motion handling; sampled default text contrast ratios were at least 8.22:1.
- Exercised migrated login/dashboard UI using temporary synthetic browser API responses, including failed login, queued-investigation display, resolution, and memory search. These checks are UI-only, not live integration evidence.

Still unverified locally: PostgreSQL initialization, live Hub/authentication, Linux agent enrollment and WSS, Docker image builds, Linux AMD64/ARM64 binaries, and external AI providers. The original archive syntax checks do not replace these acceptance steps.

## GitHub CI verification — 2026-11-16

The [Checks run for commit `5d6b178`](https://github.com/kuenobaikbanget/opspilot/actions/runs/43803885453) completed successfully on Ubuntu runners:

- Frozen Bun installation, Bun tests, all workspace typechecks, and the Web production build passed.
- `go test -mod=readonly ./...` passed in the Linux Go job.

Linux Go unit-test success is not live agent enrollment, WSS interoperability, or an AMD64/ARM64 release-binary validation.
