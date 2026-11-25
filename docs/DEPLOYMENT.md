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
# Fill ADMIN_PASSWORD_HASH, SESSION_SECRET and AI_PROVIDER_ENCRYPTION_KEY
# Ensure ADMIN_PASSWORD empty and COOKIE_SECURE=false for localhost only.
docker compose --profile full up --build -d
```

Services: `db`, one-shot `migrate`, `hub`, `worker`, `web`. Hub/Worker wait for successful migrations; Web receives no env_file/master. DB and app ports bind to loopback. For remote exposure, publish **only** reverse-proxy HTTPS endpoint, use `COOKIE_SECURE=true`, and correct `ALLOWED_ORIGIN` (public origin). The Next.js `/api` rewrite points to `http://hub:3001` inside Compose and is built with that origin. Validate reverse proxy `Upgrade` for WSS and origin policy.


## AI provider cutover

For a new installation, generate `AI_PROVIDER_ENCRYPTION_KEY` with `openssl rand -base64 32`, share it with Hub/Worker, then add connections through Provider settings. Keep the master backup separate from DB backups. Saving is not a connection test. HTTPS public API roots only; private gateways and Responses-only OpenAI endpoints are unsupported.

For an existing deployment:

1. Back up PostgreSQL; securely generate/back up the new master.
2. Stop old Hub/Worker binaries before changing schema.
3. Run `bun run db:init` with the new runner (Compose full profile runs its one-shot `migrate` service).
4. If importing old credentials, explicitly export legacy `OPENAI_API_KEY/OPENAI_MODEL`, `ANTHROPIC_API_KEY/ANTHROPIC_MODEL`, `GEMINI_API_KEY/GEMINI_MODEL` into the import process and run `bun --no-env-file run ai:import-env`. Both the package command and its nested importer disable automatic `.env` loading. The script neither reads nor edits `.env`, makes no network/model request, and does not run automatically at startup. Identical reruns are no-ops; collisions roll back the whole import.
5. Start new Hub/Worker/Web and verify connection metadata, then explicitly test the chosen connection/model.
6. Remove legacy provider variables from the deployment once import is verified.

Do not run old binaries against the migrated schema. Legacy completed/failed reports retain results and unrecorded model/base URL; legacy pending jobs fail with a migration notice and must be started again. There is no master rotation/recovery automation: restore the original key or replace provider credentials manually under a replacement master.

## Published release assets and container images

[GitHub release `v0.1.0-rc.2`](https://github.com/kuenobaikbanget/opspilot/releases/tag/v0.1.0-rc.2) publishes both Linux archives and `SHA256SUMS`. Pin a reviewed compatible release; the remote installer requires the finite `opspilot-agent enroll` command. Publishing a release is a deliberate maintainer action, not part of running an install command.

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

These values are never inferred from browser location, Host/Forwarded headers, `ALLOWED_ORIGIN` or `HUB_INTERNAL_URL`. Missing/invalid settings yield 503 from authenticated `/api/agents/install-config` and the public installer, not monitoring or manual token issuance. Loopback development has its own command and does not serve the HTTPS installer. Syntax validation is not a release-availability check; the Hub does not query GitHub at runtime. Ensure the public proxy serves `/api/*` and WSS with valid trusted TLS.

Target prerequisites: Linux with **systemd actually running**, amd64 (`x86_64`/`amd64`) or arm64 (`aarch64`/`arm64`), root or sudo, CA trust, `/usr/sbin/nologin`, and `bash`, `curl`, `tar`, `sha256sum`, `install`, `cmp`, `mktemp`, `systemctl`, `useradd`, `groupadd`, `getent`, `runuser`, `env`, `chown`, `chmod` and standard coreutils. No Go toolchain, checkout, browser or inbound agent port is needed. Dependencies are not installed automatically; no Docker/journal group access is granted.

Sign in → **Enroll host**, review the configured Hub/release, generate the command, then choose **Copy install command**. The HTTPS command is one Bash line, even if the wizard wraps it on screen: `curl -q -fsSL --proto '=https' --connect-timeout 10 -m 120 '<hubUrl>/api/agents/install.sh' | bash -s -- --token '<token>'`. SSH to the intended host and paste it unchanged. The bootstrap pipes the Hub-configured installer straight into Bash; the installer executes nothing unless the transfer is complete, because it only invokes `main "$@"` on its final line, so a truncated download fails as a syntax error. The installer validates its inputs before requesting root through sudo if needed; a nonroot piped run serializes the installer to a private 0600 temporary script beside the 0600 token handoff, both removed on exit or signal. An existing root session does not need sudo. It never pipes curl into a privileged shell. HTTPS-only downloads retain certificate checks and have 10-second connect / 120-second total timeouts.

**The command contains a one-time token and may remain in shell history, the clipboard and process arguments.** It expires after 10 minutes and is usable once. Hiding, closing or creating another command does not revoke earlier tokens or erase external copies. Do not share it, log it or include it in screenshots.

The installer selects the archive with `uname` on the target host. It downloads the pinned release directly from GitHub, verifies exactly one matching SHA-256 entry and exactly the three expected regular archive files before installation mutations, and rejects symlink targets. It installs:

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

## Same-machine HTTP development

Use the same **Connect server** wizard for an ephemeral local agent, not a remote, Tailscale or container-host installation. Use a separate local database and environment. Put these settings in the isolated Hub env file:

```dotenv
NODE_ENV=development
OPSPILOT_DEV_LOOPBACK_INSTALL=true
OPSPILOT_PUBLIC_HUB_URL=http://127.0.0.1:3211
OPSPILOT_AGENT_VERSION=v0.1.0-rc.2
```

Supply the usual local database and admin credentials in that file, migrate the isolated database, then run:

```bash
bun --no-env-file run tools/dev-worktree.ts --web-port 3210 --hub-port 3211 --env-file .env.worktree
```

Use available ports and keep `--hub-port` equal to the origin port: the worktree runner sets the Hub's `PORT` from `--hub-port`, overriding any `PORT` in the env file. For a direct Hub launch, set `PORT` to the origin port instead. Omitting the URL port means 80, not the default Hub port. `localhost`, alternate IP forms and non-loopback addresses are not accepted.

The Hub binds to `127.0.0.1` with the development opt-in. Keep the worktree runner's default Web host (`127.0.0.1`); do not use `--host 0.0.0.0`, an external proxy, or a port forward in this mode. A loopback Hub bind does not protect routes exposed through a proxy. Keep the existing HTTPS origin and leave the flag off in remote deployments.

Sign in at `http://127.0.0.1:3210`, then generate and copy the command. Run it in Bash **from the root of the trusted OpsPilot checkout on the Hub machine, as a regular user**. The command invokes `infra/install/agent-dev.sh` from that checkout; it does not download a script over HTTP. It needs amd64/arm64 Linux, direct HTTPS access to GitHub release assets, trusted CA certificates, `curl`, `tar`, `awk`, `sha256sum`, and standard coreutils. The helper verifies the pinned archive checksum and runs only the agent binary in the foreground. No Go build, sudo, systemd or production identity is used.

Keep the terminal open while verifying **Online** and recent telemetry. **Ctrl+C** stops the agent and removes its private temporary binary/downloads and identity on normal exit. A new run requires a new token and enrolls a new identity; the previous host and telemetry records remain in the development database. Abrupt termination (for example `SIGKILL`) can leave the private temporary directory behind.

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

### Optional systemd unit status

In the agent's local `/etc/opspilot/agent.env`, set `OPSPILOT_SYSTEMD_UNIT=nginx.service` (use the exact existing unit name). Empty/unset disables collection. One literal ASCII `.service` name up to 80 characters is supported; no lists, paths, globs or arguments. `OPSPILOT_ALLOWED_SERVICES` still controls only the existing diagnostics. Restart **`opspilot-agent`**, not the monitored unit, to apply the change. Older agents keep sending ordinary telemetry, but both agent and Hub must support v1 status to display it. Keep the host clock synchronized.

Check **Services → Host** or the selected **Hosts** inspector; normal sampling remains on its own interval. No extra access is needed on systems permitting the unprivileged read. If `/usr/bin/systemctl` or a booted system manager is absent, or policy denies the query, the dashboard shows unsupported/unavailable rather than `Stopped`. Do not add root, sudo, bus mounts or new group access to make status work in a container.

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
- Back up `AI_PROVIDER_ENCRYPTION_KEY` separately; a DB backup without its original master cannot decrypt provider credentials.
- Config drift snapshot table only holds hashes, **not configuration backup**.

## Environment variables

Hub: `DATABASE_URL`, `PORT`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `ALLOWED_ORIGIN`, `COOKIE_SECURE`, `ALERT_*`, `AI_PROVIDER_ENCRYPTION_KEY`, and optional onboarding settings `OPSPILOT_PUBLIC_HUB_URL`, `OPSPILOT_AGENT_VERSION`, `OPSPILOT_AGENT_REPOSITORY`, `OPSPILOT_DEV_LOOPBACK_INSTALL` described above. Worker: `DATABASE_URL`, `AI_PROVIDER_ENCRYPTION_KEY`, `INVESTIGATION_POLL_MS`. Web: `HUB_INTERNAL_URL` (server-side Next rewrite, never the public agent origin or master/provider keys). Agent: `OPSPILOT_HUB_URL`, transient `OPSPILOT_ENROLL_TOKEN`, `OPSPILOT_AGENT_STATE_PATH`, `OPSPILOT_ALLOWED_SERVICES`, `OPSPILOT_CONFIG_FILES`, `OPSPILOT_ENABLE_DOCKER`, `OPSPILOT_PROC_ROOT`, `OPSPILOT_DISK_PATH`, `OPSPILOT_INTERVAL_SECONDS`.

## Before external deployment

- Add certificate monitoring and correct proxy WSS upgrade.
- Restrict admin dashboard to VPN/Tailscale or trusted reverse proxy until auth hardening.
- Pin container image digests, lock dependencies, scan images.
- Add disk usage alerts for PostgreSQL; enable data retention and backup validation.
- Do not place production secrets in logs sent to LLM providers without policy, consent and tested redaction.
