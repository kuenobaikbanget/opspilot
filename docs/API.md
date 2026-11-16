# API & Agent Protocol (starter contract)

Hub API root: `http://localhost:3001` in local dev; Web uses the Next.js `/api` rewrite. JSON endpoints require **admin HttpOnly cookie**, except agent enrollment, WebSocket agent connect, and `/healthz`.

## Admin HTTP routes

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `{"password":"..."}` | `200` sets signed cookie |
| POST | `/api/auth/logout` | none | `200` clears cookie |
| GET | `/api/auth/me` | none | role and auth status |
| POST | `/api/agents/enrollment-token` | `{}` | `{token, expiresInSeconds}`; show once |
| GET | `/api/hosts` | none | `[{id,hostname,status,cpu_percent,...}]` |
| GET | `/api/hosts/:id/metrics` | none | last 120 samples descending |
| GET | `/api/ai/providers` | none | `{available:["openai",...]}` no secrets |
| GET | `/api/incidents` | none | last 100 incidents |
| POST | `/api/incidents` | `{"agentId":"uuid","title":"..."}` | `201 {id}` |
| GET | `/api/incidents/:id` | none | `{incident,evidence,investigations}` |
| POST | `/api/incidents/:id/investigate` | `{"provider":"openai"}` | `202 {id,status,liveAgent}` |
| POST | `/api/incidents/:id/resolve` | `{"resolution":"..."}` | `200 {ok:true}` |
| GET | `/api/memory?q=text` | none | searchable resolved incidents |
| GET | `/healthz` | none | `{ok,db}` |

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
