# Test & Validation Plan

## Current repo tests

```bash
bun test
bun run typecheck
(cd agent && go test ./...)
```

`tests/contracts.test.ts` tests tool enum, metric bounds, and redaction smoke tests. `agent/internal/agent/agent_test.go` checks basic parsing/redaction/WS URL. These tests are **not** a substitute for integration, security, and AI evaluation.

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

## Incident benchmark fixture list (future)

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

## Environment limitation of generated archive

The ZIP was generated in an environment without Bun/Docker and with no outbound package registry access. **Bun install, Next build, full Compose boot, Go module download and live LLM calls could not be executed here.** Syntax and structure were reviewed with locally available static tools only. Treat this as a developer scaffold requiring a first-machine smoke test, not a verified release binary.
