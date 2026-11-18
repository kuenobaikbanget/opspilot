import type { AgentInstallConfig } from "@opspilot/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Download completely before privilege escalation; all metadata stays literal shell data. */
export function buildAgentInstallCommand(config: AgentInstallConfig, token: string): string {
  const args = `--hub-url ${quote(config.hubUrl)} --version ${quote(config.version)} --repository ${quote(config.repository)} --token ${quote(token)}`;
  return `(\n  set -eu\n  umask 077\n  file=$(mktemp)\n  trap 'rm -f -- "$file"' EXIT\n  trap 'exit 130' INT\n  trap 'exit 143' TERM\n  trap 'exit 129' HUP\n  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 --output "$file" ${quote(config.installerUrl)}\n  if [ "$(id -u)" -eq 0 ]; then\n    bash "$file" ${args}\n  else\n    sudo bash "$file" ${args}\n  fi\n)`;
}
