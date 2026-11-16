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
- An agent with Docker group membership often has root-equivalent power; never assume `docker.sock:ro` is safe just because the mount says `ro`.

## Agent tool policy

Tools are fixed in source code:

1. `disk_usage` → `df -h` on agent-configured path.
2. `listening_ports` → `ss -lnt` (can expose internal service metadata).
3. `service_status` → `systemctl is-active <allowlisted service>`.
4. `recent_logs` → `journalctl -u <allowlisted service> -n 50`.
5. `docker_status` → `docker ps`, **agent flag required**, no docker socket mount in default Compose.

No arbitrary URL fetch, filesystem read, or shell script tool is permitted. Add filesystem restrictions before broad deployment.

## Minimum recommended network exposure

- Local development: bound Compose `3000`, `3001`, PostgreSQL `5433` to `127.0.0.1`.
- Remote production: expose only a hardened HTTPS reverse proxy (e.g. Caddy/Nginx) on 443. Proxy `/api/agents/connect` with WebSocket upgrade and long idle timeout.
- Do not publicly expose PostgreSQL or agent diagnostic interfaces.
- `COOKIE_SECURE=true` behind HTTPS; set correct `ALLOWED_ORIGIN` to public dashboard origin.

## Public design-system reference

The Next.js route `/design-system` is intentionally accessible without an admin session. It renders only authored synthetic examples and local React state: no host telemetry, incident records, credentials, provider keys, or database access. Preview validation, loading, and evidence disclosures do not call Hub APIs or save settings.

This route does not grant access to protected `/api` endpoints. Do not import server credentials or populate reference examples from live operational data. Dashboard and login UI checks using synthetic browser responses are not proof of authentication or authorization enforcement; the backend release blockers below remain unchanged.

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
