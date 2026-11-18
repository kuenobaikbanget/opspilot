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
