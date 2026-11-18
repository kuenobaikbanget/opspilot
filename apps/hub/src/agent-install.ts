import type { AgentInstallConfig } from "@opspilot/contracts";

/** Explicit deployment settings only: never derive a public origin from a request. */
export function readAgentInstallConfig(
  env: Record<string, string | undefined>,
): AgentInstallConfig | null {
  const raw = env.OPSPILOT_PUBLIC_HUB_URL;
  const version = env.OPSPILOT_AGENT_VERSION;
  const repository = env.OPSPILOT_AGENT_REPOSITORY ?? "kuenobaikbanget/opspilot";
  if (!raw || !version || /\s/.test(raw + version + repository) || !/^https:\/\/[^/?#\s\\]+\/?$/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || raw.includes("@")) return null;
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?$/.test(version) || version.length > 129) return null;
  const prerelease = version.indexOf("-");
  if (prerelease !== -1 && version.slice(prerelease + 1).split(".").some((part) => /^0[0-9]+$/.test(part))) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || [".", ".."].includes(repository.split("/")[1])) return null;
  const hubUrl = url.origin;
  return { hubUrl, installerUrl: `${hubUrl}/api/agents/install.sh`, version, repository };
}
