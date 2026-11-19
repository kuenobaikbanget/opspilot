# Test & Validation Plan

## Current repo tests

```bash
bun --no-env-file test
bun run typecheck
(cd agent && go test ./...)
```

`tests/contracts.test.ts` covers tool/metric bounds, provider input contracts and redaction. The BYOK suites below cover credential, transport, migration and real API/Worker boundaries. `tests/agent-install.test.ts` covers installation metadata and command quoting; `tests/agent-installer.test.ts` covers pre-mutation shell rejection with isolated fixtures, never successful privileged installation on the developer host. Go agent tests cover parsing/redaction/WS URL plus finite enrollment, response/redirect rejection and identity preservation. These tests are **not** a substitute for broader agent security, integration, and AI evaluation.

## Overview triage verification — 2026-11-19

- Web typecheck and the focused Home DOM suite passed: 10 tests, 46 assertions. New cases cover 503 on matched investigation detail, same-host configuration drift excluded from CPU pressure, and cancellation of pending history when leaving Hosts.
- Chromium used isolated Next.js webpack and a read-only loopback dashboard fixture. At 1440, 1024, 390 and 320px the document matched viewport width. Watchlist and inspector shared the top edge on desktop; mobile stacked watchlist, inspector, reachability. Keyboard selection focused the inspector, then Tab reached history, incident, and endpoint actions in that order. The offline shortcut focused the filtered inventory and reset restored all seven rows.
- The base fixture showed 6 online, 1 offline and 4 assessed; offline showed last seen, and stale/no-sample rows remained distinct. A synthetic cap showed 198 online and 2 offline with only six online rows loaded; loading and initial 503 showed no counts, and a later 503 retained those counts as cached with no current readings.
- Matched detail loading, 503 and successful empty remained distinct; a same-host disk selection never read its configuration-drift incident. Recorded AI showed source incident title and time. Margins were 9 pp (94% vs 85%), less than 0.1 pp, or At limit; 110.6% of limit was a separate ratio. Inspecting did not submit an AI request.
- Endpoint fixtures covered delayed read, successful empty, 503, pending, stale and fresh up/down; counts changed from 1 up/1 down/1 pending/1 stale to 0 up/1 down/1 pending/2 stale without another successful read. Stale kept the original timestamp and historical HTTP result. An intercepted Check now POST showed busy/disabled, surfaced the synthetic failure and reenabled the control; no probe ran.
- Browser network: 2 initial/periodic fleet reads and 0 metric reads on Overview. Opening disk history made 2 reads for the selected host (200, then a held poll aborted with `net::ERR_ABORTED` on exit). Over the next poll interval there was 1 fleet read and 0 metric reads; inspecting the offline row reopened Hosts and loaded its CPU history with a 200.
- The Impeccable mechanical detector reported no findings across the four changed runtime UI files.

This verifies rendered Web behavior with synthetic records and failures, not live Hub, agent, endpoint reachability, AI, authentication, or physical-device behavior.

## Home audit fixes — 2026-11-18

- `bun --no-env-file test tests/home-ui.test.ts`: six regressions passed (33 assertions). Each mounts the actual Home component in its own Bun subprocess with Happy DOM and synthetic API responses; no DOM globals or fetch replacements enter the shared test runner. Cases cover a failed initial incident read with usable hosts/unavailable counts, recovery preserving a separate sign-out error, labeled cached records, rejected startup sessions, retriable session-check outages and expiry clearing the protected surface.
- `bun run --cwd apps/web typecheck` passed after correcting the test fixture's fetch signature to avoid claiming Bun's additional `fetch.preconnect` API.
- Chromium browser verification used the existing local Web/Hub/PostgreSQL with persisted labeled demo data and a short-lived locally signed admin cookie. A simulated incident-read 503 on reload left six real returned host records visible, rendered an unavailable count rather than zero, and avoided claiming no related incident. Retrying the real incident endpoint restored the count of three and removed the failure alert.
- Captured desktop/mobile surfaces at 1440/390px, then confirmed 1024px touch-tablet and 320px narrow layouts. Document width matched each inspected viewport. Mobile controls had no targets below 44×44px among enabled dashboard buttons/inputs/disclosures; the 1024px coarse-pointer Refresh, host selection and metadata disclosure targets were each 44px tall.
- Keyboard host selection preserved a 2px focus outline and pressed state. Enrollment open/close moved focus into the section and back to its trigger without creating a token. Synthesized Chromium touch moved the native host table's horizontal scroll position from 0 to 172px.
- The scoped detector reported only the existing shared meter-width transition, which is not rendered by this host workspace. No new detector finding was introduced.

This verifies component behavior and the rendered local dashboard, not password login, live session-expiry enforcement, physical touch hardware, Safari, production Core Web Vitals, agent collection or LLM/provider calls. Failure responses and auth negatives in the component suite are synthetic; server authorization is unchanged. Temporary browser cookies/tabs are removed after verification.

Run these isolated UI regressions with `bun --no-env-file test tests/home-ui.test.ts`; they require only the installed development dependencies, not a running browser, Web server, Hub, database or credentials.


## BYOK provider management verification — 2026-11-18

- Approved seven-file command passed: **62 tests, 0 failures, 2771 assertions** using Bun 1.4.2 and PostgreSQL 16 disposable child databases. Hub, Worker and Web typechecks passed. Compose full-profile configuration parsed successfully.
- Crypto checks cover canonical master encoding, fresh nonces, wrong master/AAD and tampered envelopes. Native HTTPS checks cover conservative IP/URL policy, all-answer DNS rejection/pinning, redirects, wrong-host/untrusted TLS, header/body/chunk limits, DNS/connect/body deadlines, late DNS and unsafe runtime flags. Three real HTTPS protocol fixtures exercise authentication, explicit models, token limits, diagnosis parsing and citation filtering.
- Real Hub subprocess/SQL/Worker integration covers admin cookie/Origin/body/UUID/input negatives, CRUD/revision/key replacement, missing/malformed master and unreadable credentials, disabled/deleted/stale connections, concurrent claims, expired/replaced/late test results, transactional allowlisted audits and snapshot retention. A native Worker subprocess fails private-target requests safely without a paid provider.
- Migration/import checks cover empty and legacy schemas, terminal preservation, pending legacy failure, ledger reruns/checksum mismatch/file rollback, all three legacy imports, identical reruns, collisions, invalid master/no-key early exits and the 100-connection limit.
- Browser proof used real Next → Hub → PostgreSQL on disposable ports 3101/3301 because the user's existing 3100 server was left untouched. Web ran from an isolated source copy to avoid its Next development lock. Login, add/edit, blank replacement-key input, metadata-only save, changed-destination key requirement, enable/disable selection, native DNS test failure and stored synthetic HTTPS test success were observed through the page.
- A browser-submitted investigation completed using an explicit `browser-fixture-model` with the actual persisted evidence citation. Renaming/changing the default model did not change its report; deleting the connection through inline confirmation removed it from selection while preserving the readable snapshot with null connection ID.
- Keyboard focus/editor cancel/delete restoration, mobile controls, field error, master-missing notice, key-draft clearing on tab change/logout/unauthorized, empty state and independent provider-load failure were checked. Provider-load failure and unauthorized responses were deliberately simulated at the browser network boundary; master-missing used a real Hub restart. GET responses and local/session storage contained no dummy provider keys.
- Captured actual management/editor surfaces at 1440/1024/390px: document width matched each viewport, table remained in a named horizontal-scroll region and mobile form used one column. Mechanical detector returned no findings. A scoped visual review found an Enabled-column wrap defect; local nowrap CSS and recaptures resolved that single finding.
- Screenshots: [desktop](../.impeccable/review/byok-desktop.png), [tablet](../.impeccable/review/byok-tablet.png), [mobile](../.impeccable/review/byok-mobile.png).

No live OpenAI/Anthropic/Gemini request, full Compose boot/image build, production deployment, new agent wire behavior or master-key rotation was tested. Test-only HTTPS code asserts the production pinning/TLS options then maps a validated public fixture address to a loopback listener with a dummy CA; it does not prove public network reachability. Only disposable resources created for this verification are removed.

### BYOK review regression verification

- Ran the focused adapter, migration/import and Hub/Worker suites against PostgreSQL 16 in an isolated loopback-only Docker namespace: 43 cases, initially 42 passed and one exposed uppercase audit IDs. After normalizing route IDs, the targeted CRUD regression passed (1 passed, 12 filtered out).
- Regressions cover the actual package-script importer ignoring a retained dummy `.env`, replacement-key decryption through an uppercase UUID, a forced concurrent DELETE/Worker claim, and Gemini 2.5 thinking consumption with parsed diagnosis output while legacy/image models receive no unsupported thinking configuration.
- Hub, Worker and Web TypeScript checks passed. Source/toolchain mounts were read-only, environments allowlisted, and containers used bounded memory/CPU/process/tmpfs limits. No user database, provider credentials, paid API request or browser session was used.

## Curl onboarding verification — 2026-11-18

- Focused `bun test tests/agent-install.test.ts tests/agent-installer.test.ts`: 14 tests passed.
- Go tests passed using Docker Go 1.24.2 (the host has no Go toolchain).
- Workspace typechecks passed.
- Real API acceptance used a disposable PostgreSQL 17 Alpine container and new `curl_acceptance` database initialized with `bun run db:init`, Hub on 3318 and Web on 3319. Unauthenticated config returned 401; authenticated valid metadata returned 200; wrong-Origin token issuance returned 403. Both absent and invalid metadata returned 503 without changing token count, while hosts remained 200.
- Public installer GET returned 200 with exact static bytes and expected content type, `no-store` and `nosniff`; POST returned 405 with `Allow: GET`, including with a wrong Origin. Token issuance returned 201 with the unchanged response keys and `expiresInSeconds:600` plus its audit event. Accepted enrollment returned 201 with its audit event; empty, expired and reused tokens returned 401, and browser-Origin enrollment returned 403.
- Real Hub/Web browser checks at 1440px and 390px observed no document overflow, including a generated command on mobile; screenshots were taken before issuance. Clipboard success appeared only after actual copy resolution. Hide cleared the command and copy success; navigation away/back cleared the command; close returned focus to its trigger.
- Denied browser clipboard permission preserved selectable text/manual-copy recovery. Delayed real Hub metadata/token responses after close did not restore the panel/command; deferred completion of an actual clipboard write after Hide did not restore stale success. A +601-second browser virtual-clock scenario cleared expired command/copy state. Actual sign-out and a 401 token response removed the protected secret.
- Actual unconfigured-Hub 503 metadata, routed into the real dashboard, disabled generation with no command. A temporary trigger in the disposable DB induced real token-issuance 500: distinct error, no command, retry still enabled; the trigger was removed. Impeccable's scoped detector returned no findings.
- Built workflow-exact static Linux amd64 and arm64 archives with Docker Go 1.24.2. Each contained exactly the binary, unit and env template; checksums matched. Version `v0.1.0-curl.acceptance` existed only in the local HTTPS fixture, never as a public release.
- Installed actual generated commands over nonroot SSH on real Debian 12 systemd guests: amd64/KVM and ARM64/QEMU TCG. A guest-only trusted CA/hosts mapping served GitHub-download fixtures and an HTTPS/WSS reverse proxy to a real Hub and separate disposable DB; no insecure TLS or production download-host override. Services were active/enabled as `opspilot`; executable/unit/env were root-owned 0755/0644/0600, env directory 0750, state 0700 and identity 0600 owned `opspilot`. Tokens were absent from env/unit.
- Initial KVM acceptance exposed systemd resetting the state directory to 0755. The user approved adding `StateDirectoryMode=0700`; both archives were rebuilt and both guests reinstalled. Mode 0700 then persisted across service restart and reboot. Same IDs resumed and actual post-reboot samples increased amd64 3→4 and ARM64 6→7; disconnected SSH did not stop the service. Both agents were Online with fresh measurements through the real API.
- Same-version reruns on both architectures left newly issued tokens unused. Differing existing env files were refused without changing binary/unit/env/identity hashes.
- Twelve VM failure scenarios passed: archive 404, unreachable download, checksum mismatch, missing/empty checksum, duplicate checksum, malformed checksum, unsafe/traversal member, invalid gzip with matching checksum, unreachable Hub, expired token, unwritable identity state and unavailable WSS. Download/checksum/archive failures left installation paths/accounts absent; enrollment failures did not start the service. A read-only state failure consumed the accepted token but wrote no identity, correctly requiring a fresh token rather than fabricated recovery. With WSS 503 the service remained active while the real host stayed Offline and samples stayed 8→8.
- All owned guests, fixture container, dedicated Hub/database, disposable keys and token-bearing temporary files were removed. The workstation was never used for privileged installation.
- GitHub's releases API returned an empty list. No release was published; deployment requires a reviewed post-merge release containing finite `enroll`. An example version is not a working public installer.

**Verification boundary:** public GitHub release publication/download and production DNS/TLS remain unverified. The VM acceptance used generated commands and locally built real release archives under trusted HTTPS fixtures, not a published release. ARM64 ran under QEMU, not physical ARM64 hardware. Browser issuance/copy and VM command execution were exercised separately, not as a single browser-clipboard-to-SSH session.

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

## Selected-host systemd verification

Run the focused Bun checks with Go from `agent/go.mod` on `PATH` and `AI_PROVIDER_TEST_DATABASE_URL` pointing at a disposable loopback PostgreSQL 16 `opspilot_byok_test` base (the integration test creates and drops a randomized child database). The integration case skips without that explicit fixture URL. Never use the application DB.

```bash
bun --no-env-file test tests/systemd-report.test.ts tests/systemd.integration.test.ts tests/home-ui.test.ts tests/services.test.ts
(cd agent && go test -mod=readonly ./internal/agent)
bun --no-env-file run --filter @opspilot/hub --filter @opspilot/web typecheck
```

- The four Bun files passed **13 tests / 138 assertions** with disposable PostgreSQL 16 and the actual Go binary; Go agent tests and Hub/Web typechecks passed. Coverage includes default-off/invalid config over the Go wire, wrong credential and missing admin session, host spoofing, bad size/count/name/enum/time, legacy telemetry before/after invalid frames, fixture exclusion, socket replacement, out-of-order reports, age expiry, and removal of the measurement on opt-out.
- A disposable Debian 12 amd64/KVM guest ran the packaged service unit as the unprivileged `opspilot` user. The same fixed `systemctl show` operation returned `LoadState=loaded` and `ActiveState=active`, `inactive`, and `failed` for `opspilot-verify.service`; the Hub returned `Running`, `Stopped`, then `Failed` from actual reports. Stopping the agent left the last `Stopped` observation and its timestamp unchanged but stale; restarting the agent produced a newer fresh `Stopped` observation. Denying access to the guest's system bus returned `Permission denied`; the Hub reported `unavailable` with the prior `Failed` sample still stale. Clearing the opt-in produced `disabled` with no measurement. No host units or access policy were changed.
- A real updated Go agent running without a systemd manager reported `unsupported` and no measurement. A real Go agent built from the pre-feature revision sent ordinary telemetry without a service report; `/api/hosts/:id/metrics` returned samples and the service read stayed `report:null, service:null`. VM/container transport was isolated local HTTP/WS, not a production TLS deployment test.
- A new Orca Chromium tab against isolated Next.js, Hub and PostgreSQL showed live unit state, original timestamps and fresh/offline transitions on Services. Switching hosts showed unsupported and not reported without leaking the VM's unit; denied access and explicit opt-out were shown separately. Keyboard selection on the mobile Hosts inspector showed the same opt-out. At 1440, 1024 and 390 CSS px, page scroll width matched the viewport. Desktop and mobile screenshots were inspected; the design detector returned `[]`. No endpoint scheduler, remediation, or real probe was exercised by the VM/browser scenario.

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

`tests/incident-fixtures/` contains **synthetic, annotated JSON research fixtures** (currently `config-drift-unrelated.json`, `nginx-bad-upstream.json`, and `prompt-injection-log.json`), not tests that automatically deploy an outage. None includes real credentials or confidential logs. Run a real local test environment and collect actual evidence IDs before comparing a model response to the labels; do not fabricate an LLM success score from these fixtures.

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

## Earlier verification history (2026-11-15 – 2026-11-16)

### Development-host verification — 2026-11-16

- Installed workspace dependencies with Bun 1.4.2 (`bun.lock`) and downloaded the Go WebSocket dependency via `go mod tidy` (`agent/go.sum`).
- `bun test`: 3 passed, 0 failed; `bun run typecheck`: Hub, Worker, and Web all passed; `bun run --cwd apps/web build`: Next.js 16.4.6 production build passed (`/` and `/design-system` prerendered).
- Impeccable mechanical detector over the changed Web sources returned no findings.
- Ran the Next.js development server and exercised `/design-system` in Chromium at 1440px and 390px: form errors and focus recovery, valid local preview, loading/finish/reset, slider keyboard bounds, unknown metrics, and evidence disclosure; observed no catalog API requests or horizontal overflow, verified visible keyboard focus and reduced-motion handling, and measured sampled default text contrast ratios of at least 8.22:1.
- Exercised the migrated login/dashboard UI using temporary synthetic browser API responses (failed login, queued-investigation display, resolution, memory search); UI-only checks, not live integration evidence.
- Still unverified in that pass: PostgreSQL initialization, live Hub/authentication, Linux agent enrollment and WSS, Docker image builds, Linux AMD64/ARM64 binaries, and external AI providers.

### GitHub CI verification — 2026-11-16

The [Checks run for commit `5d6b178`](https://github.com/kuenobaikbanget/opspilot/actions/runs/43803885453) completed successfully on Ubuntu runners: frozen Bun installation, Bun tests, all workspace typechecks, the Web production build, and `go test -mod=readonly ./...` in the Linux Go job. Linux Go unit-test success is not live agent enrollment, WSS interoperability, or an AMD64/ARM64 release-binary validation.

## Environment limitation of generated archive (2026-11-15)

The initial ZIP archive (2026-11-15) was generated in an environment without Bun/Docker and with no outbound package registry access. Static checks verified folder/file consistency, parseable JSON configs/fixtures, TypeScript/TSX syntax transpilation, Go `gofmt`, Compose YAML parsing, and ZIP integrity, while **Bun install, Next build, full Compose boot, Go module download, and live LLM calls could not be executed there.** Treat those original archive checks as historical static validation, replaced by the subsequent development-host, CI, and host-slice runs above.
