# Repository / Folder Structure

```text
opspilot/
├── README.md
├── package.json                 # Bun workspaces + developer scripts
├── .env.example                 # No real secrets
├── compose.yaml                 # Local DB / optional full stack
├── apps/
│   ├── web/
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx         # Dashboard, login, incidents, memory
│   │   │   └── globals.css
│   │   ├── next.config.ts       # /api reverse-proxy rewrite to Hub
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── hub/
│   │   ├── src/
│   │   │   ├── index.ts         # HTTP router and Bun.serve WebSocket
│   │   │   ├── auth.ts          # Signed admin cookie
│   │   │   ├── db.ts            # Bun.SQL connection + audit
│   │   │   ├── agents.ts        # Enrollment, WSS sessions, diagnostics
│   │   │   └── incidents.ts     # Thresholds, config drift, evidence
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── worker/
│       ├── src/index.ts         # Bounded sequential job runner
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── contracts/
│   │   └── src/index.ts         # Shared wire types + validators
│   └── ai/
│       └── src/index.ts         # OpenAI/Anthropic/Gemini adapters
├── agent/
│   ├── cmd/opspilot-agent/main.go
│   ├── internal/agent/
│   │   ├── agent.go             # Enrollment, /proc metrics, safe tools
│   │   └── agent_test.go
│   ├── go.mod
│   └── Makefile
├── infra/
│   ├── db/001_init.sql
│   ├── docker/Dockerfile.{hub,worker,web,agent}
│   └── systemd/{opspilot-agent.service,agent.env.example}
├── tools/
│   ├── migrate.ts
│   └── hash-password.ts
├── tests/contracts.test.ts
├── docs/
│   ├── PRD.md, ARCHITECTURE.md, DESIGN.md, UI-UX.md
│   ├── DATABASE.md, API.md, AI-DESIGN.md, SECURITY.md
│   ├── DEPLOYMENT.md, DEVELOPMENT.md, TESTING.md, ROADMAP.md
│   ├── FOLDER_STRUCTURE.md
│   ├── adr/0001-bun-native-hub.md
│   ├── adr/0002-agent-pull-wss.md
│   ├── adr/0003-postgres-first-memory.md
│   └── runbooks/incident-502.md
└── .github/workflows/checks.yml
```

## Boundaries and ownership

- `web` never receives provider API keys, agent secrets or direct DB credentials. It requests `/api/*` from Hub via Next rewrite.
- `hub` performs authentication, rate/size admission, agent identity validation and state mutation; it **does not** directly call the external LLM.
- `worker` only leases queued investigations and reads already-collected evidence. It never has direct reachability to agent WS sessions.
- `agent` uses fixed tools; no arbitrary command registry or plugin execution in starter.
- `contracts` own wire types, public interfaces and validated enum values. Keep circular dependencies out.
- `ai` own provider-specific request formats, evidence citations, redaction, schema checks; it must not import HTTP server internals.
- `infra` owns packaging/deployment; `docs` own decisions and acceptance criteria.

## Evolving the structure

When modules grow, split hub's `index.ts` routes into `src/modules/{auth,hosts,incidents,agents,telemetry}/routes.ts`, put SQL in repositories, and add `packages/db` for typed queries/migrations. Do **not** introduce microservices merely to create more folders. A source directory is not a deployment unit.
