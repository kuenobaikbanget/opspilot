# OpsPilot

**Independent, self-hosted Linux monitoring and evidence-first AI incident investigation.**

> Stage: **development starter**, NOT production-ready. The repository is functional scaffolding with basic working flows, not a finished observability platform. See [Feature status](#feature-status) and [Security](docs/SECURITY.md).

OpsPilot is a **Bun workspaces monorepo / modular monolith**, with separately deployed components:
- **Web** — Next.js App Router dashboard, single-admin sign-in.
- **Hub** — native `Bun.serve` HTTP + WebSocket gateway, monitoring rules, CRUD, enrollment.
- **Worker** — incident investigation queue using PostgreSQL, provider adapters (OpenAI / Gemini / Anthropic).
- **Agent** — Go binary or Docker container, outbound WSS connection, telemetry, allowlisted read-only diagnostics.
- **PostgreSQL** — telemetry, incidents, evidence, config-hash snapshots, audit, resolved-incident memory.

No Redis, Kafka, Kubernetes, or automatic remediation needed to develop the MVP.

## Quickstart — local development

Requirements: Linux recommended, current stable **Bun** supporting `Bun.serve` and `Bun.SQL`, **Go 1.23+**, **Docker + Compose** for PostgreSQL, and optional Node.js 20.9+ if your local Next.js toolchain requires it.

```bash
cp .env.example .env
# Generate a password hash (do not commit it)
bun run password:hash -- "choose-a-long-admin-password"
# Edit .env: set ADMIN_PASSWORD_HASH to the printed hash; clear ADMIN_PASSWORD.
# Also generate a 32+ character SESSION_SECRET, e.g. openssl rand -hex 32
bun install --frozen-lockfile
docker compose up -d db
# DB initial schema is applied automatically on a FRESH postgres volume.
# For an existing volume / after adding migrations:
bun run db:init
bun run dev
```

Open **http://localhost:3000**. Hub health: **http://localhost:3001/healthz**.

Dependency locks (`bun.lock` and `agent/go.sum`) are committed. GitHub Actions runs Bun tests, workspace typechecks, the Next.js production build, and Linux Go tests on pushes and pull requests.

### Design system preview — no backend required

```bash
bun install --frozen-lockfile
bun run dev:web
```

Open **http://localhost:3000/design-system**. The catalog uses synthetic examples only; it needs no `.env`, PostgreSQL, Hub, admin login, or AI key. It includes semantic tokens, shared components, validation/loading/empty states, and evidence provenance patterns.

If port 3000 is occupied, run `bun run --cwd apps/web dev --port 3100` and open **http://localhost:3100/design-system**.

Visual authority: [Design system](DESIGN.md). Implementation: `apps/web/app/tokens.css` and `apps/web/components/ui.tsx`. The live dashboard consumes the same primitives. Backend technical design remains in [docs/DESIGN.md](docs/DESIGN.md).

Dashboard direction: [Fleet & services contract](docs/UI-UX.md#fleet-services-dashboard-contract-target), based on the supplied reference. Host/service tables and a contextual inspector keep agent connectivity, process state and endpoint reachability distinct. Service inventory and HTTP monitoring are planned, not shipped; see the [delivery gates](docs/ROADMAP.md#fleet-services-dashboard-delivery-planned).

### Enroll a host

1. Sign in → **Generate enrollment token**. Token expires in 10 minutes, usable once.
2. Install the Go agent locally:

```bash
cd agent
go mod download
OPSPILOT_HUB_URL=http://localhost:3001 \
OPSPILOT_ENROLL_TOKEN='<one-time-token-from-dashboard>' \
OPSPILOT_ALLOWED_SERVICES='nginx,docker,sshd' \
OPSPILOT_CONFIG_FILES='/etc/nginx/nginx.conf' \
go run ./cmd/opspilot-agent
```

Go agent stores a credential file at `~/.local/share/opspilot-agent/identity.json` with mode 0600. After enrollment it ignores the enrollment token on subsequent runs. See `infra/systemd` and `infra/docker` for deployment templates. Use **HTTPS/WSS** for remote agents; `http://localhost` is for local-only development.

### Run first investigation

1. Set one or more AI API keys in `.env` (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`). **Bring Your Own Key is server-side environment configuration** in this scaffold; there is no web-based secret manager yet.
2. Restart Hub and Worker after `.env` changes.
3. In dashboard, create a manual incident on a connected host.
4. Select a configured provider → **Investigate**. The Hub requests safe diagnostic evidence from agent, enqueues a job, Worker generates validated JSON diagnosis.
5. Add a human-verified resolution → **Mark resolved**. The resolution becomes searchable under **Incident memory** and can be retrieved by subsequent investigations.

### Try config drift

If `OPSPILOT_CONFIG_FILES` includes a readable, regular file, the agent sends its SHA-256 hash. First sample establishes a baseline. Subsequent different hashes create a `config_drift` incident, without transferring file contents.

## Run all backend services in Compose (experimental template)

Set `ADMIN_PASSWORD_HASH` and a long `SESSION_SECRET` in `.env`, then:

```bash
docker compose --profile full up --build -d
# dashboard on http://localhost:3000; Hub API on localhost:3001
```

For the optional containerized agent, generate an enrollment token first, then:

```bash
OPSPILOT_ENROLL_TOKEN='<one-time-token>' docker compose --profile full --profile agent up --build -d
```

The container agent intentionally has narrower host visibility than a properly permissioned Linux binary. No Docker daemon socket is mounted by default; container monitoring is disabled. Full Compose build is **not verified in this artifact environment**; test in your development machine before relying on it.

## Feature status

| Capability | Starter status | Caveat |
| --- | --- | --- |
| Single-admin login | Implemented baseline | Needs rate limiting / deployment hardening |
| Agent enrollment + WSS | Implemented baseline | Needs credential rotation and revocation UI |
| CPU / memory / disk / network | Implemented baseline | Linux `/proc` sampling; no TSDB |
| Threshold incidents | Implemented baseline | 2-sample rule, 15-minute database cooldown |
| Config drift | Implemented baseline | SHA-256 change detection only, not semantic diffs |
| Diagnostic tool dispatch | Implemented baseline | 5 allowlisted tools; no arbitrary shell |
| AI providers BYOK | Implemented baseline | env-based keys; model IDs configurable; live API not tested |
| Structured diagnoses | Implemented baseline | schema check + evidence ID validation |
| Incident memory | Implemented baseline | PostgreSQL FTS, not pgvector RAG yet |
| Incident resolution | Implemented baseline | manual resolution, no auto-remediation |
| Cross-server RCA / robust reconnect backfill | Planned | not implemented |
| Metrics retention / downsampling | Planned | must be added before long-term use |
| Fleet & services dashboard / workload inventory / HTTP checks | Host-only slice implemented; inventory/HTTP checks planned | typed host totals, searchable table, inspector and timestamped CPU history; no workload or endpoint collection |
| Hardened production release | Not ready | see threat model |

## Repository documents

- [PRD](docs/PRD.md) — problem, audience, scope, acceptance criteria.
- [Folder structure](docs/FOLDER_STRUCTURE.md) — module ownership and directory tree.
- [Architecture](docs/ARCHITECTURE.md) — deployment, data/agent/AI diagrams.
- [Technical design](docs/DESIGN.md) — module design and responsibilities.
- [Database](docs/DATABASE.md) — schema and retention strategy.
- [API & agent protocol](docs/API.md) — endpoints, payloads and message contract.
- [AI design](docs/AI-DESIGN.md) — providers, prompts, safety, evaluation, memory.
- [Security](docs/SECURITY.md) — trust boundaries and shipping blockers.
- [UI/UX](docs/UI-UX.md) — implemented screens plus the approved Fleet & services target, reference image and behavior contract.
- [Design system](DESIGN.md) — implemented UI tokens/component APIs and target dashboard composition; interactive primitive catalog at `/design-system`.
- [Deployment](docs/DEPLOYMENT.md) — binary, Compose, reverse proxy.
- [Development](docs/DEVELOPMENT.md) — day-to-day workflows.
- [Testing](docs/TESTING.md) — tests, incident fixtures, validation checklist.
- [Validation](docs/VALIDATION.md) — what was / was not verified when generating the ZIP.
- [Roadmap](docs/ROADMAP.md) — milestone plan and definition of done.
- [ADRs](docs/adr/) — architectural trade-offs.

## Design priorities

1. **No arbitrary remote shell**. The Hub sends enumerated read-only operations; Agent validates them again.
2. **Evidence before AI**. Rules and telemetry collection work without external LLM APIs.
3. **Local-first deployment**. Users own PostgreSQL, agent credentials, retention, and logs.
4. **Honest diagnosis**. LLM must cite stored evidence IDs, report missing evidence, avoid unsupported certainty.
5. **No secret exfiltration**. The starter redacts common patterns, but this is not complete secret detection; do not feed sensitive production logs to third-party LLMs until controls are tested.

### Licensing
No license selected yet. Choose and add a license before public distribution; absence of a license is not an invitation for redistribution.
