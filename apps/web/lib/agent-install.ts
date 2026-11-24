import type { AgentInstallConfig } from "@opspilot/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Keep configuration and the token literal shell data in either mode. */
export function buildAgentInstallCommand(config: AgentInstallConfig, token: string): string {
  if (config.mode === "loopback-development") {
    return `bash ./infra/install/agent-dev.sh \\
  ${quote(config.hubUrl)} ${quote(config.version)} ${quote(config.repository)} \\
  ${quote(token)}`;
  }
  // curl's --proto allowlist also applies to redirects.
  return `curl -q -fsSL --proto =https --connect-timeout 10 -m 120 -o /tmp/opspilot-install.sh -- ${quote(config.installerUrl)} ` +
    `&& bash -- /tmp/opspilot-install.sh --token ${quote(token)}`;
}
