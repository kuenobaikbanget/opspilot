# API & Agent Protocol (starter contract)

Hub API root: `http://localhost:3001` in local dev; Web uses the Next.js `/api` rewrite. JSON endpoints require **admin HttpOnly cookie** (unless `DISABLE_AUTH=true` in non-production; refused at startup in production, with `ALLOWED_ORIGIN` still enforced), except agent enrollment, WebSocket agent connect, and `/healthz`.

## Admin HTTP routes

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `{"password":"..."}` | `200` sets signed cookie |
| POST | `/api/auth/logout` | none | `200` clears cookie |
| GET | `/api/auth/me` | none | role, auth status, and `authDisabled` flag |
| POST | `/api/agents/enrollment-token` | `{}` | `{token, expiresInSeconds}`; show once |
| GET | `/api/agents/install-config` | none | `AgentInstallConfig` or `503 {"error":"Agent installation is not configured"}` |
| GET | `/api/hosts` | none | `{hosts,total,online,limit,observed_at,stale_after_seconds,thresholds}`; each host includes `protocol_version` and negotiated `capabilities` |
| GET | `/api/hosts/:id/metrics` | none | last ≤120 raw samples descending; optional `from`/`to` (ISO, ≤366d span), `resolution=auto|raw|hourly` (auto uses hourly rollups beyond the raw retention window), `limit=1..2000`; 400 invalid params/ID, 404 unknown host |
| GET | `/api/hosts/:id/thresholds` | none | `{thresholds,conditions}` — effective per-host limits and persisted alert condition state; 400/404 as above |
| PUT | `/api/hosts/:id/thresholds` | `{cpu_percent?,memory_percent?,disk_percent?}` each null or 0-100 | `200 {thresholds}`; resets that host's condition state; audited |
| DELETE | `/api/hosts/:id/thresholds` | none | `200 {thresholds}` back to environment defaults; audited |
| GET | `/api/hosts/:id/services` | none | selected-host `HostSystemdStatus`; 400 invalid ID, 404 unknown host |
| GET | `/api/hosts/:id/workloads` | none | host-scoped `HostWorkloads`; 400 invalid ID, 404 unknown host |
| GET | `/api/workloads` | none | fleet `WorkloadList`; totals/counts cover the whole fleet, not the capped page |
| GET | `/api/services` | none | `{endpoints: EndpointMonitor[]}` with per-monitor `run_counts` |
| POST | `/api/endpoints` | `{name,targetUrl,expectedStatus?,agentId?,serviceName?,checkIntervalSeconds?,enabled?}` | `201 {endpoint}`; `400 invalid_request`/`invalid_target` (SSRF policy), 404 unknown host |
| PATCH | `/api/endpoints/:id` | subset of create fields, at least one | `200 {endpoint}`; same validation; audits `endpoint.updated` |
| DELETE | `/api/endpoints/:id` | none | `200 {ok:true}`; run history cascades; audits `endpoint.deleted` |
| POST | `/api/endpoints/:id/check` | none | `200 {endpoint}` after a bounded server-side probe; persists a run; audits `endpoint.probe` |
| GET | `/api/endpoints/:id/runs` | none | `{runs: EndpointMonitorRun[], limit: 50}` newest first |
| GET | `/api/ai/providers` | none | `{providers: AiProvider[], encryptionConfigured: boolean}` |
| POST | `/api/ai/providers` | `{name,protocol,baseUrl,apiKey,defaultModel,enabled}` | `201 {provider}` |
| PATCH | `/api/ai/providers/:id` | subset of create fields, at least one | `200 {provider}` |
| DELETE | `/api/ai/providers/:id` | none | `200 {ok:true}`; reports preserved |
| POST | `/api/ai/providers/:id/test` | `{}` | `202 {id,providerId,status:"queued"}` |
| GET | `/api/incidents` | none | last 100 incidents |
| POST | `/api/incidents` | `{"agentId":"uuid","title":"..."}` | `201 {id}` |
| GET | `/api/incidents/:id` | none | `{incident,evidence,investigations}`; each investigation also exposes `attempts,max_attempts,next_retry_at,lease_expires_at` and `retrieved_memories` (bounded `InvestigationMemoryAttribution[]` snapshot persisted by the Worker, `null` for legacy/active rows) |
| POST | `/api/incidents/:id/investigate` | `{"providerId":"uuid","providerRevision":1,"model":"explicit-model"}` | `202 {id,status,deduplicated,liveAgent}`; an active (queued/running) investigation with the same incident+provider+revision+model returns that row with `deduplicated:true` |
| POST | `/api/incidents/:id/resolve` | `{"resolution":"...","embeddingConsent"?:boolean}` | `200 {ok:true,memoryId,deduplicated,occurrenceCount}`; the resolution is redacted, fingerprinted and deduplicated against canonical memories inside one transaction; `embeddingConsent: true` is the strict opt-in that sets `embedding_consent = TRUE` on the canonical memory row (any other value keeps the default `false`) |
| GET | `/api/drift` | none | `{entries,limit,observed_at}` drift timeline (newest first); optional `agentId` (uuid), `filePath` (absolute path ≤256 chars), `limit` 1..100 (default 100); 400 invalid params |
| GET | `/api/drift/:id` | none | `DriftDetailResponse` with redacted semantic diff; 400 invalid id, 404 unknown id |
| GET | `/api/changes?agentId=&kind=&limit=` | none | `{changes: ChangeEvent[], limit}` newest first, `limit` 1-100 (default 50), `kind` one of `deployment|config_change|service_restart|maintenance`; each row includes the host `hostname` |
| POST | `/api/changes` | `{"agentId":"uuid","kind":"deployment","title":"...","serviceName"?,"version"?,"summary"?,"source"?,"occurredAt"?}` | `201 {change}`; `title`/`summary` redacted server-side before storing; `occurredAt` ISO bounded to ≤5m future / ≤365d past (default NOW()); audited as `change.recorded` with non-secret fields only; 404 unknown host |
| GET | `/api/incidents/:id/timeline?beforeMinutes=&afterMinutes=` | none | `IncidentTimelineResponse` (see below); window defaults 120m before to 30m after `incident.created_at`, `beforeMinutes` 5-1440, `afterMinutes` 0-720 |
| POST | `/api/incidents/:id/changes` | `{"targetType":"change_event|config_snapshot","targetId":"uuid","action":"link|dismiss","note"?}` | `201` new link / `200` upsert `{link}`; target must belong to the same host as the incident (`409 cross_host` otherwise); audited as `incident.change_linked` / `incident.change_dismissed` |
| DELETE | `/api/incidents/:id/changes/:linkId` | none | `200 {ok:true}`; removes a manual link/dismissal; audited as `incident.change_unlinked`; 404 unknown link |
| GET | `/api/memory?q=text` | none | canonical memories only (`canonical_memory_id IS NULL`; merged duplicates are never returned), max 20; each record carries BOTH the dedup provenance (`occurrence_count`, `last_confirmed_at`, `content_fingerprint`, `sources[]` from `incident_memory_sources`) AND the hybrid retrieval metadata (`retrieval_method`, `fts_score`, `vector_score`, `hybrid_score`, `embedding_model`); optional `q` full-text search (vector leg fused via RRF when an embedding is available) |
| GET | `/healthz` | none | `{ok,db}` |

### Change events and the unified incident timeline (implemented)

`GET /api/incidents/:id/timeline` merges, newest first, the incident lifecycle (`incident_opened`, `incident_resolved`), the incident's evidence (preview redacted and capped at 240 chars), its investigations, and same-host change context: `config_snapshots` inside the window that are an initial observation or a checksum change (with `previous_checksum_sha256` from the prior snapshot of the same file), plus `change_events` inside the window — each also included when manually linked, even outside the window, and hidden when dismissed. Every change entry carries `offset_seconds` relative to `incident.created_at`, `relation` (`observed_nearby` or `operator_linked`), `link_id`, and `causation_claimed: false`; the response includes `causation_notice` ("Nearby deployments and configuration changes are temporal context only. Correlation does not establish root cause.") and `dismissed_count`. Only rows belonging to the incident's `agent_id` are ever included. All five routes sit behind the admin cookie; mutations additionally require the exact `ALLOWED_ORIGIN` and write non-secret `audit_events`.
| POST | `/api/memory/merge` | `{"sourceMemoryId":"uuid","targetMemoryId":"uuid"}` | `200 {ok:true,memory}`; merges source into target, preserving all `incident_memory_sources`, recomputing `occurrence_count`; `400` invalid/self-merge, `404` unknown id, `409` non-canonical; audited as `memory.merged` |
| GET | `/healthz` | none | `{ok,db}` |

### Incident memory deduplication, hybrid retrieval and provenance

Resolving an incident stores one canonical `incident_memory` row per distinct root cause/fix, not one per incident. `POST /api/incidents/:id/resolve` redacts the title/resolution, computes a SHA-256 `content_fingerprint` over the normalized text, and matches against recent canonical memories (`canonical_memory_id IS NULL`): an exact fingerprint match or a near-duplicate (normalized token Jaccard similarity on the resolution ≥ 0.85) increments `occurrence_count`, refreshes `last_confirmed_at` and appends the incident to `incident_memory_sources` — contributing incidents are never dropped. Otherwise a new canonical memory is created. Audits `memory.created` / `memory.deduplicated` carry only non-secret IDs and counts.

`POST /api/memory/merge` moves all source-provenance rows from the source memory into the target (`ON CONFLICT DO NOTHING`), marks the source non-canonical (`canonical_memory_id = target`), recomputes the target's `occurrence_count` from distinct source incidents and its `last_confirmed_at` via `GREATEST(...)`, and audits `memory.merged`. Both memory routes sit behind the admin cookie; mutating requests additionally require `Origin` exactly equal to `ALLOWED_ORIGIN` (`403 forbidden_origin` otherwise, `401` unauthenticated).

Retrieval is hybrid and canonical-only: `GET /api/memory` (and the Worker's prior-memory lookup via `searchIncidentMemories`) always runs bounded FTS and additionally fuses vector candidates with RRF when a query embedding is available, but only over rows with `canonical_memory_id IS NULL`, so merged duplicates are never returned by FTS or vector/hybrid search. The Worker deduplicates exact/near-duplicate candidates before the LLM call, and persists the bounded attribution snapshot (`memory_id`, summary, resolution preview, occurrence count, source incident IDs, retrieval method, score, last confirmed) as `investigations.retrieved_memories_json` when the investigation completes; `GET /api/incidents/:id` returns it as `retrieved_memories` on each investigation. Prior memory is fallible human-confirmed context, displayed separately from measured signals and AI hypotheses in the UI.

### Stored AI connections

Protocols are `openai-compatible`, `anthropic`, and `gemini`; UUID identity is independent of protocol. Several connections may share a protocol. The old `{provider}` investigation payload is rejected.

All provider mutations and investigate require an admin cookie and an Origin exactly equal to `ALLOWED_ORIGIN` (missing/cross-origin: `403 {error:"Forbidden origin",code:"forbidden_origin"}`). Body-bearing AI requests require JSON objects, no arrays, at most 16 KiB UTF-8; wrong content type is 415, excessive size 413, invalid/unknown fields 400. Responses retain no-store/nosniff. Unauthenticated requests retain `401 {error:"Unauthorized"}`.

Names trim to 1–80 characters, models 1–200, URLs at most 2048, and API keys 1–4096 with no internal whitespace/control characters. Create requires all fields. PATCH omits `apiKey` to retain the credential; an empty key is invalid. Changing normalized base URL or protocol requires a replacement key. Actual changes increment revision; identical PATCH without a key does not. No DTO contains a key or encrypted envelope.

`AiProvider` includes `id,name,protocol,baseUrl,defaultModel,enabled,revision,hasApiKey,createdAt,updatedAt,lastTest`. Dates are ISO strings; ordering is createdAt/id, with at most 100 connections. Base URL is the HTTPS API root, not an operation URL. Saving performs static public-target validation, not DNS/auth/model testing.

`lastTest` is null or `{id,revision,model,status,errorCode,httpStatus,requestedAt,startedAt,completedAt,expiresAt}`. Status is queued/running/completed/failed. A single 90-second slot includes Worker queue time; expired active slots project as failed/provider_timeout on GET without mutation. Only an explicit test sends a synthetic generation prompt; no incident evidence is used. Completed means that model/configuration passed then, not perpetual health. A revision mismatch is not tested for the current configuration.

AI errors use `{error,code}` with fixed messages and no input/upstream content. State codes: `invalid_request`, `provider_unavailable` (404), `provider_disabled`, `provider_changed`, `test_in_progress`, `provider_limit` (409), and `credential_unavailable` (503). Transport codes: `invalid_endpoint`, `endpoint_not_public`, `dns_failed`, `provider_timeout`, `provider_response_too_large`, `provider_invalid_response`, `provider_network`, `provider_redirect`, `provider_http`, `provider_configuration`. HTTP failures expose only status. Missing/malformed master disables AI mutations/execution but metadata, monitoring and health remain available.

Investigations validate the browser revision before diagnostics and recheck under a row lock before queueing. Worker rejects changed/disabled/deleted connections rather than silently using another destination. Incident detail reports `provider:{id:string|null,name,protocol,baseUrl:string|null,model:string|null}` from an immutable non-secret snapshot, never current connection metadata. Legacy model/base URL remain null. Deleting a connection removes credentials, not historical reports; unstarted jobs fail safely.

### Installation metadata and public script

`AgentInstallConfig` includes `mode`, `hubUrl`, exact pinned release `version`, and GitHub `repository`. The Hub reads `OPSPILOT_PUBLIC_HUB_URL`, `OPSPILOT_AGENT_VERSION` and optional `OPSPILOT_AGENT_REPOSITORY` (default `kuenobaikbanget/opspilot`). No browser, Host/Forwarded header, `ALLOWED_ORIGIN` or `HUB_INTERNAL_URL` inference is used. Missing/invalid configuration disables dashboard generation with 503, not monitoring or the manual token API. Reading metadata issues no token.

- `mode: "https"` uses the canonical HTTPS `hubUrl` and includes `installerUrl: "${hubUrl}/api/agents/install.sh"`.
- `mode: "loopback-development"` has no `installerUrl`. It requires `OPSPILOT_DEV_LOOPBACK_INSTALL=true` and exact `NODE_ENV=development`. The raw `hubUrl` must be `http://127.0.0.1`, optionally with a decimal port (1–65535, no leading zero) and/or one terminal slash. The origin port must equal the Hub's actual listening port; no port means 80. The Hub binds to `127.0.0.1` with the development opt-in, and strips the terminal slash from metadata. See [same-machine setup](DEPLOYMENT.md#same-machine-http-development).

Public `GET /api/agents/install.sh` needs no admin session. With valid HTTPS configuration, it returns the packaged Bash installer with the validated deployment origin, pinned tag and repository embedded as literal shell values. It responds with `Content-Type: text/x-shellscript; charset=utf-8`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Missing, invalid or loopback-only settings return 503; an unavailable installer template returns 500. Other methods return 405 with `Allow: GET`. The response contains no token, accepts no header or query overrides, and does not fetch release assets or mutate the database.

Token issuance remains an authenticated, Origin-protected POST with `{token,expiresInSeconds:600}` and existing audit behavior. Tokens are usable once; hiding a command or generating another does not revoke them. HTTPS mode pipes the Hub-configured installer straight into Bash — `curl -q -fsSL --proto '=https' --connect-timeout 10 -m 120 '<hubUrl>/api/agents/install.sh' | bash -s -- --token '<token>'` — never `curl | sudo bash`. The installer wraps its executable body in `main() { … }` and invokes `main "$@"` only on its final line, so a partial or truncated transfer fails as a Bash syntax error before anything runs. The script validates its inputs and, when nonroot, re-executes itself through sudo only if sudo grants root; a piped run has no readable `$0`, so it serializes the configured installer into a private mode-0600 temporary script next to the mode-0600 token handoff file and removes both on exit or signal, keeping the token out of sudo's arguments and standard input. It then selects the pinned `amd64` or `arm64` archive using `uname` on the target host, not the browser. Development mode downloads only GitHub release assets over HTTPS; it runs the verified binary without arguments or privilege escalation. Enrollment and WebSocket message formats are unchanged.

### Host monitoring read model

`Host`, `HostList` and `HostMetric` live in `packages/contracts`. The host list contains at most 100 newest enrolled hosts; `total` and `online` cover the entire enrolled fleet, not the visible page or client search. Connectivity comes from this Hub's current WebSocket connections, not persisted status. These counts are not application-health verdicts.

Each host includes `id`, `hostname`, `version`, `protocol_version` (null until the agent reports a hello), negotiated `capabilities`, `status`, `created_at`, `last_seen_at`, `sampled_at` and nullable `cpu_percent`, `memory_percent`, `disk_percent`. Timestamps are ISO strings; sample timestamps are Hub receipt times. Missing samples remain null. `observed_at` dates the list response; it does not refresh old measurements.

The current display freshness policy is `stale_after_seconds: 60`. An online connection with an older sample has stale telemetry; a disconnected agent's retained samples are historical even when recent. Agents configured with intervals above 60 seconds will intentionally show stale between samples; interval negotiation is not implemented.

`thresholds` in the list contains the Hub's global environment limits as percent values under `cpu_percent`, `memory_percent`, and `disk_percent`. Invalid limits are `null` and do not produce a threshold alert. The Overview uses the same configured limits to compare individual fresh online samples; its near-limit band is a display rule, not an incident trigger. Per-host overrides are managed with the thresholds API below and survive Hub restarts in `alert_thresholds`; `GET /api/hosts/:id/thresholds` also returns the persisted `alert_conditions` state (`ok`/`breaching`/`breached`/`cooldown` per metric with breach streak, cooldown deadline and incident link). Changing or resetting thresholds resets that host's condition state.

History returns `sampled_at`, host CPU/memory/disk percentages and cumulative `network_rx_bytes`/`network_tx_bytes`; counters are not network rates. Without query parameters samples are neither aggregated nor interpolated. With `from`/`to`, `resolution=raw` returns raw rows in the range; `resolution=hourly` returns one row per hour from `metric_samples_hourly` (percentages are hour averages, network counters are the last sample in the hour) — `auto` selects hourly once the span exceeds the raw retention window (`METRIC_RAW_RETENTION_HOURS`, default 168h).

`HostSystemdStatus` returns `{agent_id,online,checked_at,report,service}`. `report` is null until an accepted v1 report; otherwise it has `{status,observed_at,current}`. `service` is null until there is an actual observation, or a `HostService` with `runtime:"systemd"`, `source:"agent_systemd"` and `freshness:"fresh"|"stale"`. `fresh` requires a measured report from the current authenticated socket and an observation at most 60 seconds old. `checked_at` is the read time, not the observation time. Disconnect/replacement or a current collection error can make a previous sample stale without changing its observed state/time. An explicit disabled report or change of configured unit removes the previous unit from the selected-host view. Synthetic `host_services` rows are excluded.

`HostWorkloads` returns `{agent_id,online,checked_at,collection,workloads,counts}`. `collection` is null until an accepted v1 inventory report; otherwise `{status,reason,skipped,observed_at,current}` where `status` is `ok`/`disabled`/`unsupported`/`unavailable`, `reason` is a fixed enum present only on `unavailable` (optional on `unsupported`), `skipped` lists enabled collectors that failed during an otherwise ok report, and `current` means the report came from the current authenticated socket and is at most 120 seconds old. `workloads` are `Workload` rows with `source:"agent_workloads"`, nullable `cpu_percent`/`memory_bytes` and `freshness:"fresh"|"stale"` (fresh only when the collection is current and `ok`). `counts` covers only that host's workloads. `checked_at` is the read time.

`GET /api/workloads` returns `WorkloadList`: at most 200 newest `Workload` rows fleet-wide, with `total` and `counts` computed over all fleet workload rows (not the capped page), `hosts_total`/`hosts_online` over the entire enrolled fleet, `hosts_collecting` counting hosts whose latest report is `ok`, fresh and from their current socket, plus `limit`, `observed_at` and `stale_after_seconds: 120`. A successful empty scan (`ok` with `workloads: []`) removes the host's rows; `disabled`/`unsupported`/`unavailable` also remove them and keep only the collection status, so a failure is never presented as a measured empty fleet. Workload state is a process/container observation, not endpoint availability.

Example agent install / Hub interaction:

```bash
# Sign in via dashboard to receive HttpOnly cookie
# Manual clients: POST /api/agents/enrollment-token with the admin cookie to obtain a token.
curl -X POST http://localhost:3001/api/agents/enroll \
  -H 'content-type: application/json' \
  -d '{"token":"ONE_TIME_TOKEN","hostname":"my-linux","version":"0.1.0"}'
# Returns agentId & agentSecret ONCE. Do not put these in logs or URLs.
```

## Agent HTTP and WebSocket

**Enrollment:** `POST /api/agents/enroll` requires short-lived one-use token, browser `Origin` disallowed. Body is `{token,hostname,version,protocolVersion?,capabilities?}`; `protocolVersion` must be an integer 1..2 (default 1) and `capabilities` a deduplicated subset of `telemetry`, `systemd_status`, `diagnostics`, `config_diffs` — unknown names reject the whole request with 400. Returns `agentId`, `agentSecret` (random secret stored only as hash in DB).

`opspilot-agent enroll` is a finite local command using the same `{token,hostname,version,protocolVersion,capabilities}` / `{agentId,agentSecret}` contract, not a new HTTP operation. It requires an HTTPS origin, refuses redirects, validates returned credentials and atomically saves a 0600 identity. A valid existing identity avoids enrollment; a corrupt identity fails unchanged. No arguments retains the reconnecting monitor and local HTTP development compatibility. The running agent buffers telemetry durably in a bounded on-disk queue (`OPSPILOT_QUEUE_PATH`, default beside the identity file; caps `OPSPILOT_QUEUE_MAX_ENTRIES` default 2000 and `OPSPILOT_QUEUE_MAX_AGE_SECONDS` default 86400) and flushes it in order on reconnect.

**WebSocket handshake:** `GET /api/agents/connect` with headers:

```
Authorization: Bearer <agentSecret>
X-OpsPilot-Agent-ID: <uuid>
```

The Hub verifies the hashed secret before upgrading. Use WSS behind TLS in remote deployment. Avoid HTTP on an untrusted network.

**Hello / capability negotiation:** immediately after connecting, an agent sends one hello frame:

```json
{"type":"hello","protocolVersion":2,"agentVersion":"0.1.0","capabilities":["telemetry","systemd_status","diagnostics"]}
```

The Hub rejects a `protocolVersion` above its own `PROTOCOL_VERSION` (2) with close code `4000`. Otherwise it records the agent version, protocol version and the negotiated intersection on the `agents` row and replies:

```json
{"type":"hello_ack","protocolVersion":2,"capabilities":["telemetry","systemd_status","diagnostics"]}
```

Agents treat a missing ack (older Hub) as "all advertised capabilities supported". The agent only sends collectors the ack included. Hello is optional for legacy agents; their `protocol_version` stays at the enrollment value and `capabilities` at the enrollment set.

### Agent → Hub telemetry

```json
{
  "type": "telemetry", "timestamp": "2026-11-15T07:00:00Z",
  "cpuPercent": 17.2, "memoryPercent": 42.5, "diskPercent": 68.4,
  "networkRxBytes": 123456, "networkTxBytes": 56789, "uptimeSeconds": 93450,
  "configHashes": {"/etc/nginx/nginx.conf":"<64 lowercase hex characters>"}
}

The Hub accepts only this exact shape (`parseTelemetry` in `packages/contracts`): `timestamp` must be canonical UTC RFC 3339 (`Z`, optional 1-3 digit fraction) at most 120 seconds old and 5 seconds ahead of Hub time; `cpuPercent`/`memoryPercent`/`diskPercent` must be finite numbers in [0, 100] (NaN/Inf rejected); `networkRxBytes`/`networkTxBytes`/`uptimeSeconds` must be non-negative safe integers; `configHashes` is an object of at most 20 entries mapping absolute paths (≤256 chars) to 64 lowercase hex characters. Any extra or missing key, or an out-of-bounds value, drops the whole frame silently. Queued agent samples are re-stamped at send time so reconnect flushes stay within the window.


### Agent → Hub systemd status v1

Separate optional frame on the same authenticated socket at connection and every 15 seconds. Older agents may send telemetry only; older Hubs can ignore the new message. No Hub message configures or triggers this collector.

```json
{"type":"systemd_status","version":1,"observedAt":"2026-11-19T12:00:00.123Z","status":"observed","unit":"nginx.service","state":"running"}
```

| `status` | Fields beyond `type`, `version`, `observedAt`, `status` |
|---|---|
| `observed` | Exactly one literal `unit` and `state` (`running`, `stopped`, `failed`, `unknown`) |
| `disabled` | None; explicit empty configuration, not a zero count from a scan |
| `unsupported` | `unit` only; systemd system manager or executable absent |
| `unavailable` | Optional `unit`; read failed or configuration is invalid. Never a process state |

Maximum 512 UTF-8 bytes; no extra keys or unit arrays. Unit names are case-sensitive ASCII, begin with a letter or digit, use only letters, digits, `_`, `.`, `@` or `-`, end with `.service`, and are at most 80 characters. `observedAt` is UTC RFC 3339 with three fractional digits, taken at collection completion (or when recording disabled/unavailable), at most 120 seconds past or 5 seconds ahead of Hub time. Equal/older timestamps and malformed or unsupported versions are ignored; telemetry remains independent. Host identity comes only from the current authenticated socket.

`observed` requires `LoadState=loaded`. `ActiveState=active`, `reloading` and `refreshing` map to `running` (systemd's active unit status, not a guarantee of a running PID); `inactive` maps to `stopped`, and `failed` maps to `failed`. Known transition states map to `unknown`. Missing units, denied/failed queries and unrecognized properties are unavailable, not `stopped`. The Hub admits at most one in-flight status write per host; periodic reports do not queue or block metrics.

### Agent → Hub workload inventory v1

Separate optional frame on the same authenticated socket at connection and every 60 seconds. The collectors are opt-in per agent (`OPSPILOT_WORKLOADS_DOCKER`, `OPSPILOT_WORKLOADS_SYSTEMD`, both default false); no Hub message configures, triggers or names inventory targets. Older agents may send telemetry only; older Hubs can ignore the new message. This frame is not derived from `docker_status` diagnostic output.

```json
{"type":"workload_inventory","version":1,"observedAt":"2026-11-26T12:00:00.123Z","status":"ok","workloads":[{"name":"web","runtime":"docker","state":"running","cpuPercent":1.5,"memoryBytes":67108864},{"name":"nginx.service","runtime":"systemd","state":"stopped"}],"skipped":["systemd"]}
```

| `status` | Fields beyond `type`, `version`, `observedAt`, `status` |
|---|---|
| `ok` | Exactly `workloads` (array of 0–64 entries) plus optional `skipped`; at least one enabled collector measured |
| `disabled` | None; no collector was opted in — an explicit capability statement, not a zero count |
| `unsupported` | Optional `reason`; the enabled runtime is absent on the host (no docker CLI / no systemd manager) |
| `unavailable` | Required `reason`; every enabled collector failed. Never a process state |

Each entry has exactly `name`, `runtime` (`docker`|`systemd`), `state` (`running`|`stopped`|`failed`|`unknown`) and optional nullable `cpuPercent` (finite, 0–25600) and `memoryBytes` (safe integer ≥ 0); resource fields are docker stats only and are null/absent for systemd units. Docker names are 1–128 chars starting alphanumeric with `[A-Za-z0-9_.-]`; systemd names are literal `.service` units per the systemd v1 rules. `(runtime,name)` pairs must be unique. `reason` is one of `docker_cli_missing`, `docker_daemon_unreachable`, `systemd_manager_missing`, `permission_denied`, `command_failed`, `command_timeout`, `output_overflow`. `skipped` lists at most the two collector names that failed during an ok report.

Maximum 16 KiB UTF-8 per frame (well below the 64 KiB WS limit); no extra keys. `observedAt` follows the same canonical UTC millisecond rule and ±120s/+5s clock window as systemd v1. Equal/older timestamps are ignored; the Hub admits at most one in-flight inventory write per host and identity comes only from the current authenticated socket. A `disabled`/`unsupported`/`unavailable` report removes the host's persisted `agent_workloads` rows; only `ok` (including an empty array) writes rows.

### Agent → Hub config snapshot v1

Optional, strictly opt-in frame on the same authenticated socket. The agent advertises the `config_diffs` capability only when the local operator sets `OPSPILOT_CONFIG_DIFFS=true` (default `false`); the Hub negotiates it like any other capability, and agents that never advertise it keep hash-only drift tracking. The agent sends a `config_snapshot` frame on connect and whenever the SHA-256 of an allowlisted file changes (checked every 15 s), only for absolute paths already listed in the agent-local `OPSPILOT_CONFIG_FILES` allowlist (max 20 files). The Hub never requests file paths; there is no generic file-read or shell tool.

```json
{"type":"config_snapshot","version":1,"observedAt":"2026-11-26T12:00:00.123Z","filePath":"/etc/app/settings.env","checksumSha256":"<64 lowercase hex>","status":"redacted_snapshot","format":"dotenv","contentRedacted":"WORKERS=4\nPASSWORD=[REDACTED]\n","truncated":false,"redactionCount":1}
```

```json
{"type":"config_snapshot","version":1,"observedAt":"2026-11-26T12:00:00.123Z","filePath":"/etc/app/blob.bin","checksumSha256":"<64 lowercase hex>","status":"hash_only","unavailableReason":"binary_or_unreadable"}
```

| `status` | Fields beyond `type`, `version`, `observedAt`, `filePath`, `checksumSha256`, `status` |
|---|---|
| `redacted_snapshot` | Exactly `format` (`dotenv`\|`ini`\|`json`\|`yaml`\|`nginx`\|`text`), `contentRedacted` (≤16 KiB UTF-8), `truncated`, `redactionCount` (safe integer 0..100000) |
| `hash_only` | Exactly `unavailableReason` (`disabled`, `not_allowlisted`, `not_regular_file`, `too_large`, `binary_or_unreadable`, `unreadable`) |

The Hub accepts only this exact shape (`parseConfigSnapshot` in `packages/contracts`): whole frame ≤32 KiB (`MAX_CONFIG_SNAPSHOT_BYTES`, below the 64 KiB WS limit), no unknown keys, absolute `filePath` ≤256 chars without control characters, 64 lowercase hex checksum, canonical UTC millisecond `observedAt` within ±120 s/+5 s, and the active authenticated socket identity. Malformed frames are dropped silently; telemetry remains independent.

Agent-side local validation before reading: `os.Lstat` must confirm a regular file (symlinks, directories, devices and FIFOs are rejected and never followed), files >64 KiB are hash-only (`too_large`; hash-only tracking up to 1 MiB continues unchanged), and binary files (NUL bytes or invalid UTF-8) are `binary_or_unreadable` — raw binary is never transmitted. Secrets are redacted **on the agent before sending** (Bearer/Basic/Digest tokens; `password`/`passwd`/`pwd`/`api_key`/`token`/`secret` assignments; `*_PASSWORD`/`*_SECRET`/`*_KEY`/`*_TOKEN` env/INI keys; AWS `AKIA`/`ASIA`; GitHub `gh[pousr]_`/`github_pat_`; PEM private key blocks; Slack `xox*`; `sk-` keys; JWTs; URL userinfo `scheme://user:pass@host`), content is truncated cleanly at 16 KiB, and `redactionCount` reports how many secrets were replaced.

The Hub re-runs `redact()` on all received content before storing or diffing (agent redaction is never trusted alone), deduplicates against the telemetry-inserted row with the identical latest checksum, links `previous_snapshot_id`, computes a bounded redacted semantic diff when a prior redacted snapshot exists, and attaches a redacted `config_diff` evidence item to a matching open `config_drift` incident. All drift output states that config changes are **correlated, not proven causal**.

### Drift timeline HTTP reads

`GET /api/drift` returns `{entries,limit,observed_at}` where each entry has `id`, `agent_id`, `hostname`, `file_path`, `previous_snapshot_id`, `previous_checksum_sha256`, `checksum_sha256`, `diff_status` (`hash_only`|`diff_available`|`unavailable`), `unavailable_reason`, `diff_summary`, `redaction_count`, `content_format`, `content_truncated`, `change_counts` (`{added,removed,modified}`), `incident_id` and `captured_at`. `GET /api/drift/:id` adds `observed_at`, `content_redacted` and `semantic_diff_json` (`{format,summary,changes[],unifiedDiff,addedLines,removedLines,truncated}`); it never exposes unredacted content. Both routes require the admin session (401 unauthenticated, 400 invalid UUID, 404 unknown id).

### Hub → Agent diagnostic request

```json
{"type":"diagnostic_request","requestId":"uuid","tool":"service_status","service":"nginx"}
```

Allowed tools: `service_status`, `recent_logs` (both require allowlisted `service`), `listening_ports`, `disk_usage`, `docker_status` (disabled unless explicitly enabled at agent).

### Agent → Hub diagnostic result

```json
{"type":"diagnostic_result","requestId":"uuid","tool":"service_status","ok":true,"content":"active"}
```

Hub stores server-generated evidence ID; response correlated to an outstanding request and agent identity, size-limited; unmatched results dropped. No Hub-supplied executable names, filesystem paths, or arbitrary command arguments in the diagnostic request.

## Versioning policy

Wire protocol is versioned with `PROTOCOL_VERSION` (currently 2) in `packages/contracts`. Agents report it with `protocolVersion` on enrollment and in the `hello` frame; the Hub refuses newer agents with close code `4000` rather than silently misinterpreting frames, and negotiates capabilities as the intersection of advertised and supported sets. `systemd_status` frames carry their own `version: 1`. Future incompatible changes bump `PROTOCOL_VERSION` and refuse older/newer peers explicitly; error codes, pagination and JSON Schema/OpenAPI remain future work.

## API failure semantics

`400` invalid input, `401` admin/agent unauthorized, `403` forbidden browser origin, `404` missing resource, `409` state conflict, `500` unexpected error, `503` installation metadata unavailable / LLM not configured / DB failed health. Never return provider keys to clients.

<a id="fleet-services-contract-boundary-planned"></a>

## Fleet & services contract boundary (planned)

The current host list provides typed host observations and full-fleet enrolled/connected counts. The host-scoped systemd read adds one opted-in process observation, and the opt-in workload inventory above adds bounded typed Docker/systemd rows with source timestamps, capability/unavailable reasons, a 120-second stale policy and fleet-scoped aggregate counts. Endpoint monitors are implemented as described below. OS/capacity metadata and broader alert-policy metadata remain outside this slice.

### Endpoint monitors (implemented)

`EndpointMonitor` (in `packages/contracts`) carries `id`, `agent_id`, `service_name`, `name`, `target_url`, `expected_status`, `probe_location`, `enabled`, `check_interval_seconds`, `run_counts: {total,up,down}`, and `last_status` (`up|down|unknown`), `last_http_status`, `last_latency_ms`, `last_error`, `last_checked_at` (ISO). `run_counts` are aggregate run counts scoped to that one monitor via `monitor_id`, never fleet-wide. `probe_location` is the server-side named probe origin (`OPSPILOT_PROBE_LOCATION`, default `hub-local`), never client-supplied.

Create/patch payloads are structurally validated (`parseCreateEndpointMonitorRequest` / `parseUpdateEndpointMonitorRequest`): `name` 1–80 chars, `targetUrl` ≤2048, `expectedStatus` integer 100–599 (default 200), `agentId` UUID or null, `serviceName` ≤80 or null, `checkIntervalSeconds` integer 15–86400 (default 60), `enabled` boolean (default true). The target URL additionally passes `validateEndpointTargetUrl` SSRF/egress validation (http/https only, no credentials/fragment; private, loopback, link-local, CGNAT, multicast, reserved, metadata and IPv4-mapped/NAT64 IPv6 destinations rejected), returning `400 {error, code:"invalid_target"}` otherwise. Non-production `OPSPILOT_ALLOW_LOOPBACK_PROBES=true` permits loopback targets for local development only.

Probe execution is server-side only (`packages/ai/src/endpoint-probe.ts`): DNS answers are all validated and the socket pinned to one approved address (DNS-rebinding defense), redirects are followed manually up to 5 hops with full re-validation per hop, total timeout 5 s / connect 3 s, headers ≤16 KiB, body read ≤256 KiB and never stored, TLS verification cannot be disabled. Run outcomes use fixed error codes: `blocked_target`, `dns_blocked`, `redirect_blocked`, `redirect_limit`, `timeout`, `connection_failed`, `http_<status>`, `tls_verification_disabled`. Each execution is persisted as an `EndpointMonitorRun` (`id`, `monitor_id`, `probe_location`, `status`, `http_status`, `latency_ms`, `error`, `started_at`, `finished_at`, `created_at` ISO timestamps), bounded to 200 rows per monitor; `last_*` on the monitor mirrors the newest run. The Worker scheduler claims at most 8 due enabled monitors per tick (`FOR UPDATE SKIP LOCKED`, per-monitor interval). All routes require the admin cookie; mutations also require exact `ALLOWED_ORIGIN` and are audited as `endpoint.created`/`endpoint.updated`/`endpoint.deleted`/`endpoint.probe` with no target URL in audit data. Probe execution is subject to the [SSRF/egress policy](SECURITY.md#planned-inventory-and-implemented-endpoint-monitoring), not a browser fetch, an arbitrary shell command, a generic URL-fetch tool or an LLM-selected URL. Independently fresh probe results survive an agent disconnect without becoming a fabricated host-health verdict.

Any agent wire change must update `packages/contracts`, the Go agent, this document and interoperability/negative tests together; unsupported capabilities must render unavailable rather than silently inventing inventory.
