import type { AgentInstallConfig } from "@opspilot/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function buildLoopbackCommand(config: AgentInstallConfig, token: string): string {
  const release = `https://github.com/${config.repository}/releases/download/${config.version}`;
  return `(
  set -eu
  umask 077
  uid=$(id -u)
  if [ "$uid" = 0 ]; then
    echo 'Run this development command as a non-root user, without sudo.' >&2
    exit 1
  fi
  case "$(uname -sm)" in
    'Linux x86_64'|'Linux amd64') arch=amd64 ;;
    'Linux aarch64'|'Linux arm64') arch=arm64 ;;
    *) echo 'Requires amd64 or arm64 Linux.' >&2; exit 1 ;;
  esac
  dir=$(mktemp -d)
  trap 'rm -rf -- "$dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  archive=${quote(`opspilot-agent_${config.version.slice(1)}_linux_`)}"$arch".tar.gz
  release=${quote(release)}
  download() {
    curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --noproxy '*' --connect-timeout 10 --max-time 120 --output "$dir/$1" "$release/$1"
  }
  download "$archive"
  download SHA256SUMS
  checksum=$(LC_ALL=C awk -v archive="$archive" '
    $2 == archive || $2 == "*" archive {
      count++
      if (NF == 2 && length($1) == 64 && $1 ~ /^[0-9a-fA-F]+$/) hash = $1
    }
    END { if (count != 1 || hash == "") exit 1; print hash }
  ' "$dir/SHA256SUMS") || { echo 'Expected exactly one valid release checksum.' >&2; exit 1; }
  (cd -- "$dir"; printf '%s  %s\\n' "$checksum" "$archive" | sha256sum -c)
  TAR_OPTIONS= tar -xOzf "$dir/$archive" -- opspilot-agent > "$dir/opspilot-agent"
  test -s "$dir/opspilot-agent"
  chmod u+x "$dir/opspilot-agent"
  env -i PATH="$PATH" OPSPILOT_HUB_URL=${quote(config.hubUrl)} \\
    OPSPILOT_ENROLL_TOKEN=${quote(token)} OPSPILOT_AGENT_STATE_PATH="$dir/identity.json" "$dir/opspilot-agent"
)`;
}

/** Keep configuration and the token literal shell data in either mode. */
export function buildAgentInstallCommand(config: AgentInstallConfig, token: string): string {
  if (config.mode === "loopback-development") return buildLoopbackCommand(config, token);
  const args = `--hub-url ${quote(config.hubUrl)} --version ${quote(config.version)} --repository ${quote(config.repository)} --token ${quote(token)}`;
  return `(\n  set -eu\n  umask 077\n  file=$(mktemp)\n  trap 'rm -f -- "$file"' EXIT\n  trap 'exit 130' INT\n  trap 'exit 143' TERM\n  trap 'exit 129' HUP\n  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 --output "$file" ${quote(config.installerUrl)}\n  if [ "$(id -u)" -eq 0 ]; then\n    bash "$file" ${args}\n  else\n    sudo bash "$file" ${args}\n  fi\n)`;
}
