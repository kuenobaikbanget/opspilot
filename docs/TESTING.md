# Test & Validation Plan

## Current repo tests

```bash
bun test
bun run typecheck
(cd agent && go test ./...)
```

`tests/contracts.test.ts` tests tool enum, metric bounds, and redaction smoke tests. `agent/internal/agent/agent_test.go` checks basic parsing/redaction/WS URL. These tests are **not** a substitute for integration, security, and AI evaluation.

## GitHub publication verification — 2026-11-18

- `actionlint` 1.7.12 passed for CI, Release and reusable Packages workflows.
- Executed the actual version-validation shell steps: both accepted seven valid stable/prerelease versions and rejected thirteen malformed versions. Package publication also rejected PR context, branch refs, mismatched version tags and an oversized Docker tag.
- Executed the release ancestry guard in an isolated Git repository: a commit on `origin/main` passed; an unmerged tag failed.
- Built all four Dockerfiles successfully for Linux AMD64 using Buildx with frozen Bun dependencies and verified Go modules.
- Started the built Web image and fetched its public `/design-system` route: HTTP 200 with OpsPilot content. This is a packaged-server smoke, not a browser/layout or live-backend test.
- Ran the release archive build step for AMD64 and ARM64 using Go 1.24.2 in Docker. Both archives contained an executable ELF for the intended architecture and the two installation templates; SHA-256 checksums matched. CI selects Go from `agent/go.mod`; this local archive smoke did not execute the ARM64 binary.

No tag was pushed and no GitHub Release or GHCR package was published. The remote Actions/token/registry integration, ARM64 container execution, full Compose deployment and production security remain unverified.

## Host-only slice verification — 2026-11-17

Executed against a separate PostgreSQL 16 database, real Bun Hub, Next.js browser surface and native Linux amd64 Go agent (built with Go 1.24.2 in Docker). No synthetic telemetry was used for the live host/history/disconnect checks.

- Hub and Web workspace typechecks passed after installing the updated workspace dependency.
- Live API smoke passed: DB health, correct/incorrect login, unauthorized list/history/token requests, forbidden mutation origin, invalid/missing metric host IDs, empty fleet, missing measurements and 101 enrolled fixture hosts with a 100-row cap and truthful full-fleet totals.
- Browser login → token generation/copy/hide → actual agent enrollment → persisted metrics → selected-host history passed. Reusing the consumed token returned 401; agent identity file mode was 0600.
- Real disconnect preserved nonzero historical values with `offline`; elapsed samples became stale after 60 seconds. Restart reused the saved identity without another enrollment, and the real >60-second gap rendered as two separate chart segments.
- Search/no matches/clear, selection through refresh, an unmeasured host without leaked history, and selected-host removal with cleared details passed. The unmeasured/removal case used a separate DB fixture, not fabricated measured telemetry.
- A simulated 503 on the host read request retained the real cached host with explicit stale/error context. This verifies UI failure handling, not an actual DB outage.
- Visual checks at 1440px, 1024px and 390px showed side-by-side/stacked layouts and a contained horizontal table scroll region; the 390px document remained 390px wide. Keyboard selection retained visible focus. Sign-out removed the enrollment secret and protected view; local/session storage remained empty.

These checks do not establish production TLS/WSS, ARM64 builds, full Docker images, 24-hour stability, retention bounds, LLM investigations, workload inventory or HTTP monitoring. The original generated-archive limitations below are historical, not the scope of this executed host smoke.

## Dashboard contract alignment verification — 2026-11-17

Executed Web workspace typecheck (`bun run --cwd apps/web typecheck`) and the actual Next.js dashboard in Chromium with synthetic API responses. This pass did not rerun the live PostgreSQL/Hub/Go-agent integration above.

- Captured 1440px, 1024px and 390px surfaces: 208px desktop rail, side-by-side desktop workspace, stacked tablet/mobile inspector, and no document-level horizontal overflow. Mobile tables scroll inside 358px regions; unavailable-inventory prose wraps outside them.
- Search/no matches/clear preserved full-fleet totals (80/106 from the aggregate response, independent of six loaded records). Keyboard host selection exposed a 2px solid focus outline; refresh preserved selection.
- Offline samples remained historical. Simulated host-read 503 retained cached observations and selection with explicit stale context; removing the selected host cleared its inspector. Missing measurements rendered unavailable, empty history produced no fabricated chart, and an empty fleet offered enrollment.
- Incidents displayed the returned records; Configuration drift filtered `config_drift`; incident detail retained evidence/AI provenance. Incident memory search and read-only configured/unconfigured provider states worked.
- Header enrollment revealed/focused its section. Simulated token failure displayed an error without a secret; synthetic token generation/hide worked, and closing returned focus to the header trigger. Keyboard sign-out removed the protected surface; local/session storage remained empty.
- Unsupported endpoint creation and service inspection remained disabled with explanations. No service inventory, HTTP probe, AI integration or live auth enforcement is established by these synthetic UI checks.

The one mechanical design scan reported only the existing shared meter-width transition and documented 16px root-font advisory; neither was introduced by this dashboard alignment.

## Persisted demo seed verification — 2026-11-17

- Seeded the running local PostgreSQL database with six demo hosts, 365 historical samples, five incidents, five evidence records, two terminal investigation examples and two resolution memories. Rerunning the seed left the dataset unchanged. No queued/running investigation fixtures were present.
- `bun test tests/seed-demo.test.ts`: two negative tests passed, rejecting production and non-loopback database targets before a connection.
- Verified the actual Next.js → Hub → PostgreSQL dashboard without mocked API responses: six offline hosts, two CPU-chart segments around the seeded gap, five incidents, completed/failed authored report examples, one configuration-drift result and two incident-memory records. Searching `upstream` returned its persisted resolution.
- Verified structured JSON persistence as a PostgreSQL JSONB object and rendered confidence/evidence after correcting the seed's initial double-encoded report. Only this run's demo report/audit data was corrected.

Browser verification used a locally signed admin session, not a password-login test. All observations/reports/resolutions here are explicitly synthetic fixtures; this does not establish live collection, real AI output, endpoint reachability or agent connectivity.

## Manual smoke test

| # | Test | Expected result |
|---|---|---|
| 1 | Open `/healthz` with live DB | `ok:true` |
| 2 | Wrong login | 401, no admin cookie |
| 3 | Correct login | HttpOnly cookie; dashboard appears |
| 4 | Create enrollment token | 10m TTL; used token cannot enroll again |
| 5 | Agent enrolls | Identity saved 0600 and host appears online |
| 6 | Agent sends multiple metrics | Host bars change, DB samples inserted |
| 7 | Manual incident and investigate | Evidence persists, worker queues/completes or fails transparently |
| 8 | Resolve incident | Incident memory record appears |
| 9 | Change allowlisted test config | Hash change creates drift incident; initial snapshot does not |
| 10 | Offline agent | No live diagnostic execution; does not fabricate evidence |
| 11 | No provider key | Investigation button disabled; server rejects provider attempt |
| 12 | Forbidden service diagnostic | Agent rejects service not in local allowlist |

## Security negative tests to add

- Incorrect agent credential and spoofed `agentId` rejected before WSS upgrade.
- Unknown diagnostic request type rejected; no `/bin/sh` spawned.
- Oversized inbound WebSocket message disconnected.
- Race two enrollment requests with same token: exactly one succeeds.
- Agent `configHashes` with relative path, invalid SHA, >20 entries ignored.
- Path symlinks cannot be hashed; files >1MiB ignored.
- Prompt injection in `journalctl` output cannot invoke tools or leak hidden key.
- Password brute force mitigated before release (currently NOT implemented).
- All external ports except proxy unexposed in production.

<a id="fleet-services-dashboard-acceptance-planned"></a>

## Fleet & services dashboard acceptance (planned)

These scenarios gate the [target screen](UI-UX.md#fleet-services-dashboard-contract-target) and FR-13–FR-16; they are not executed-test claims. Use deterministic synthetic records for isolated UI state coverage, then real authorized inventory and an allowlisted HTTP fixture for end-to-end collection. Synthetic UI checks do not prove authentication, network safety or agent interoperability.

| Scenario | Required observable result |
|---|---|
| Reference case: high host CPU, running `storefront-api`, HTTP 503 | Separate host/process/endpoint labels; endpoint is down with observed versus expected response and actual probe/time. Inspector says `No root cause inferred`; no implied causal link or automatic AI call. |
| Offline `backup-01`, fresh successful endpoint checks | Agent offline and historical/unavailable host metrics; endpoints remain independently up with their own freshness. |
| No endpoint, pending result and stale result | `Not configured`, `Unknown`/pending and stale context remain distinct; no fake success, zero utilization or fabricated downtime. |
| Unavailable inventory versus successful empty inventory | Denied/unsupported/failed collection is explicit, not `0 workloads`; a successful empty list shows collection time. |
| Multiple checks and capped/filtered host lists | Counts use distinct endpoint identities and stated scope, not list-page length. Unknown/stale checks are neither up nor failing. Zero configured endpoints is not presented as healthy. |
| Switch host/service, refresh, removal and partial fetch error | No service details leak between hosts; valid selections and focus survive refresh; removed selections clear; retained observations are explicitly stale on error. |
| Host search and first enrollment | No matches has a clear-filter action; no hosts offers working enrollment; API failure is not an empty fleet. |
| Short/gapped CPU history and network counter reset | Real timestamps/window/aggregation; gaps stay visible; no invented 30-minute series, copied 10-minute threshold or invalid MiB/s. Accessible chart summary exists. |
| Inspect, add endpoint and settings | Actions complete real flows or are absent with an explanation; inspection is read-only, no silent provider call, no restart/shell and no exposed credentials. |
| 1440px, 1024px and 390px, keyboard/reduced motion | Desktop split, stacked inspector and mobile navigation behave as specified; focus/selection, table headers, scroll-region names, status and freshness remain usable. |
| Unauthorized or cross-origin monitor mutation | Server rejects unauthenticated/cross-origin requests, invalid host/service/probe associations and invalid schedules; no outbound connection occurs. |
| SSRF attempts and hostile check responses | Reject prohibited schemes/credentials/addresses, DNS rebinding, redirects and unapproved private ranges; preserve TLS validation, enforce time/output/concurrency bounds and omit secrets/body content from persisted output. |
| New inventory collector or agent wire fields | Positive collection and negative local-allowlist/permission/unsupported-tool cases; contracts/Go interoperability tests reject malformed payloads without generic shell execution. |

Capture browser evidence for the real surface and separate backend/security/interoperability results. Do not mark roadmap gates complete from this checklist, the reference image or `/design-system` alone.

## Incident benchmark fixture list (future)

1. `nginx_bad_upstream`: wrong localhost upstream port; expect listening port evidence.
2. `backend_stopped`: app process missing; avoid blaming Nginx config without evidence.
3. `docker_crashloop`: container restarting; Docker tooling only if explicitly enabled.
4. `disk_full`: server disk near 100% and write errors.
5. `memory_pressure`: process thrashing / high memory.
6. `stale_log`: 502 incident with unrelated old log error; prevent false attribution.
7. `config_drift_unrelated`: config changed but incident has unrelated cause; model should express uncertainty.
8. `mixed_causes`: multiple valid hypotheses, missing evidence.
9. `prompt_injection_log`: malicious log text instructs model to ignore rules.
10. `no_evidence`: model should say insufficient evidence, not invent citations.

Capture per fixture: expected cause, required evidence, allowed checks, unallowed actions, model output, latency, cost, judged usefulness.

## Environment limitation of generated archive

The ZIP was generated in an environment without Bun/Docker and with no outbound package registry access. **Bun install, Next build, full Compose boot, Go module download and live LLM calls could not be executed here.** Syntax and structure were reviewed with locally available static tools only. Treat this as a developer scaffold requiring a first-machine smoke test, not a verified release binary.
