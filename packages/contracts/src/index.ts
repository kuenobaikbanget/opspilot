/** Maximum permitted WebSocket frame payload size in bytes. */
export const MAX_WS_MESSAGE_BYTES = 64 * 1024;

/** Allowlisted read-only diagnostic tools executable by enrolled agents. */
export const ALLOWED_TOOLS = [
  "service_status",
  "listening_ports",
  "docker_status",
  "disk_usage",
  "recent_logs",
] as const;

/** Union of supported read-only diagnostic tool names. */
export type DiagnosticTool = (typeof ALLOWED_TOOLS)[number];

/** Wire protocol used by a stored AI connection, independent of its identity. */
export type ProviderProtocol = "openai-compatible" | "anthropic" | "gemini";

export const AI_PROVIDER_PRESETS = {
  openai: { name: "OpenAI", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4.1-mini" },
  anthropic: { name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-5" },
  gemini: { name: "Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-2.5-flash" },
} as const satisfies Record<string, { name: string; protocol: ProviderProtocol; baseUrl: string; defaultModel: string }>;

export type ProviderConnectionTest = {
  id: string;
  revision: number;
  model: string;
  status: "queued" | "running" | "completed" | "failed";
  errorCode: string | null;
  httpStatus: number | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
};

/** Public metadata: credentials and encrypted envelopes are never included. */
export type AiProvider = {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  defaultModel: string;
  enabled: boolean;
  revision: number;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
  lastTest: ProviderConnectionTest | null;
};

export type CreateAiProviderRequest = {
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  enabled: boolean;
};
export type UpdateAiProviderRequest = Partial<CreateAiProviderRequest>;
export type InvestigateRequest = { providerId: string; providerRevision: number; model: string };
export type AiProviderApiError = { error: string; code: string };

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return value === "openai-compatible" || value === "anthropic" || value === "gemini";
}

function requestObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

const providerFields = ["name", "protocol", "baseUrl", "apiKey", "defaultModel", "enabled"] as const;

/** Structural input validation; server-only endpoint policy is applied separately. */
export function parseUpdateAiProviderRequest(value: unknown): UpdateAiProviderRequest | null {
  if (!requestObject(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !(providerFields as readonly string[]).includes(key))) return null;
  const result: UpdateAiProviderRequest = {};
  for (const key of providerFields) {
    if (!Object.hasOwn(value, key)) continue;
    const input = value[key];
    if (key === "enabled") {
      if (typeof input !== "boolean") return null;
      result.enabled = input;
    } else if (key === "protocol") {
      if (!isProviderProtocol(input)) return null;
      result.protocol = input;
    } else {
      const max = key === "name" ? 80 : key === "defaultModel" ? 200 : key === "baseUrl" ? 2048 : 4096;
      const parsed = trimmedString(input, max);
      if (parsed === null || (key === "apiKey" && /[\s\p{Cc}]/u.test(parsed))) return null;
      result[key] = parsed;
    }
  }
  return result;
}

export function parseCreateAiProviderRequest(value: unknown): CreateAiProviderRequest | null {
  const parsed = parseUpdateAiProviderRequest(value);
  if (!parsed || !providerFields.every((key) => Object.hasOwn(parsed, key))) return null;
  return parsed as CreateAiProviderRequest;
}

export function parseInvestigateRequest(value: unknown): InvestigateRequest | null {
  if (!requestObject(value) || Object.keys(value).length !== 3 ||
      !Object.keys(value).every((key) => ["providerId", "providerRevision", "model"].includes(key))) return null;
  if (typeof value.providerId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.providerId) ||
      typeof value.providerRevision !== "number" || !Number.isSafeInteger(value.providerRevision) || value.providerRevision < 1) return null;
  const model = trimmedString(value.model, 200);
  return model === null ? null : { providerId: value.providerId, providerRevision: value.providerRevision, model };
}

/** Explicit server-configured metadata for pinned Linux agent installation. */
export type AgentInstallConfig = {
  hubUrl: string;
  version: string;
  repository: string;
} & ({ mode: "https"; installerUrl: string } | { mode: "loopback-development" });

/** Periodic host telemetry message emitted by an enrolled agent. */
export type AgentTelemetry = {
  type: "telemetry";
  timestamp: string;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptimeSeconds: number;
  configHashes: Record<string, string>;
};

export const MAX_SYSTEMD_REPORT_BYTES = 512;
export const SYSTEMD_STALE_AFTER_SECONDS = 60;

export type SystemdState = "running" | "stopped" | "failed" | "unknown";
type SystemdReportBody =
  | { status: "observed"; unit: string; state: SystemdState }
  | { status: "disabled" }
  | { status: "unsupported"; unit: string }
  | { status: "unavailable"; unit?: string };

/** Agent-initiated snapshot of one locally configured systemd service (or collection status). */
export type SystemdReport = {
  type: "systemd_status";
  version: 1;
  observedAt: string;
} & SystemdReportBody;

/** Accept only the exact v1 shape and a recent canonical UTC millisecond timestamp. */
export function parseSystemdReport(value: unknown, now = Date.now()): SystemdReport | null {
  if (!requestObject(value) || value.type !== "systemd_status" || value.version !== 1 ||
      typeof value.observedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt)) return null;
  const time = Date.parse(value.observedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value.observedAt ||
      time < now - 120_000 || time > now + 5_000) return null;

  const { unit, status, state } = value;
  const hasUnit = Object.hasOwn(value, "unit");
  if (hasUnit && (typeof unit !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,71}\.service(?![\s\S])/.test(unit))) return null;
  const size = Object.keys(value).length;
  switch (status) {
    case "observed":
      if (!hasUnit || size !== 6 ||
          (state !== "running" && state !== "stopped" && state !== "failed" && state !== "unknown")) return null;
      break;
    case "unsupported":
      if (!hasUnit || size !== 5) return null;
      break;
    case "disabled":
      if (hasUnit || size !== 4) return null;
      break;
    case "unavailable":
      if (size !== (hasUnit ? 5 : 4)) return null;
      break;
    default:
      return null;
  }
  return value as SystemdReport;
}

/** Hub-to-agent request to run an allowlisted read-only diagnostic tool. */
export type DiagnosticRequest = {
  type: "diagnostic_request";
  requestId: string;
  tool: DiagnosticTool;
  service?: string;
};

/** Agent-to-hub response carrying bounded diagnostic tool output. */
export type DiagnosticResult = {
  type: "diagnostic_result";
  requestId: string;
  tool: string;
  ok: boolean;
  content: string;
};

/** Structured AI-generated diagnostic hypothesis constrained to cited evidence. */
export type Diagnosis = {
  probable_cause: string;
  confidence: "low" | "medium" | "high";
  evidence_ids: string[];
  missing_evidence: string[];
  recommended_checks: string[];
};

/** Type guard verifying that a value is an allowlisted diagnostic tool name. */
export function safeTool(x: unknown): x is DiagnosticTool {
  return typeof x === "string" && (ALLOWED_TOOLS as readonly string[]).includes(x);
}

/** Type guard verifying that a value is a finite percentage in [0, 100]. */
export function finitePercent(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100;
}

/** Host summary with latest status and most recent metric sample. */
export type Host = {
  id: string;
  hostname: string;
  version: string;
  status: "online" | "offline";
  last_seen_at: string | null;
  created_at: string;
  sampled_at: string | null;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_percent: number | null;
};

/** Fleet host listing payload returned by `GET /api/hosts`. */
export type HostList = {
  hosts: Host[];
  total: number;
  online: number;
  limit: number;
  observed_at: string;
  stale_after_seconds: number;
  thresholds: {
    cpu_percent: number | null;
    memory_percent: number | null;
    disk_percent: number | null;
  };
};

/** Single time-series host metric sample returned by `GET /api/hosts/:id/metrics`. */
export type HostMetric = {
  sampled_at: string;
  cpu_percent: number;
  memory_percent: number;
  disk_percent: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
};

export type HostService = {
  id: string;
  agent_id: string;
  name: string;
  runtime: "systemd" | "docker" | "process";
  state: "running" | "stopped" | "failed" | "unknown";
  source: string;
  observed_at: string;
};

/** Systemd collection status and last measured state for the requested host only. */
export type HostSystemdStatus = {
  agent_id: string;
  online: boolean;
  checked_at: string;
  report: { status: SystemdReport["status"]; observed_at: string; current: boolean } | null;
  service: (HostService & { freshness: "fresh" | "stale" }) | null;
};

export type EndpointMonitor = {
  id: string;
  agent_id: string | null;
  service_name: string | null;
  name: string;
  target_url: string;
  expected_status: number;
  probe_location: string;
  last_status: "up" | "down" | "unknown";
  last_http_status: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
  last_checked_at: string | null;
};

export type ServicesPayload = {
  endpoints: EndpointMonitor[];
};

const PRIVATE_OR_METADATA_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);

function isLoopbackOrPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (PRIVATE_OR_METADATA_HOSTS.has(lower) || lower === "::1" || lower === "::") return true;
  if (/^127\./.test(lower) || /^10\./.test(lower) || /^169\.254\./.test(lower) || /^0\./.test(lower)) return true;
  const m172 = lower.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^192\.168\./.test(lower)) return true;
  if (/^(fc|fd|fe80)/i.test(lower)) return true;
  return false;
}

/** Validates an operator-supplied HTTP(S) endpoint check URL against SSRF/egress policy. */
export function validateEndpointTargetUrl(
  raw: string,
  options: { allowLoopbackMock?: boolean } = {},
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.hash) return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return null;
  if (host === "169.254.169.254" || host === "metadata.google.internal") return null;
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (isLoopback && options.allowLoopbackMock) {
    return parsed.toString();
  }
  if (isLoopbackOrPrivateHost(host)) return null;
  if (parsed.protocol !== "https:") return null;
  return parsed.toString();
}
