# API & Agent Protocol (starter contract)

Hub API root: `http://localhost:3001` in local dev; Web uses the Next.js `/api` rewrite. JSON endpoints require **admin HttpOnly cookie**, except agent enrollment, WebSocket agent connect, and `/healthz`.

## Admin HTTP routes

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `{"password":"..."}` | `200` sets signed cookie |
| POST | `/api/auth/logout` | none | `200` clears cookie |
| GET | `/api/auth/me` | none | role and auth status |
| POST | `/api/agents/enrollment-token` | `{}` | `{token, expiresInSeconds}`; show once |
| GET | `/api/hosts` | none | `{hosts,total,online,limit,observed_at,stale_after_seconds}` |
| GET | `/api/hosts/:id/metrics` | none | last ≤120 raw samples descending; 400 invalid ID, 404 unknown host |
| GET | `/api/ai/providers` | none | `{available:["openai",...]}` no secrets |
| GET | `/api/incidents` | none | last 100 incidents |
| POST | `/api/incidents` | `{"agentId":"uuid","title":"..."}` | `201 {id}` |
| GET | `/api/incidents/:id` | none | `{incident,evidence,investigations}` |
| POST | `/api/incidents/:id/investigate` | `{"provider":"openai"}` | `202 {id,status,liveAgent}` |
| POST | `/api/incidents/:id/resolve` | `{"resolution":"..."}` | `200 {ok:true}` |
| GET | `/api/memory?q=text` | none | searchable resolved incidents |
| GET | `/healthz` | none | `{ok,db}` |

### Host monitoring read model

`Host`, `HostList` and `HostMetric` live in `packages/contracts`. The host list contains at most 100 newest enrolled hosts; `total` and `online` cover the entire enrolled fleet, not the visible page or client search. Connectivity comes from this Hub's current WebSocket connections, not persisted status. These counts are not application-health verdicts.

Each host includes `id`, `hostname`, `version`, `status`, `created_at`, `last_seen_at`, `sampled_at` and nullable `cpu_percent`, `memory_percent`, `disk_percent`. Timestamps are ISO strings; sample timestamps are Hub receipt times. Missing samples remain null. `observed_at` dates the list response; it does not refresh old measurements.

The current display freshness policy is `stale_after_seconds: 60`. An online connection with an older sample has stale telemetry; a disconnected agent's retained samples are historical even when recent. Agents configured with intervals above 60 seconds will intentionally show stale between samples; interval negotiation is not implemented.

History returns `sampled_at`, host CPU/memory/disk percentages and cumulative `network_rx_bytes`/`network_tx_bytes`; counters are not network rates. Samples are neither aggregated nor interpolated. Workload inventory, endpoint monitoring and alert-policy metadata remain unavailable.

Example agent install / Hub interaction:

```bash
# Sign in via dashboard to receive HttpOnly cookie
# Dashboard > Generate enrollment token
curl -X POST http://localhost:3001/api/agents/enroll \
  -H 'content-type: application/json' \
  -d '{"token":"ONE_TIME_TOKEN","hostname":"my-linux","version":"0.1.0"}'
# Returns agentId & agentSecret ONCE. Do not put these in logs or URLs.
```

## Agent HTTP and WebSocket

**Enrollment:** `POST /api/agents/enroll` requires short-lived one-use token, browser `Origin` disallowed. Returns `agentId`, `agentSecret` (random secret stored only as hash in DB).

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

`400` invalid input, `401` admin/agent unauthorized, `403` forbidden browser origin, `404` missing resource, `409` state conflict, `500` unexpected error, `503` LLM not configured / DB failed health. Never return provider keys to clients.

<a id="fleet-services-contract-boundary-planned"></a>

## Fleet & services contract boundary (planned)

The current host list provides typed host observations and full-fleet enrolled/connected counts. It and the diagnostic messages do **not** provide structured workload inventory, per-workload resources, OS/capacity metadata, endpoint configuration/results, probe metadata, endpoint aggregate totals or configurable alert-policy metadata.

Before implementing those surfaces, define validated read/write schemas for the [planned read models](DESIGN.md#fleet-services-data-boundary-planned), including stable host/workload/endpoint associations, source and collection/check timestamps, stale/unknown/unavailable reasons, units and list/aggregate coverage. Independently fresh probe results must survive an agent disconnect without becoming a fabricated host-health verdict.

Endpoint creation/editing must require admin authorization, same-origin mutation protection, bounded validated HTTP(S) target/expected-response/schedule inputs and audit. Probe execution is server-side and subject to the [SSRF/egress policy](SECURITY.md#planned-inventory-and-endpoint-monitoring), not a browser fetch, an arbitrary shell command or an LLM-selected URL.

This host slice changes only HTTP read models; agent messages and diagnostic tools are unchanged. Any subsequent agent wire change must update `packages/contracts`, the Go agent, this document and interoperability/negative tests together; unsupported capabilities must render unavailable rather than silently inventing inventory.
