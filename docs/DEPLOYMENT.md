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

**Current prerequisite (2026-11-18): GitHub has no published releases.** After merge, publish a reviewed release containing the new finite `opspilot-agent enroll` command and both architecture archives before configuring curl onboarding. Never use an older incompatible release or treat an example tag as an available installation. Publication is a deliberate maintainer action, not part of running the installer.

After a successful [tagged release](DEVELOPMENT.md#publish-a-version), archives are named `opspilot-agent_VERSION_linux_amd64.tar.gz` and `opspilot-agent_VERSION_linux_arm64.tar.gz` (VERSION omits the tag's leading `v`). Each contains `opspilot-agent`, `opspilot-agent.service` and `agent.env.example`; `SHA256SUMS` accompanies them. Checksums verify integrity under HTTPS/GitHub trust, not independent publisher authentication.

GHCR provides `ghcr.io/kuenobaikbanget/opspilot-hub`, `opspilot-worker`, `opspilot-web` and `opspilot-agent`, each for Linux AMD64/ARM64. Use the version without `v` as the image tag, for example `ghcr.io/kuenobaikbanget/opspilot-web:0.1.0-rc.1`. Stable releases also publish mutable version aliases and `latest`; prereleases do not. Pin a reviewed image digest for deployment.

The checked-in Compose file still builds from local source. To use published images without changing its service/environment/volume configuration, add an `image: ghcr.io/kuenobaikbanget/opspilot-<component>:<version>` entry to each app service in a local Compose override, then pass that override with `-f` and use `up --no-build`. Keep PostgreSQL separate. The Web image's `/api` rewrite is built for `http://hub:3001`; preserve the `hub` service name. Changing `HUB_INTERNAL_URL` only at runtime does not rebuild that rewrite.

First publication creates packages with private visibility; private pulls require GitHub package access and registry login. Review package visibility/access deliberately before distribution. These images retain the starter's deployment/security limitations; publication is not a production-readiness guarantee.

## Curl-based headless Linux installation

Configure the **Hub server environment**, then restart Hub:

| Variable | Requirement |
|---|---|
| `OPSPILOT_PUBLIC_HUB_URL` | Explicit HTTPS origin reachable and trusted by target hosts; host and optional port only, no credentials, nonroot path, query or fragment. A trailing `/` is canonicalized away. |
| `OPSPILOT_AGENT_VERSION` | Exact existing reviewed release tag `vMAJOR.MINOR.PATCH`, optionally a valid SemVer prerelease; no build metadata or `latest`. Must contain the new `enroll` command. |
| `OPSPILOT_AGENT_REPOSITORY` | Optional safe GitHub `owner/repository`, default `kuenobaikbanget/opspilot`; not a URL or arbitrary download host. |

These values are never inferred from browser location, Host/Forwarded headers, `ALLOWED_ORIGIN` or `HUB_INTERNAL_URL`. Missing/invalid settings yield 503 from authenticated `/api/agents/install-config` and disable dashboard generation, not monitoring or manual token issuance. Syntax validation is not a release-availability check; the Hub does not query GitHub at runtime. Ensure the public proxy serves `/api/*` and WSS with valid trusted TLS.

Target prerequisites: Linux with **systemd actually running**, amd64 (`x86_64`/`amd64`) or arm64 (`aarch64`/`arm64`), root or sudo, CA trust, `/usr/sbin/nologin`, and `bash`, `curl`, `tar`, `sha256sum`, `install`, `cmp`, `mktemp`, `systemctl`, `useradd`, `groupadd`, `getent`, `runuser`, `env`, `chown`, `chmod` and standard coreutils. No Go toolchain, checkout, browser or inbound agent port is needed. Dependencies are not installed automatically; no Docker/journal group access is granted.

Sign in → **Enroll host**, review the configured Hub/release, generate and copy the command, SSH to the intended host and paste unchanged. The command fully downloads the public static installer into a private temporary file before running Bash, using sudo only when nonroot. It never pipes curl into a privileged shell. HTTPS-only downloads retain certificate checks and have 10-second connect / 120-second total timeouts.

**The command contains a one-time token and may remain in shell history, the clipboard and process arguments.** It expires after 10 minutes and is usable once. Hiding, closing or creating another command does not revoke earlier tokens or erase external copies. Do not share it, log it or include it in screenshots.

The installer verifies exactly one matching SHA-256 entry and exactly the three expected regular archive files before installation mutations. It rejects symlink targets. It installs:

| Location | Ownership / mode |
|---|---|
| `/usr/local/bin/opspilot-agent` | root / 0755 |
| `/etc/opspilot/agent.env` | root / 0600, root-owned directory 0750 |
| `/etc/systemd/system/opspilot-agent.service` | root / 0644 |
| `/var/lib/opspilot` | dedicated `opspilot` user/group / 0700 |
| `/var/lib/opspilot/identity.json` | `opspilot` / atomic 0600 |

Finite enrollment runs as `opspilot`; the transient token is absent from the env file and unit and is unset after enrollment. The sandboxed nonroot unit is enabled and started only after enrollment succeeds, to survive SSH logout and reboot. Its explicit `StateDirectoryMode=0700` preserves private directory permissions when systemd prepares state at each start. An existing account must be nonroot with primary group `opspilot`; its memberships/home/shell are not changed.

Only missing files are installed. Same-version reruns require existing binary/unit/env to be byte-identical; conflicts stop with `Existing OpsPilot installation differs; refusing to overwrite`. There is no upgrade, force or uninstall mode. Never remove an existing identity to retry: a valid saved identity is reused without consuming a new token, while a corrupt one fails unchanged. Interrupted installs retain identity/files and remove only private download temporaries.

If enrollment fails, the installer does not start the service. If the Hub consumed a token but the response/identity was lost, obtain a fresh dashboard token; there is no fabricated recovery or automatic orphan-record deletion. For startup failures use `sudo systemctl status opspilot-agent` and `sudo journalctl -u opspilot-agent` without dumping secret-bearing environment. Local `is-active` success is not WSS proof: verify the host is **Online** and has recent, increasing measurements in the dashboard.

## Manual binary agent installation on Ubuntu

```bash
cd agent
make build
sudo install -m 0755 bin/opspilot-agent /usr/local/bin/opspilot-agent
sudo groupadd --system opspilot
sudo useradd --system --gid opspilot --home-dir /var/lib/opspilot --shell /usr/sbin/nologin opspilot
sudo install -d -m 0700 -o opspilot -g opspilot /var/lib/opspilot
sudo install -d -m 0750 -o root -g root /etc/opspilot
sudo install -m 0600 ../infra/systemd/agent.env.example /etc/opspilot/agent.env
# Edit agent.env: HTTPS Hub URL, allowlisted services/config files; omit enrollment token.
# First obtain a token through the authenticated manual API (docs/API.md).
# Replace the Hub origin below with your configured HTTPS origin.
sudo runuser -u opspilot -- env OPSPILOT_HUB_URL=https://hub.example.com \
  OPSPILOT_AGENT_STATE_PATH=/var/lib/opspilot/identity.json \
  OPSPILOT_ENROLL_TOKEN='<one-time-token>' /usr/local/bin/opspilot-agent enroll
sudo cp ../infra/systemd/opspilot-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opspilot-agent
sudo journalctl -u opspilot-agent -n 50 --no-pager
```

For an existing dedicated account/group, inspect and reuse them rather than rerunning creation commands; never ignore account-creation errors. `enroll` requires an HTTPS origin and exits after saving/reusing a valid identity; unsupported arguments fail with usage. No-argument monitoring retains HTTP for local development only. The dedicated user may not be able to read Nginx config or journal: fix permissions **narrowly**, not by running as root. Keep the token out of the env/unit and never remove an identity as a retry mechanism. This manual route remains usable when dashboard installation metadata is unavailable.

## Container agent

```bash
# Obtain an enrollment token through the authenticated manual API (docs/API.md), then
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

Hub: `DATABASE_URL`, `PORT`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `ALLOWED_ORIGIN`, `COOKIE_SECURE`, `ALERT_*`, and optional curl-onboarding settings `OPSPILOT_PUBLIC_HUB_URL`, `OPSPILOT_AGENT_VERSION`, `OPSPILOT_AGENT_REPOSITORY` described above. Worker: `DATABASE_URL`, `*_API_KEY`, `*_MODEL`, `INVESTIGATION_POLL_MS`. Web: `HUB_INTERNAL_URL` (server-side Next rewrite, never the public agent origin). Agent: `OPSPILOT_HUB_URL`, transient `OPSPILOT_ENROLL_TOKEN`, `OPSPILOT_AGENT_STATE_PATH`, `OPSPILOT_ALLOWED_SERVICES`, `OPSPILOT_CONFIG_FILES`, `OPSPILOT_ENABLE_DOCKER`, `OPSPILOT_PROC_ROOT`, `OPSPILOT_DISK_PATH`, `OPSPILOT_INTERVAL_SECONDS`.

## Before external deployment

- Add certificate monitoring and correct proxy WSS upgrade.
- Restrict admin dashboard to VPN/Tailscale or trusted reverse proxy until auth hardening.
- Pin container image digests, lock dependencies, scan images.
- Add disk usage alerts for PostgreSQL; enable data retention and backup validation.
- Do not place production secrets in logs sent to LLM providers without policy, consent and tested redaction.
