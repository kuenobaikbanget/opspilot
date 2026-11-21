import type { AgentInstallConfig } from "@opspilot/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Keep configuration and the token literal shell data in either mode. */
export function buildAgentInstallCommand(config: AgentInstallConfig, token: string): string {
  if (config.mode === "loopback-development") {
    return `bash ./infra/install/agent-dev.sh \\
  ${quote(config.hubUrl)} ${quote(config.version)} ${quote(config.repository)} \\
  ${quote(token)}`;
  }
  const args = `--hub-url ${quote(config.hubUrl)} --version ${quote(config.version)} --repository ${quote(config.repository)} --token ${quote(token)}`;

  // curl's --proto allowlist also applies to redirects.
  return `(tmp=$(mktemp) || exit; trap 'rm -f -- "$tmp"' EXIT; trap 'exit 1' HUP INT TERM; ` +
    `run=(bash); [[ $(id -u) == 0 ]] || run=(sudo bash); ` +
    `curl -q -fsSL --proto =https --connect-timeout 10 -m 120 -o "$tmp" -- ${quote(config.installerUrl)} ` +
    `&& "\${run[@]}" "$tmp" ${args})`;
}
