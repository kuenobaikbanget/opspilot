# API & Agent Protocol (starter contract)

Hub API root: `http://localhost:3001` in local dev; Web uses the Next.js `/api` rewrite. JSON endpoints require **admin HttpOnly cookie** (unless `DISABLE_AUTH=true` in non-production; refused at startup in production, with `ALLOWED_ORIGIN` still enforced), except agent enrollment, WebSocket agent connect, and `/healthz`.

## Admin HTTP routes

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `{"password":"..."}` | `200` sets signed cookie |
| POST | `/api/auth/logout` | none | `200` clears cookie |
| GET | `/api/auth/me` | none | role, auth status, and `authDisabled` flag |
| POST | `/api/agents/enrollment-token` | `{}` | `{token, expiresInSeconds}`; show once |
| GET | `/api/agents/install-config` | none | `{hubUrl,installerUrl,version,repository}` or `503 {"error":"Agent installation is not configured"}` |
| GET | `/api/hosts` | none | `{hosts,total,online,limit,observed_at,stale_after_seconds,thresholds}` |
| GET | `/api/hosts/:id/metrics` | none | last ≤120 raw samples descending; 400 invalid ID, 404 unknown host |
| GET | `/api/hosts/:id/services` | none | selected-host `HostSystemdStatus`; 400 invalid ID, 404 unknown host |
| GET | `/api/services` | none | `{endpoints}` (existing independent endpoint records) |
| GET | `/api/ai/providers` | none | `{providers: AiProvider[], encryptionConfigured: boolean}` |
| POST | `/api/ai/providers` | `{name,protocol,baseUrl,apiKey,defaultModel,enabled}` | `201 {provider}` |
| PATCH | `/api/ai/providers/:id` | subset of create fields, at least one | `200 {provider}` |
| DELETE | `/api/ai/providers/:id` | none | `200 {ok:true}`; reports preserved |
| POST | `/api/ai/providers/:id/test` | `{}` | `202 {id,providerId,status:"queued"}` |
| GET | `/api/incidents` | none | last 100 incidents |
| POST | `/api/incidents` | `{"agentId":"uuid","title":"..."}` | `201 {id}` |
| GET | `/api/incidents/:id` | none | `{incident,evidence,investigations}` |
| POST | `/api/incidents/:id/investigate` | `{"providerId":"uuid","providerRevision":1,"model":"explicit-model"}` | `202 {id,status,liveAgent}` |
| POST | `/api/incidents/:id/resolve` | `{"resolution":"..."}` | `200 {ok:true}` |
| GET | `/api/memory?q=text` | none | searchable resolved incidents |
| GET | `/healthz` | none | `{ok,db}` |

### Stored AI connections

Protocols are `openai-compatible`, `anthropic`, and `gemini`; UUID identity is independent of protocol. Several connections may share a protocol. The old `{provider}` investigation payload is rejected.

All provider mutations and investigate require an admin cookie and an Origin exactly equal to `ALLOWED_ORIGIN` (missing/cross-origin: `403 {error:"Forbidden origin",code:"forbidden_origin"}`). Body-bearing AI requests require JSON objects, no arrays, at most 16 KiB UTF-8; wrong content type is 415, excessive size 413, invalid/unknown fields 400. Responses retain no-store/nosniff. Unauthenticated requests retain `401 {error:"Unauthorized"}`.

Names trim to 1–80 characters, models 1–200, URLs at most 2048, and API keys 1–4096 with no internal whitespace/control characters. Create requires all fields. PATCH omits `apiKey` to retain the credential; an empty key is invalid. Changing normalized base URL or protocol requires a replacement key. Actual changes increment revision; identical PATCH without a key does not. No DTO contains a key or encrypted envelope.

`AiProvider` includes `id,name,protocol,baseUrl,defaultModel,enabled,revision,hasApiKey,createdAt,updatedAt,lastTest`. Dates are ISO strings; ordering is createdAt/id, with at most 100 connections. Base URL is the HTTPS API root, not an operation URL. Saving performs static public-target validation, not DNS/auth/model testing.

`lastTest` is null or `{id,revision,model,status,errorCode,httpStatus,requestedAt,startedAt,completedAt,expiresAt}`. Status is queued/running/completed/failed. A single 90-second slot includes Worker queue time; expired active slots project as failed/provider_timeout on GET without mutation. Only an explicit test sends a synthetic generation prompt; no incident evidence is used. Completed means that model/configuration passed then, not perpetual health. A revision mismatch is not tested for the current configuration.

AI errors use `{error,code}` with fixed messages and no input/upstream content. State codes: `invalid_request`, `provider_unavailable` (404), `provider_disabled`, `provider_changed`, `test_in_progress`, `provider_limit` (409), and `credential_unavailable` (503). Transport codes: `invalid_endpoint`, `endpoint_not_public`, `dns_failed`, `provider_timeout`, `provider_response_too_large`, `provider_invalid_response`, `provider_network`, `provider_redirect`, `provider_http`, `provider_configuration`. HTTP failures expose only status. Missing/malformed master disables AI mutations/execution but metadata, monitoring and health remain available.

Investigations validate the browser revision before diagnostics and recheck under a row lock before queueing. Worker rejects changed/disabled/deleted connections rather than silently using another destination. Incident detail reports `provider:{id:string|null,name,protocol,baseUrl:string|null,model:string|null}` from an immutable non-secret snapshot, never current connection metadata. Legacy model/base URL remain null. Deleting a connection removes credentials, not historical reports; unstarted jobs fail safely.

### Installation metadata and public script

`AgentInstallConfig` contains the canonical HTTPS `hubUrl`, `${hubUrl}/api/agents/install.sh` as `installerUrl`, exact pinned release `version` and GitHub `repository`. The Hub reads `OPSPILOT_PUBLIC_HUB_URL`, `OPSPILOT_AGENT_VERSION` and optional `OPSPILOT_AGENT_REPOSITORY` (default `kuenobaikbanget/opspilot`); see [validation and deployment prerequisites](DEPLOYMENT.md#curl-based-headless-linux-installation). No browser, Host/Forwarded header, `ALLOWED_ORIGIN` or `HUB_INTERNAL_URL` inference is used. Missing/invalid configuration disables dashboard generation with 503, not monitoring or the manual token API. Reading metadata issues no token.

Public `GET /api/agents/install.sh` needs no admin session and returns static Bash bytes with `Content-Type: text/x-shellscript; charset=utf-8`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Other methods return 405 with `Allow: GET`; a missing asset is a server error. It contains no token, request interpolation, network fetch or DB mutation.

Token issuance remains an authenticated, Origin-protected POST with `{token,expiresInSeconds:600}` and existing audit behavior. Tokens are usable once; hiding a command or generating another does not revoke them. The dashboard downloads the complete script into a private temporary file before invoking Bash as root (sudo when needed), not `curl | sudo bash`.

### Host monitoring read model

`Host`, `HostList` and `HostMetric` live in `packages/contracts`. The host list contains at most 100 newest enrolled hosts; `total` and `online` cover the entire enrolled fleet, not the visible page or client search. Connectivity comes from this Hub's current WebSocket connections, not persisted status. These counts are not application-health verdicts.

Each host includes `id`, `hostname`, `version`, `status`, `created_at`, `last_seen_at`, `sampled_at` and nullable `cpu_percent`, `memory_percent`, `disk_percent`. Timestamps are ISO strings; sample timestamps are Hub receipt times. Missing samples remain null. `observed_at` dates the list response; it does not refresh old measurements.

The current display freshness policy is `stale_after_seconds: 60`. An online connection with an older sample has stale telemetry; a disconnected agent's retained samples are historical even when recent. Agents configured with intervals above 60 seconds will intentionally show stale between samples; interval negotiation is not implemented.

`thresholds` contains the Hub's effective CPU, memory and disk alert limits as percent values under `cpu_percent`, `memory_percent`, and `disk_percent`. Invalid limits are `null` and do not produce a threshold alert. The Overview uses the same configured limits to compare individual fresh online samples; its near-limit band is a display rule, not an incident trigger.

History returns `sampled_at`, host CPU/memory/disk percentages and cumulative `network_rx_bytes`/`network_tx_bytes`; counters are not network rates. Samples are neither aggregated nor interpolated.

`HostSystemdStatus` returns `{agent_id,online,checked_at,report,service}`. `report` is null until an accepted v1 report; otherwise it has `{status,observed_at,current}`. `service` is null until there is an actual observation, or a `HostService` with `runtime:"systemd"`, `source:"agent_systemd"` and `freshness:"fresh"|"stale"`. `fresh` requires a measured report from the current authenticated socket and an observation at most 60 seconds old. `checked_at` is the read time, not the observation time. Disconnect/replacement or a current collection error can make a previous sample stale without changing its observed state/time. An explicit disabled report or change of configured unit removes the previous unit from the selected-host view. Synthetic `host_services` rows are excluded.

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

**Enrollment:** `POST /api/agents/enroll` requires short-lived one-use token, browser `Origin` disallowed. Returns `agentId`, `agentSecret` (random secret stored only as hash in DB).

`opspilot-agent enroll` is a finite local command using the same `{token,hostname,version}` / `{agentId,agentSecret}` contract, not a new HTTP operation. It requires an HTTPS origin, refuses redirects, validates returned credentials and atomically saves a 0600 identity. A valid existing identity avoids enrollment; a corrupt identity fails unchanged. No arguments retains the reconnecting monitor and local HTTP development compatibility.

**WebSocket handshake:** `GET /api/agents/connect` with headers:

```
Authorization: Bearer <agentSecret>
X-OpsPilot-Agent-ID: <uuid>
```

The Hub verifies the hashed secret before upgrading. Use WSS behind TLS in remote deployment. Avoid HTTP on an untrusted network.

### Agent → Hub telemetry

```json
{
  "type": "telemetry", "timestamp": "2026-11-15T07:00:00Z",
  "cpuPercent": 17.2, "memoryPercent": 42.5, "diskPercent": 68.4,
  "networkRxBytes": 123456, "networkTxBytes": 56789, "uptimeSeconds": 93450,
  "configHashes": {"/etc/nginx/nginx.conf":"<64 lowercase hex characters>"}
}
```

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

Starter wire version is implicit 0.1; add `protocolVersion` on enrollment and every message before broad distribution. Refuse incompatible versions rather than silently misinterpreting metrics. Add explicit error codes, pagination and documented JSON Schema/OpenAPI in future.

## API failure semantics

`400` invalid input, `401` admin/agent unauthorized, `403` forbidden browser origin, `404` missing resource, `409` state conflict, `500` unexpected error, `503` installation metadata unavailable / LLM not configured / DB failed health. Never return provider keys to clients.

<a id="fleet-services-contract-boundary-planned"></a>

## Fleet & services contract boundary (planned)

The current host list provides typed host observations and full-fleet enrolled/connected counts. The host-scoped systemd read adds one opted-in process observation; broader runtime inventory, per-workload resources, OS/capacity metadata, scheduled probe results, endpoint aggregate totals and configurable alert-policy metadata are outside this slice.

Before implementing those surfaces, define validated read/write schemas for the [planned read models](BACKEND-DESIGN.md#fleet-services-data-boundary-planned), including stable host/workload/endpoint associations, source and collection/check timestamps, stale/unknown/unavailable reasons, units and list/aggregate coverage. Independently fresh probe results must survive an agent disconnect without becoming a fabricated host-health verdict.

Endpoint creation/editing must require admin authorization, same-origin mutation protection, bounded validated HTTP(S) target/expected-response/schedule inputs and audit. Probe execution is server-side and subject to the [SSRF/egress policy](SECURITY.md#planned-inventory-and-endpoint-monitoring), not a browser fetch, an arbitrary shell command or an LLM-selected URL.

Any agent wire change must update `packages/contracts`, the Go agent, this document and interoperability/negative tests together; unsupported capabilities must render unavailable rather than silently inventing inventory.
