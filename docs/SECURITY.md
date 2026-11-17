# Security & Threat Model

**Status:** MVP starter. **Do not expose this as a public production service without implementing the release blockers below.**

## Threats / trust boundaries

| Boundary | Risks | Current baseline | Required hardening |
|---|---|---|---|
| Browser → Hub | password guessing, CSRF, session theft | signed 8-hour HttpOnly SameSite=Strict cookie; checks Origin for POST | rate limit, CSRF token, login lockout, security headers, TLS proxy |
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
- API keys belong **only to Hub/Worker environment**; no client-side key storage.
- Agent identity secret stored 0600 on host or in protected Docker volume; remote use HTTPS/WSS.
- Host lists/history remain behind the existing admin cookie; enrollment token creation retains the existing Origin check, one-use token and audit path. The live inspector performs no diagnostics, outbound probe, LLM call or remediation. Workload/endpoint unavailability never implicitly enables Docker or shell access.
- The host dashboard's 60-second telemetry freshness label is a display policy, not a transport heartbeat or replay defense. `Online` means a socket is currently registered in this single Hub; silent network partitions still require transport TTL hardening. Enrollment tokens must not enter persistent browser storage, URLs, screenshots or logs; the admin-only enrollment view clears them on sign-out/expiry.
- An agent with Docker group membership often has root-equivalent power; never assume `docker.sock:ro` is safe just because the mount says `ro`.

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

`.github/workflows/checks.yml` runs untrusted pull-request code only on GitHub-hosted runners using `pull_request`, not `pull_request_target`. It requests only `contents: read`, disables persisted checkout credentials, pins third-party actions to full commit SHAs, and bounds job duration. Keep production credentials and deployment steps out of this CI-only workflow.

Require the `typescript` and `go` checks through a protected `main` branch rule without bypasses; successful workflow runs alone cannot prevent unchecked merges or direct pushes. SHA pinning prevents silent tag movement, not vulnerabilities in a pinned action or dependency. CI does not replace the release blockers below.

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

Self-hosting Hub does not imply that data stays local after an LLM request. When admin clicks Investigate and uses OpenAI/Gemini/Anthropic, selected evidence is sent to that external provider. Document provider retention and data processing before using non-synthetic production incident data.
