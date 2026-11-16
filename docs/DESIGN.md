# Technical Design — implementation specification

## Runtime & module contracts

### Hub (`apps/hub`)

Native `Bun.serve`: built-in HTTP routing and WebSockets; `Bun.SQL`: PostgreSQL pool. Endpoints are grouped conceptually into `auth`, `hosts`, `agents`, `telemetry`, `incidents`, `memory`. Starter keeps a small number of source files; refactor before adding many feature routes.

**Transport:** an agent identity is authenticated before WSS upgrade. Hub maps `agentId` to one active socket; duplicate connection supersedes prior socket. Each request gets a unique random `requestId`. A 6-second timeout bounds work. Late/unmatched diagnostic responses are discarded. Hub never permits arbitrary remote shell.

**Telemetry:** agent sends `{cpuPercent,memoryPercent,diskPercent,networkRxBytes,networkTxBytes,uptimeSeconds,configHashes}`. Hub validates percentages, inserts samples, evaluates thresholds and config hashes. Agent timestamps currently informational; Hub stores its own receipt timestamp to reduce clock skew attacks.

**Threshold rule:** 2 consecutive high samples; only 1 incident per host/category in 15 minutes. In-memory streak counters reset when Hub restarts. Replace with persistent evaluator if multi-Hub support needed.

**Config drift:** read from agent hash map, store first hash as baseline per `(agent,path)`, then compare latest. On change insert config snapshot and incident including previous/current SHA256, no contents. Future enhancement: rootless diff storage after explicit consent, file metadata, redaction and diff semantics.

### Agent (`agent/`)

Go process modes share same code. Identity file is per-agent, 0600. Telemetry uses `/proc` on Linux and `statfs`; no root required for common metrics. Optional tools implemented using `exec.CommandContext` with **constant executable and argument shape**, never `/bin/sh -c`. `service` argument checked against agent-configured allowlist. Results capped to 5.5KB and 5-second timeout.

Docker mode: host resource visibility depends on mounts/namespace; `systemctl`/journal may not work; never imply host root access from container. Binary is recommended for full Linux troubleshooting.

**Agent permissions:** test with dedicated `opspilot` user. systemd-journal file access may need a dedicated group or ACL. No `sudo` by default. Docker socket access is a highly privileged optional surface and is **disabled by default**.

### Worker (`apps/worker`)

Loop leases one queued investigation via `UPDATE ... WHERE id=(SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`. Reads server-minted evidence and human-resolved memory; calls configured provider; validates result schema and citations; marks `completed/failed`. This is a basic queue, *not* a production lease manager: a worker crash while `running` requires manual recovery. Add heartbeat/lease timeout, max retries, idempotency before release.

## Event taxonomy

- `telemetry.sampled` — authenticated, no guaranteed durability on disconnect.
- `config.snapshot.initial` — baseline, no incident.
- `config.drift.detected` — changed SHA256, incident.
- `threshold.exceeded` — 2 consecutive samples high, incident.
- `diagnostic.requested` / `.completed` / `.timeout` — request ID correlates response.
- `investigation.queued` / `.completed` / `.failed`.
- `incident.resolved` — creates searchable memory record.

Starter includes database audit events only for major admin actions, not all event types above.

## API design principles

- JSON under `/api`, admin cookie for UI routes; agents have separately authenticated enrollment and WSS.
- No provider API keys reach the browser.
- Admin-side operations require same-origin browser requests.
- Hard-bound response lists (host limit 100, incident limit 100, metrics 120, evidence 50).
- Favor `202` for async investigation, `201` on creation, `401` for unauthorized, `409` for invalid state.
- Avoid putting agent credentials or enrollment tokens in URL parameters.

## Correctness and safety notes

- Current Go tool outputs and selected metrics can contain private information. Regex redaction is a preliminary guard only. Add deployment-grade detectors, allowlists, and preview UI before third-party LLM use.
- A log entry saying "ignore previous instructions" must remain data. Provider prompt tells the model not to follow it; the guard is imperfect; validate outputs and test adversarial cases.
- Agent metrics range validation is not sufficient to defend against all malformed messages. Introduce runtime schema validation, version negotiation and backpressure.
- Agent cannot remediate servers. Operator manually resolves incidents.

## Performance & storage boundaries

- WSS max inbound 64 KiB. Incident evidence capped 6 KiB. Model context input capped. PostgreSQL initial table is not partitioned.
- Timer-driven refresh UI every 10 seconds rather than browser WebSocket for MVP.
- Start with a few agents at 15-second samples; benchmark database size and load before raising scale.
- Rotate/retain telemetry: implement e.g. 7-day raw + 90-day aggregate retention; **not implemented in starter**.

## Configuration

See `.env.example` and `infra/systemd/agent.env.example`. Every key in env files represents a deploy-time contract; do not send secret configuration to the frontend. See [Deployment](DEPLOYMENT.md).
