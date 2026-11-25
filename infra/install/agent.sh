#!/usr/bin/env bash
# The Hub replaces these empty assignments with validated deployment settings.
hub_url='' version='' repository=''

fail() { printf 'OpsPilot: %s\n' "$1" >&2; exit 1; }

fetch() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 --output "$2" "$1"
}

compare_existing() {
  if [[ -e "$2" ]] && ! cmp -s -- "$1" "$2"; then
    fail 'Existing OpsPilot installation differs; refusing to overwrite'
  fi
}

# A piped invocation has no readable $0, so serialize the installer for sudo.
write_handoff_script() {
  printf '%s\n' '#!/usr/bin/env bash'
  printf 'hub_url=%q version=%q repository=%q\n' "$hub_url" "$version" "$repository"
  declare -f fail fetch compare_existing main
  printf '%s\n' 'main "$@"'
}

main() {
  set -euo pipefail
  umask 077
  [[ -n "$hub_url" && -n "$version" && -n "$repository" ]] || fail 'Download the configured installer from your HTTPS Hub'
  (( $# == 2 )) && [[ "$1" == --token ]] || fail 'Usage: bash agent.sh --token TOKEN'
  token=$2
  [[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail 'Token must be a 43-character base64url enrollment token'
  # Do not retain a second copy in the positional arguments.
  set --

  [[ "$(uname -s)" == Linux ]] || fail 'Only Linux with running systemd is supported'
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail 'Unsupported architecture; use Linux amd64 or arm64' ;;
  esac
  if (( EUID != 0 )); then
    command -v sudo >/dev/null || fail 'sudo is required to install as a non-root user'
    # Keep the token out of sudo's logged arguments and standard input.
    token_file=$(mktemp) || fail 'Could not create a private sudo handoff file'
    handoff_script=''
    cleanup_handoff() { rm -f -- "$token_file" ${handoff_script:+"$handoff_script"}; }
    trap cleanup_handoff EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    printf '%s\n' "$token" > "$token_file"
    unset token
    if [[ -f "$0" && -r "$0" ]]; then
      script=$0
    else
      # curl | bash -s: $0 is the shell name, not the installer file.
      handoff_script=$(mktemp) || fail 'Could not create a private sudo script handoff file'
      write_handoff_script > "$handoff_script" || fail 'Could not write the private sudo script handoff file'
      script=$handoff_script
    fi
    [[ "$token_file" == /* ]] || token_file="$PWD/$token_file"
    [[ "$script" == /* ]] || script="$PWD/$script"
    sudo -u root -- bash -p -c '
      if (( EUID != 0 )); then
        printf "%s\n" "OpsPilot: sudo did not grant root privileges" >&2
        exit 1
      fi
      if ! IFS= read -r token < "$1"; then
        printf "%s\n" "OpsPilot: Could not read the private sudo handoff file" >&2
        exit 1
      fi
      exec bash -p -- "$0" --token "$token"
    ' "$script" "$token_file"
    exit
  fi
  for dependency in bash curl tar sha256sum install cmp mktemp systemctl useradd groupadd getent runuser env chown chmod uname mkdir rm cat; do
    command -v "$dependency" >/dev/null 2>&1 || fail "Missing dependency: $dependency; install it with your distribution package manager"
  done
  [[ -x /usr/sbin/nologin ]] || fail 'Required system-account shell /usr/sbin/nologin is missing'
  [[ -d /run/systemd/system ]] || fail 'systemd is not running; use a Linux systemd host, not a container or chroot'
  system_state="$(systemctl is-system-running 2>/dev/null || true)"
  [[ "$system_state" == running || "$system_state" == degraded ]] || fail 'systemd is not running; wait for boot to finish and retry'

  # Check every parent as well as leaf targets before any installation mutation.
  for directory in /usr /usr/local /usr/local/bin /etc /etc/opspilot /etc/systemd /etc/systemd/system /var /var/lib /var/lib/opspilot; do
    [[ ! -L "$directory" ]] || fail 'Refusing symlink installation directory'
    [[ ! -e "$directory" || -d "$directory" ]] || fail 'Installation parent is not a directory'
  done
  for target in /usr/local/bin/opspilot-agent /etc/opspilot/agent.env /etc/systemd/system/opspilot-agent.service /var/lib/opspilot/identity.json; do
    [[ ! -L "$target" ]] || fail 'Refusing symlink installation target'
    [[ ! -e "$target" || -f "$target" ]] || fail 'Installation target is not a regular file'
  done

  group_record="$(getent group opspilot || true)"
  passwd_record="$(getent passwd opspilot || true)"
  group_id=''
  if [[ -n "$group_record" ]]; then
    IFS=: read -r group_name group_password group_id group_members <<< "$group_record"
    [[ "$group_id" =~ ^[0-9]+$ && "$group_id" != 0 ]] || fail 'Existing opspilot group must be nonroot'
  fi
  if [[ -n "$passwd_record" ]]; then
    IFS=: read -r account_name account_password account_id account_group account_rest <<< "$passwd_record"
    [[ "$account_id" =~ ^[0-9]+$ && "$account_id" != 0 && -n "$group_id" && "$account_group" == "$group_id" ]] || fail 'Existing opspilot account must be nonroot with primary group opspilot'
  fi

  tmp="$(mktemp -d)"
  cleanup() { rm -rf -- "$tmp"; }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  archive="opspilot-agent_${version#v}_linux_${arch}.tar.gz"
  base="https://github.com/${repository}/releases/download/${version}"
  fetch "$base/$archive" "$tmp/$archive" || fail 'Agent download failed; check the pinned public GitHub release and network access'
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail 'Checksum download failed; check the pinned public GitHub release'
  checksum_pattern='^([[:xdigit:]]{64})[[:blank:]][ *]([A-Za-z0-9_.-]+)$'
  checksum='' matches=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $checksum_pattern ]] || fail 'Malformed SHA256SUMS entry'
    if [[ "${BASH_REMATCH[2]}" == "$archive" ]]; then
      checksum="${BASH_REMATCH[1],,}"
      matches=$((matches + 1))
    fi
  done < "$tmp/SHA256SUMS"
  (( matches == 1 )) || fail 'SHA256SUMS must contain exactly one entry for the agent archive'
  actual="$(sha256sum "$tmp/$archive")"
  [[ "${actual%% *}" == "$checksum" ]] || fail 'Agent archive checksum mismatch'

  # Separate name/type listings reject duplicates, links, directories and path tricks.
  tar -tzf "$tmp/$archive" > "$tmp/names" || fail 'Cannot inspect agent archive'
  tar -tvzf "$tmp/$archive" > "$tmp/types" || fail 'Cannot inspect agent archive types'
  seen_binary=0 seen_unit=0 seen_template=0
  while IFS= read -r member; do
    case "$member" in
      opspilot-agent) (( seen_binary == 0 )) || fail 'Duplicate archive member'; seen_binary=1 ;;
      opspilot-agent.service) (( seen_unit == 0 )) || fail 'Duplicate archive member'; seen_unit=1 ;;
      agent.env.example) (( seen_template == 0 )) || fail 'Duplicate archive member'; seen_template=1 ;;
      *) fail 'Unsafe or unexpected archive member' ;;
    esac
  done < "$tmp/names"
  (( seen_binary && seen_unit && seen_template )) || fail 'Agent archive must contain exactly the binary, unit and env template'
  member_count=0
  while IFS= read -r member; do
    [[ "$member" == -* ]] || fail 'Archive members must be regular files, not links or directories'
    member_count=$((member_count + 1))
  done < "$tmp/types"
  (( member_count == 3 )) || fail 'Agent archive must contain exactly three regular files'
  mkdir "$tmp/extracted"
  tar -xzf "$tmp/$archive" --no-same-owner --no-same-permissions -C "$tmp/extracted" || fail 'Cannot extract verified agent archive'
  cat > "$tmp/agent.env" <<ENV
OPSPILOT_HUB_URL=$hub_url
OPSPILOT_ALLOWED_SERVICES=nginx,docker,sshd
OPSPILOT_CONFIG_FILES=/etc/nginx/nginx.conf
OPSPILOT_INTERVAL_SECONDS=15
OPSPILOT_ENABLE_DOCKER=false
ENV

  # Compare every conflict before creating accounts, directories or files.
  compare_existing "$tmp/extracted/opspilot-agent" /usr/local/bin/opspilot-agent
  compare_existing "$tmp/extracted/opspilot-agent.service" /etc/systemd/system/opspilot-agent.service
  compare_existing "$tmp/agent.env" /etc/opspilot/agent.env

  [[ -n "$group_record" ]] || groupadd --system opspilot
  [[ -n "$passwd_record" ]] || useradd --system --gid opspilot --home-dir /var/lib/opspilot --shell /usr/sbin/nologin opspilot
  install -d -o root -g root -m 0750 /etc/opspilot
  install -d -o opspilot -g opspilot -m 0700 /var/lib/opspilot
  if [[ ! -e /usr/local/bin/opspilot-agent ]]; then
    install -o root -g root -m 0755 "$tmp/extracted/opspilot-agent" /usr/local/bin/opspilot-agent
  fi
  if [[ ! -e /etc/systemd/system/opspilot-agent.service ]]; then
    install -o root -g root -m 0644 "$tmp/extracted/opspilot-agent.service" /etc/systemd/system/opspilot-agent.service
  fi
  if [[ ! -e /etc/opspilot/agent.env ]]; then
    install -o root -g root -m 0600 "$tmp/agent.env" /etc/opspilot/agent.env
  fi
  chown root:root /usr/local/bin/opspilot-agent /etc/systemd/system/opspilot-agent.service /etc/opspilot/agent.env
  chmod 0755 /usr/local/bin/opspilot-agent
  chmod 0644 /etc/systemd/system/opspilot-agent.service
  chmod 0600 /etc/opspilot/agent.env

  if ! runuser -u opspilot -- env -i PATH=/usr/local/bin:/usr/bin:/bin \
    OPSPILOT_HUB_URL="$hub_url" OPSPILOT_AGENT_STATE_PATH=/var/lib/opspilot/identity.json \
    OPSPILOT_ENROLL_TOKEN="$token" /usr/local/bin/opspilot-agent enroll; then
    unset token
    fail 'Enrollment failed; service was not started. Retry with a fresh dashboard token if the Hub accepted the previous token but its response or identity was lost. Existing identities are never removed.'
  fi
  unset token
  if ! systemctl daemon-reload || ! systemctl enable --now opspilot-agent || ! systemctl is-active --quiet opspilot-agent; then
    fail 'Service is not active. Inspect: sudo systemctl status opspilot-agent; sudo journalctl -u opspilot-agent --since "10 minutes ago". Service-active alone does not prove Hub connectivity.'
  fi
  printf '%s\n' 'OpsPilot agent service is active; verify Online and recent metrics in the dashboard'
}
main "$@"
