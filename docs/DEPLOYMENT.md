# Deployment & Operational Guide

## Development (recommended first)

1. Install current Bun, Go 1.23+, Docker Compose.
2. Copy `.env.example` to `.env` (never commit).
3. Generate Argon2id admin hash with `bun run password:hash -- "..."`; set `ADMIN_PASSWORD_HASH` and clear `ADMIN_PASSWORD`.
4. Set `SESSION_SECRET` >=32 random bytes/characters (`openssl rand -hex 32`).
5. `bun install` → `docker compose up -d db` → `bun run db:init` → `bun run dev`.
6. Visit `http://localhost:3000`, generate token, start agent.

Use `bun run dev` from **repository root** so root `.env` is loaded as intended; if launching workspaces separately, ensure environment variables are exported or pass `--env-file` explicitly.

## Full Docker Compose template (test before production)

```bash
cp .env.example .env
# Fill ADMIN_PASSWORD_HASH, SESSION_SECRET, optionally provider API keys
# Ensure ADMIN_PASSWORD empty and COOKIE_SECURE=false for localhost only.
docker compose --profile full up --build -d
```

Services: `db`, `hub`, `worker`, `web`. DB and app ports bind to loopback. For remote exposure, publish **only** reverse-proxy HTTPS endpoint, use `COOKIE_SECURE=true`, and correct `ALLOWED_ORIGIN` (public origin). The Next.js `/api` rewrite points to `http://hub:3001` inside Compose and is built with that origin. Validate reverse proxy `Upgrade` for WSS and origin policy.

## Published release assets and container images

After a successful [tagged release](DEVELOPMENT.md#publish-a-version), download the Linux agent for your architecture and check its archive before installation. The tag below is an example, not a promise that it has already been published:

```bash
version=v0.1.0-rc.1 # replace with an existing release tag
arch=amd64        # arm64 on ARM hosts
archive="opspilot-agent_${version#v}_linux_${arch}.tar.gz"
release_dir=$(mktemp -d)
gh release download "$version" --repo kuenobaikbanget/opspilot \
  --pattern "$archive" --pattern SHA256SUMS --dir "$release_dir"
(cd "$release_dir" && sha256sum --check --ignore-missing SHA256SUMS \
  && tar -xzf "$archive")
sudo install -m 0755 "$release_dir/opspilot-agent" /usr/local/bin/opspilot-agent
```

The extracted `opspilot-agent.service` and `agent.env.example` are the same templates used in the source-install instructions below. Configure the dedicated user, protected environment file and systemd unit before starting the agent. Checksums are unsigned; they verify archive integrity, not independent publisher identity.

GHCR provides `ghcr.io/kuenobaikbanget/opspilot-hub`, `opspilot-worker`, `opspilot-web` and `opspilot-agent`, each for Linux AMD64/ARM64. Use the version without `v` as the image tag, for example `ghcr.io/kuenobaikbanget/opspilot-web:0.1.0-rc.1`. Stable releases also publish mutable version aliases and `latest`; prereleases do not. Pin a reviewed image digest for deployment.

The checked-in Compose file still builds from local source. To use published images without changing its service/environment/volume configuration, add an `image: ghcr.io/kuenobaikbanget/opspilot-<component>:<version>` entry to each app service in a local Compose override, then pass that override with `-f` and use `up --no-build`. Keep PostgreSQL separate. The Web image's `/api` rewrite is built for `http://hub:3001`; preserve the `hub` service name. Changing `HUB_INTERNAL_URL` only at runtime does not rebuild that rewrite.

First publication creates packages with private visibility; private pulls require GitHub package access and registry login. Review package visibility/access deliberately before distribution. These images retain the starter's deployment/security limitations; publication is not a production-readiness guarantee.

## Binary agent installation on Ubuntu

```bash
cd agent
make build
sudo install -m 0755 bin/opspilot-agent /usr/local/bin/opspilot-agent
sudo useradd --system --home /var/lib/opspilot --shell /usr/sbin/nologin opspilot || true
sudo install -d -m 0750 -o opspilot -g opspilot /var/lib/opspilot
sudo install -d -m 0750 /etc/opspilot
sudo cp ../infra/systemd/agent.env.example /etc/opspilot/agent.env
sudo chmod 0600 /etc/opspilot/agent.env
# Edit hub URL, one-time enrollment token, allowlisted services and config files
sudo cp ../infra/systemd/opspilot-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opspilot-agent
sudo journalctl -u opspilot-agent -n 50 --no-pager
```

The dedicated `opspilot` user may not be able to read Nginx config or journal. Fix permissions **narrowly** rather than running agent as root. Once initial enrollment succeeds, remove token from `/etc/opspilot/agent.env` and restart. For remote agents **do not use plaintext HTTP**.

## Container agent

```bash
# Generate enrollment token in UI, then
OPSPILOT_ENROLL_TOKEN='<one-time-token>' \
  docker compose --profile full --profile agent up --build -d
```

This is intentionally a *limited capability* agent: `/proc` read-only mount may allow CPU/RAM/network telemetry; disk path `/` reflects container filesystem, and systemd/journal may not exist. No default Docker daemon socket mount. To monitor host disk, configure explicit read-only mount and set `OPSPILOT_DISK_PATH` to its mount point; review security implications.

## Backup / restore

- Backup DB with `pg_dump` (avoid copying mutable DB volume live).
- Protect backup encryption and verify restore in a disposable environment.
- Back up `agent` identity securely and document rotation; secret reuse after cloning hosts is dangerous.
- Config drift snapshot table only holds hashes, **not configuration backup**.

## Environment variables

Hub: `DATABASE_URL`, `PORT`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `ALLOWED_ORIGIN`, `COOKIE_SECURE`, `ALERT_*`. Worker: `DATABASE_URL`, `*_API_KEY`, `*_MODEL`, `INVESTIGATION_POLL_MS`. Web: `HUB_INTERNAL_URL` (server-side Next rewrite). Agent: `OPSPILOT_HUB_URL`, `OPSPILOT_ENROLL_TOKEN`, `OPSPILOT_AGENT_STATE_PATH`, `OPSPILOT_ALLOWED_SERVICES`, `OPSPILOT_CONFIG_FILES`, `OPSPILOT_ENABLE_DOCKER`, `OPSPILOT_PROC_ROOT`, `OPSPILOT_DISK_PATH`, `OPSPILOT_INTERVAL_SECONDS`.

## Before external deployment

- Add certificate monitoring and correct proxy WSS upgrade.
- Restrict admin dashboard to VPN/Tailscale or trusted reverse proxy until auth hardening.
- Pin container image digests, lock dependencies, scan images.
- Add disk usage alerts for PostgreSQL; enable data retention and backup validation.
- Do not place production secrets in logs sent to LLM providers without policy, consent and tested redaction.
