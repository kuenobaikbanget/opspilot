import type { AgentInstallConfig } from "@opspilot/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Keep configuration and the token literal shell data in either mode. */
export function buildAgentInstallCommand(config: AgentInstallConfig, token: string): string {
  if (config.mode === "loopback-development") {
    return `bash ./infra/install/agent-dev.sh \\
  ${quote(config.hubUrl)} ${quote(config.version)} ${quote(config.repository)} \\
  ${quote(token)}`;
  }
  const args = `--hub-url ${quote(config.hubUrl)} \\
    --version ${quote(config.version)} --repository ${quote(config.repository)} \\
    --token ${quote(token)}`;

  return `(
  installer=$(mktemp) || exit
  trap 'rm -f -- "$installer"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  curl -q -fsSL --proto '=https' --proto-redir '=https' \\
    --connect-timeout 10 --max-time 120 --output "$installer" \\
    ${quote(config.installerUrl)} || exit
  run=(bash)
  [[ $(id -u) == 0 ]] || run=(sudo bash)
  "\${run[@]}" "$installer" ${args}
)`;
}
