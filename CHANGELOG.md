# Changelog

## Unreleased — 2026-11-18

- Added stored BYOK AI connections with encrypted credentials, manual protocol/model selection, revision-checked investigation snapshots, and explicit asynchronous synthetic connection tests.
- Added public-only DNS-pinned HTTPS transport with verified TLS, bounded responses/deadlines and sanitized failures; no OAuth, automatic fallback, model discovery or 9Router dependency.
- Added checksummed transactional migrations, explicit legacy credential importer and ordered Compose schema bootstrap. Existing deployments must stop old Hub/Worker before migration; see the cutover guide.
- Fixed review findings in the BYOK importer, canonical UUID-bound credential replacement/audits, provider-first Worker claim locking, and Gemini 2.5 thinking budgets with reserved answer headroom.
- Verified 62 Bun tests with disposable PostgreSQL/native HTTPS fixtures, all workspace typechecks and the real management UI at 1440/1024/390px. Fixed JSONB double encoding in audit/report persistence exposed by integration tests. No paid-provider calls or production deployment.
- Added curl-based headless Linux/systemd onboarding: explicit HTTPS Hub metadata, pinned release/repository configuration, authenticated install-config API and public static installer. The dashboard now offers a single token-bearing command with copy/hide/expiry and late-response cleanup.
- Added finite `opspilot-agent enroll`, redirect refusal and atomic 0600 identity persistence. The installer verifies archive checksums/members, enrolls as nonroot, keeps tokens out of env/unit files, and supports only byte-identical same-version reruns; conflicting installations are never upgraded or overwritten.
- Set systemd `StateDirectoryMode=0700` after real VM acceptance exposed the default resetting the installer’s private state directory to 0755.
- Focused Bun tests (14), Go tests through Docker Go 1.24.2 and workspace typechecks passed. Disposable-DB API and responsive browser lifecycle checks passed. Real Debian amd64/KVM and ARM64/QEMU systemd acceptance covered generated-command installation, HTTPS/WSS telemetry, ownership, retry/conflict safety, restart/reboot persistence and twelve failure scenarios using local trusted HTTPS release fixtures. Public GitHub publication remains a deployment prerequisite; see `docs/TESTING.md` for exact boundaries.
- Refined the host dashboard with the selected Signal Focus direction: stronger scoped fleet counts, named host-signal selectors, clearer table selection, and a focused resource inspector. Added pointer/keyboard inspection of exact historical samples without aggregating or filling collection gaps; narrow layouts place the inspector before secondary drift/service disclosures.
- Scoped native View Transitions to resource history so rapid host/resource selection stays interactive; reduced-motion, mobile and unsupported browsers retain immediate updates. No dependencies, telemetry, agent protocol or backend capabilities changed.
- Web typecheck passed. Chromium checks against an isolated real Hub/PostgreSQL instance with labeled persisted demo data covered host/resource selection, API-matched sample values/timestamps, keyboard scrubbing, collection gaps, missing history, empty search, enrollment/incident focus, reduced motion and 1440/1024/390px layouts without page overflow. Inspection issued no API writes. No live agent, diagnostic, endpoint probe or model call was exercised; detector type-size advisories were addressed with the documented measurement token and existing mobile type step.
- Split GitHub automation into clearly named CI, versioned Release and reusable GHCR Packages workflows. Version tags must be valid SemVer and belong to `main`; publication is gated by CI. Releases include Linux AMD64/ARM64 agent archives, systemd templates, SHA-256 checksums and generated notes.
- Added multi-platform Hub/Worker/Web/Agent image publishing with version aliases restricted to stable releases. Pinned Bun container builds to 1.4.2 with frozen dependencies, verified Go modules, and excluded nested local build directories/environment secrets from Docker contexts. Documented required-check renaming, tag publication, package access, unsigned-artifact limitations and non-transactional image pushes.
- Verified workflow syntax, version/ancestry guards, all four AMD64 image builds and the packaged Web server's HTTP response. No live GitHub release/package publication or production deployment was performed; see `docs/TESTING.md` for verification limits.
- Simplified the sidebar to Hosts, Incidents, Configuration drift and Incident memory. Merged the duplicate Overview/Hosts views; removed sidebar enrollment (still in the header), the developer catalog link and repeated deployment/account captions. Provider settings and Sign out remain below; mobile exposes them through More.
- Replaced the count-dependent moving navigation marker with a marker on the active item. Preserved icon-only mode, accessible names, keyboard focus and the stored collapse preference.
- Web typecheck passed. Browser checks with synthetic API responses covered desktop/mobile navigation at 1440/1024/390/320px, collapse persistence, keyboard access, More, enrollment focus and sign-out UI. No live authentication or diagnostics integration was tested; the detector only reported existing meter-width/root-font findings.
- Added a responsive Ctrl/Cmd+K command palette with local host and incident search, recently opened results, keyboard navigation, and quick links to enrollment, provider settings and incident memory. Service search explicitly reports unavailable inventory.

## Unreleased — 2026-11-17

- Changed the default Web development port to 3100; production remains on port 3000.
- Applied the host-dashboard reference: flat Host/Status/CPU/Memory/Disk/Last seen table, tonal selection, selectable raw resource bars (disk initially), recorded-drift notice and related-incident investigation link. Unavailable services move into a disclosure; no synthetic telemetry, thresholds or capabilities are added.
- Verified persisted local demo data through Hub/PostgreSQL in Chromium at 1440/1024/390px: host search/selection, CPU/memory/disk switching, missing measurements and related-incident navigation. Web typecheck passed; existing meter-animation/root-font detector findings are outside this change.
- Added and ran the opt-in local `db:seed:demo` command: labeled host/history, incident/evidence, terminal AI-report examples and searchable resolution fixtures. Transactional/no-overwrite reruns and production/non-loopback refusal keep the seed bounded; offline status and unavailable service/endpoint capabilities remain truthful.
- Verified persisted examples through the real local Hub/PostgreSQL dashboard and passed two isolated seed safety negatives. No agents, diagnostics, probes or provider calls were started.
- Aligned the dashboard with the approved Fleet & services composition: quiet navigation rail, inline scoped summary, Linux-host/service workspace and a compact resource/history inspector. Added working in-page incident/drift/provider destinations and focused enrollment reveal/close; unsupported inventory/endpoint actions remain explicitly unavailable.
- Verified this UI alignment in Chromium at 1440/1024/390px with synthetic API responses, including selection/search, cached failures/removals, missing data, navigation and enrollment states; Web typecheck passed. No new live inventory, probe or authentication-integration claim.
- Added a desktop sidebar toggle: 232px expanded / 72px icon-only, mint OP abbreviation, accessible navigation names, native hover titles and a browser-persisted preference. Mobile keeps labeled navigation regardless of the desktop preference.
- Replaced dashboard navigation with the Precision Rail: sticky sidebar, outline icons, translating mint active marker, separated utility/account area and keyboard-operable mobile Utilities disclosure. Existing destinations and sign-out behavior are retained; shared reduced-motion rules apply.
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
