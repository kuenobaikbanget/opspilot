# Security & Threat Model

**Status:** MVP starter. **Do not expose this as a public production service without implementing the release blockers below.**

## Threats / trust boundaries

| Boundary | Risks | Current baseline | Required hardening |
|---|---|---|---|
| Browser → Hub | password guessing, CSRF, session theft | signed 8-hour HttpOnly SameSite=Strict cookie; Origin checks on POST/PATCH/DELETE, exact required Origin for AI mutations | rate limit, CSRF token, login lockout, security headers, TLS proxy |
| First agent enrollment | token interception / reuse | 256-bit random token, SHA256 hash, 10min TTL, atomic consume | visibility/audit, abuse throttling, approval UI |
| Agent WSS | impersonation, replay, exfiltration | 256-bit bearer secret hashed in DB; auth before upgrade; no token in URL | cert trust, key rotation/revocation, versioning, mTLS option |
| Agent diagnostics | remote command abuse | enumerated safe tools, local service allowlist, fixed executable, 5s timeout, output cap | per-agent capabilities, policy engine, security testing |
| Docker access | host takeover via docker.sock | disabled by default; no socket mount | only through minimum-scope API proxy after explicit approval |
| Config / logs | secrets / PII leaks | hashes only for config; limited logs; simple regex redaction | tested secret scanners, opt-in per data class, preview/consent |
| Hub/DB | direct SQL/credential theft | parameterized SQL, localhost ports by default | encryption at rest/backups, separate DB roles, patching |
| LLM provider | untrusted input, data disclosure, wrong actions | bounded JSON response, validated evidence IDs, no action tools | prompt-injection evaluation, budget caps, disclosure policy |
| Worker queue | stuck job / duplicate processing | one queue via SKIP LOCKED | leases, idempotency, retries and poison-message handling |

## Secrets and configuration

- Use `bun run password:hash -- "..."` to generate Argon2id admin password hash. Never store clear admin password in production `.env`.
- Use a strong `SESSION_SECRET` (>=32 random characters), rotate on compromise.
- Use environment files with restrictive modes and protect backups.
- Provider API keys are entered only through authenticated same-origin settings and stored as AES-256-GCM envelopes in PostgreSQL. Only Hub/Worker/importer read `AI_PROVIDER_ENCRYPTION_KEY`; Web receives neither master key nor DB credentials, saved keys, or ciphertext. No runtime provider-key environment fallback.
- Agent identity secret stored 0600 on host or in protected Docker volume; remote use HTTPS/WSS.
- Host lists/history remain behind the existing admin cookie; enrollment token creation retains the existing Origin check, one-use token and audit path. The live inspector performs no diagnostics, outbound probe, LLM call or remediation. Workload/endpoint unavailability never implicitly enables Docker or shell access.
- The host dashboard's 60-second telemetry freshness label is a display policy, not a transport heartbeat or replay defense. `Online` means a socket is currently registered in this single Hub; silent network partitions still require transport TTL hardening. Enrollment tokens must not enter persistent browser storage, URLs, screenshots or logs; the admin-only enrollment view clears them on sign-out/expiry.
- Provider settings accepts one key per connection in a password input, never retrieves/reveals a stored key, and clears drafts on save/cancel/unmount/sign-out/unauthorized. No credential-derived masks or browser persistence. Save does not call a model; tests and investigations require explicit admin actions.
- The opt-in `db:seed:demo` command is restricted to non-production, loopback database connections and uses a transaction with reserved fixture identities; it does not delete or overwrite existing rows. All hostnames, evidence, authored AI examples and resolution examples identify `Demo data`. Agent credentials are randomly generated and discarded, hosts remain offline, and investigation fixtures are completed/failed rather than runnable queue entries. Seeding starts no diagnostics, probes or provider calls; it must not be treated as collected evidence or a real confirmed resolution.
- An agent with Docker group membership often has root-equivalent power; never assume `docker.sock:ro` is safe just because the mount says `ro`.

### Curl onboarding trust and secret handling

Installation metadata is admin-only, explicitly configured on the Hub and never inferred from browser/internal addresses or request headers. Missing/invalid metadata disables this onboarding surface with 503, not monitoring or manual enrollment. The public `GET /api/agents/install.sh` serves only static, token-free Bash with `no-store`, `nosniff` and shell-script content type; other methods return 405. It adds no unauthenticated enrollment authority.

The install command exposes its 10-minute, one-use token to shell history, clipboard and process arguments. The setup wizard keeps it only in memory and clears it on hide, expiry, leaving the install step, or leaving the wizard. This does not revoke the token or erase external copies; generating another does not revoke earlier tokens. Clipboard denial leaves selectable text. Verification reads the authenticated host list and requires explicit selection; it does not claim the Hub tied that host to token issuance. Tokens must never enter URLs, persistent browser storage, env/unit files, logs or screenshots.

The installer downloads only pinned GitHub release assets over verified HTTPS with bounded timeouts, checks one exact archive checksum and rejects unsafe/extra archive members before mutation. Unsigned `SHA256SUMS` establishes archive integrity under the same HTTPS/GitHub trust, **not independent publisher authentication**. Public script delivery is also part of the trusted Hub/TLS deployment. No `latest`, arbitrary download-host override, tracing, eval or curl-to-root pipe is used.

Enrollment runs as the dedicated nonroot account and atomically saves a 0600 identity in its 0700 state directory. The finite command requires an HTTPS origin, refuses enrollment redirects and does not print response bodies/secrets. Valid identities are reused without token consumption; corrupt identities are preserved and rejected. No-argument monitoring retains HTTP only for local development compatibility. Tokens stay transient and are absent from the installed env and unit.
The unit explicitly sets `StateDirectoryMode=0700`; relying only on installer chmod is insufficient because systemd otherwise resets `StateDirectory` to its default 0755 at startup.

Same-version reruns require byte-identical binary/unit/env; conflicting files and symlink targets are refused, not overwritten. No upgrades, identity deletion or privilege-group grants are performed. A lost accepted enrollment response requires a fresh token, not invented recovery. Local service-active does not prove WSS connectivity or fresh telemetry. GitHub currently has no published releases: publish a reviewed compatible release after merge before enabling this path; an old binary without `enroll` is not compatible.

## AI connection credentials and egress

Generate the master with `openssl rand -base64 32`; canonical base64 must decode to exactly 32 bytes. Back it up separately from PostgreSQL and share the same value only with Hub/Worker. Missing/malformed configuration leaves monitoring available; wrong key/tampered envelope fails `credential_unavailable`. There is no automatic master rotation or credential deletion/recovery. Restore the original master, or replace each provider key under a new master.

Each encryption uses a random 12-byte nonce, 16-byte tag and AAD `opspilot:ai-provider:v1:<uuid>`; storage is `v1.<nonce-base64url>.<ciphertext-base64url>.<tag-base64url>`. UUID is created before encryption. Endpoint/protocol changes require a newly entered key so an existing credential cannot silently move to another destination.

Worker transport uses native HTTPS with public-address classification and DNS pinning, original Host/SNI/certificate verification, `agent:false`, no proxy/global agent, no redirects or retries. It resolves every A/AAAA answer and rejects the entire target if any is nonpublic. IPv4 special-purpose ranges are blocked; IPv6 allows only 2000::/3 minus the documented special-purpose exclusions. This deliberately conservative policy may reject globally reachable special addresses. Private gateways, loopback, metadata and localhost are unsupported, without an override flag.

Every final operation URL is validated: HTTPS only, valid port, no userinfo/query/fragment/zone identifier. Total deadline is 30 seconds including DNS/body; TCP/TLS deadline 5 seconds, headers at most 16 KiB, body at most 1 MiB, identity encoding only. Late DNS cannot open a socket. `NODE_TLS_REJECT_UNAUTHORIZED=0` or active `BUN_CONFIG_VERBOSE_FETCH=1/curl` is rejected before requests. TLS verification cannot be disabled through the provider API.

Provider failures expose/persist/log only fixed categories and optional HTTP status, never upstream body, Location, raw URL/exception, auth headers or request body. Mutation/test-result audits are transactional and allowlist only protocol, revision, changedFields, testId, httpStatus, errorCode. Each provider retains one test slot, not unbounded test history. Credential deletion leaves non-secret investigation snapshots and audit events intact; general report/audit retention remains operator-managed.

Browser revision, queue snapshot and Worker claim checks prevent sending evidence to a configuration changed before execution. Once Worker captures configuration, an in-flight HTTPS request is not cancellable by edit/delete. A synthetic connection test can incur charges and validates generation/schema, not endpoint uptime or diagnosis quality. No model discovery, OAuth, fallback, automatic scheduling or remote execution is added.

Address policy references: [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) and [IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/). Enforce independent network egress controls as defense in depth.

## Agent tool policy

Tools are fixed in source code:

1. `disk_usage` → `df -h` on agent-configured path.
2. `listening_ports` → `ss -lnt` (can expose internal service metadata).
3. `service_status` → `systemctl is-active <allowlisted service>`.
4. `recent_logs` → `journalctl -u <allowlisted service> -n 50`.
5. `docker_status` → `docker ps`, **agent flag required**, no docker socket mount in default Compose.

No arbitrary URL fetch, filesystem read, or shell script tool is permitted. Add filesystem restrictions before broad deployment.

## Planned inventory and endpoint monitoring

The [Fleet & services dashboard](UI-UX.md#fleet-services-dashboard-contract-target) introduces future collection requirements, not currently enabled tools or network access. The prohibition on arbitrary URL-fetch/shell diagnostics above remains unchanged.

- **Workload inventory:** opt-in, enumerated read-only collectors; agent-local runtime/service allowlists; fixed executable/API operations, deadlines and output bounds. Missing capability or denied permission is explicit unavailable data. Do not mount `docker.sock`, enable Docker access or grant journal/root privileges merely to populate a dashboard.
- **HTTP checks:** dedicated operator-configured monitors, never model-selected targets or a generic agent fetch tool. Require admin authorization and same-origin mutation protection; persist and audit target, association and schedule changes. Do not add a new unauthenticated probe endpoint.
- **SSRF/egress:** validate HTTP(S) schemes, ports and normalized targets; reject URL credentials, local files, cloud metadata, loopback, link-local, multicast and unspecified destinations. Private homelab ranges require an explicit operator-controlled allowlist, not a client override. Resolve and validate all IPv4/IPv6 destinations at execution, bind the connection to an approved address while retaining TLS hostname verification, and prevent DNS rebinding. Disable redirects by default; any later redirect support must reapply the complete policy at every hop.
- **Execution bounds:** explicit connect/total timeouts, bounded concurrency/schedule frequency and response size; do not store response bodies by default. Audit monitor changes and bounded execution outcomes without turning checks into a full request/response log warehouse.
- **Sensitive targets/results:** minimize stored URLs; prohibit secrets in query strings and redact sensitive target/header values from UI, logs, audits and provider context. Any later authenticated-check credentials must remain server-side and scoped to the configured destination; never forward browser admin cookies or provider keys. Hostnames, service metadata and HTTP errors remain untrusted data, not instructions.
- **Provenance and retention:** timestamp and identify each actual probe location independently of the monitored agent. Define bounded result retention/deletion before enabling persistence. No automatic LLM call, evidence upload or remediation occurs when a check fails or a user opens the inspector.

Before enablement, add positive and negative tests for monitor authorization, invalid targets/associations, denied inventory, DNS/redirect bypasses, IPv6/encoded addresses, timeouts/output/concurrency bounds, redaction and audit records. See [planned acceptance](TESTING.md#fleet-services-dashboard-acceptance-planned). These controls are requirements, not a claim that the starter already implements SSRF-safe HTTP monitoring.

## Minimum recommended network exposure

- Local development: bound Compose `3000`, `3001`, PostgreSQL `5433` to `127.0.0.1`.
- Remote production: expose only a hardened HTTPS reverse proxy (e.g. Caddy/Nginx) on 443. Proxy `/api/agents/connect` with WebSocket upgrade and long idle timeout.
- Do not publicly expose PostgreSQL or agent diagnostic interfaces.
- `COOKIE_SECURE=true` behind HTTPS; set correct `ALLOWED_ORIGIN` to public dashboard origin.

## Public design-system reference

The Next.js route `/design-system` is intentionally accessible without an admin session. It renders only authored synthetic examples and local React state: no host telemetry, incident records, credentials, provider keys, or database access. Preview validation, loading, and evidence disclosures do not call Hub APIs or save settings.

This route does not grant access to protected `/api` endpoints. Do not import server credentials or populate reference examples from live operational data. Dashboard and login UI checks using synthetic browser responses are not proof of authentication or authorization enforcement; the backend release blockers below remain unchanged.

## CI trust boundary

`.github/workflows/checks.yml` (`CI — Tests & builds`) runs untrusted pull-request code only on GitHub-hosted runners using `pull_request`, not `pull_request_target`. It requests only `contents: read`, disables persisted checkout credentials, pins third-party actions to full commit SHAs, and bounds job duration. Keep production credentials and deployment steps out of validation.

Require the `TypeScript — Tests, types & Web build` and `Go agent — Tests` checks through a protected `main` branch rule without bypasses; migrate any old `typescript`/`go` required-check selections. Successful runs alone cannot prevent unchecked merges or direct pushes. SHA pinning prevents silent tag movement, not vulnerabilities in a pinned action or dependency.

## Release and package publishing

`release.yml` accepts version-tag pushes only, verifies strict SemVer and that the tag commit belongs to `origin/main`, and reruns CI before building/publishing. Protect `main` and restrict creation/update/deletion of `v*` tags to trusted maintainers using repository rulesets. An ancestry check is not a substitute for reviewed code or protected tags; repository rules must be configured separately.

The reusable `packages.yml` additionally requires a matching tag-push context. Only its image jobs receive `packages: write`; only the final release job receives `contents: write`. Publication uses the short-lived built-in `GITHUB_TOKEN`, never production credentials, enrollment secrets, database URLs or provider keys. OCI source/revision labels link images to the repository. `.dockerignore` excludes environment secrets, Git metadata and nested local dependency/build directories; do not pass secrets as build arguments or commit them into source.

Agent archives ship SHA-256 checksums, not signatures: these detect corruption but do not establish independent publisher authenticity. Signed releases, SBOMs, digest-pinned base images and security scanning remain roadmap work. Image pushes are not atomic across components or with GitHub Release creation; a failed run may already have updated image aliases. Use reviewed versions and record deployment digests rather than relying on mutable `latest`.

GHCR visibility/access is a separate package setting; new packages default to private. Review package Actions access and visibility after first publication, and select a license before enabling public distribution. Neither a stable tag nor successful publication resolves the production blockers below. No workflow deploys the application or enables network exposure.

## Open security issues — explicit release blockers

- [ ] Add admin login rate limiting, CSRF defenses, secure cookie lifecycle / revoke-on-logout server-side.
- [ ] Introduce token rotation/revocation and device authorization management.
- [ ] Replace simplistic redaction with tested secrets/PII filtering and explicit provider-data consent.
- [ ] Introduce output sanitization and data minimization for diagnostic output before database and LLM.
- [ ] Harden HTTP response headers, TLS and authenticated reverse proxy.
- [ ] Bound CPU, memory and query work for incoming telemetry; schema validate agent messages.
- [ ] Durable per-agent backpressure, stale/offline TTL and replay protection.
- [ ] Job leases, retries, dead-letter and crash recovery.
- [ ] Database retention, backup encryption, migrations, disaster recovery.
- [ ] Dependency vulnerability scan, SAST, SBOM, pinned Docker image digest, build attestation.
- [ ] Integration tests for untrusted/compromised agent and malicious log prompt injection.

## Privacy principle

Self-hosting Hub does not imply that data stays local after an LLM request. Clicking Investigate sends bounded selected incident evidence and retrieved resolution context to the explicitly selected connection endpoint/model. Review that destination and its retention/data-processing policy before sending non-synthetic data. Connection tests send only a synthetic prompt without incident evidence.
