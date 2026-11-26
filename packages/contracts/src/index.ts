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
/** Oldest telemetry timestamp the Hub accepts (queued samples are re-stamped at send time). */
export const MAX_TELEMETRY_AGE_MS = 120_000;
/** Maximum future clock skew accepted on agent timestamps. */
export const MAX_CLOCK_SKEW_MS = 5_000;
/** Maximum config hash entries carried in one telemetry frame. */
export const MAX_CONFIG_HASH_ENTRIES = 20;

/**
 * Parses a canonical UTC RFC 3339 timestamp (`Z`, optional 1-3 digit fraction) and bounds it
 * to `[now - maxPastMs, now + MAX_CLOCK_SKEW_MS]`; returns epoch milliseconds or null.
 */
export function parseAgentTimestamp(
  value: unknown,
  now = Date.now(),
  maxPastMs = MAX_TELEMETRY_AGE_MS,
): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const fraction = match[7] ?? "";
  const ms = fraction ? Number(fraction) * (fraction.length === 1 ? 100 : fraction.length === 2 ? 10 : 1) : 0;
  const time = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], ms);
  if (!Number.isFinite(time)) return null;
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${String(ms).padStart(3, "0")}Z`;
  if (new Date(time).toISOString() !== canonical) return null;
  if (time < now - maxPastMs || time > now + MAX_CLOCK_SKEW_MS) return null;
  return time;
}

const TELEMETRY_KEYS = [
  "type",
  "timestamp",
  "cpuPercent",
  "memoryPercent",
  "diskPercent",
  "networkRxBytes",
  "networkTxBytes",
  "uptimeSeconds",
  "configHashes",
] as const;

const TELEMETRY_COUNTERS = ["networkRxBytes", "networkTxBytes", "uptimeSeconds"] as const;

/**
 * Accepts only the exact telemetry shape: finite percentages in [0, 100] (NaN/Inf rejected),
 * non-negative safe-integer counters, a bounded canonical timestamp and bounded config hashes.
 */
export function parseTelemetry(value: unknown, now = Date.now()): AgentTelemetry | null {
  if (
    !requestObject(value) ||
    value.type !== "telemetry" ||
    Object.keys(value).length !== TELEMETRY_KEYS.length ||
    !TELEMETRY_KEYS.every((key) => Object.hasOwn(value, key))
  ) {
    return null;
  }
  if (parseAgentTimestamp(value.timestamp, now) === null) return null;
  for (const key of ["cpuPercent", "memoryPercent", "diskPercent"] as const) {
    if (!finitePercent(value[key])) return null;
  }
  for (const key of TELEMETRY_COUNTERS) {
    const counter = value[key];
    if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) return null;
  }
  const hashes = value.configHashes;
  if (typeof hashes !== "object" || hashes === null || Array.isArray(hashes)) return null;
  const entries = Object.entries(hashes);
  if (entries.length > MAX_CONFIG_HASH_ENTRIES) return null;
  for (const [path, checksum] of entries) {
    if (!path.startsWith("/") || path.length > 256 || !/^[a-f0-9]{64}$/.test(checksum)) return null;
  }
  return value as AgentTelemetry;
}

/** Wire protocol version understood by this Hub; agents above it are refused on hello. */
export const PROTOCOL_VERSION = 2;
/** Oldest agent wire protocol version still accepted. */
export const MIN_PROTOCOL_VERSION = 1;

/** Capabilities an agent may advertise; the Hub negotiates the intersection with this list. */
export const AGENT_CAPABILITIES = ["telemetry", "systemd_status", "diagnostics"] as const;

/** Union of advertised agent capability names. */
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/** First frame an agent sends on an authenticated socket: version and capability report. */
export type AgentHello = {
  type: "hello";
  protocolVersion: number;
  agentVersion: string;
  capabilities: AgentCapability[];
};

/** Hub reply recording the negotiated protocol version and capability intersection. */
export type HelloAck = {
  type: "hello_ack";
  protocolVersion: number;
  capabilities: AgentCapability[];
};

/** Validates an advertised capability list: known names only, no duplicates, bounded length. */
export function parseAgentCapabilities(value: unknown): AgentCapability[] | null {
  if (!Array.isArray(value) || value.length > AGENT_CAPABILITIES.length) return null;
  const out: AgentCapability[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !(AGENT_CAPABILITIES as readonly string[]).includes(item)) return null;
    if (out.includes(item as AgentCapability)) return null;
    out.push(item as AgentCapability);
  }
  return out;
}

/** Intersection of requested capabilities with the Hub-supported set, in canonical order. */
export function negotiateCapabilities(requested: readonly AgentCapability[]): AgentCapability[] {
  return AGENT_CAPABILITIES.filter((capability) => requested.includes(capability));
}

/** Accepts only the exact hello shape with a supported protocol version and bounded version string. */
export function parseAgentHello(value: unknown): AgentHello | null {
  if (!requestObject(value) || value.type !== "hello" || Object.keys(value).length !== 4) return null;
  if (
    typeof value.protocolVersion !== "number" ||
    !Number.isSafeInteger(value.protocolVersion) ||
    value.protocolVersion < MIN_PROTOCOL_VERSION ||
    value.protocolVersion > PROTOCOL_VERSION
  ) {
    return null;
  }
  const agentVersion = trimmedString(value.agentVersion, 40);
  if (agentVersion === null || !Array.isArray(value.capabilities) || value.capabilities.length > 32) return null;
  // Forward compatibility: keep only known capability names; unknown or duplicate entries are ignored.
  const capabilities: AgentCapability[] = [];
  for (const item of value.capabilities) {
    if (typeof item === "string" && (AGENT_CAPABILITIES as readonly string[]).includes(item) && !capabilities.includes(item as AgentCapability)) {
      capabilities.push(item as AgentCapability);
    }
  }
  return { type: "hello", protocolVersion: value.protocolVersion, agentVersion, capabilities };
}

/** Enrollment body: one-use token, hostname, agent version and optional protocol/capabilities. */
export type EnrollRequest = {
  token: string;
  hostname: string;
  version: string;
  protocolVersion: number;
  capabilities: AgentCapability[];
};

const ENROLL_KEYS = ["token", "hostname", "version", "protocolVersion", "capabilities"] as const;

/** Strict enrollment parser; unknown keys, empty token/hostname or unknown capabilities reject. */
export function parseEnrollRequest(value: unknown): EnrollRequest | null {
  if (!requestObject(value)) return null;
  const keys = Object.keys(value);
  if (!keys.every((key) => (ENROLL_KEYS as readonly string[]).includes(key))) return null;
  const token = trimmedString(value.token, 256);
  const hostname = trimmedString(value.hostname, 100);
  if (token === null || hostname === null) return null;
  const version = Object.hasOwn(value, "version") ? trimmedString(value.version, 40) : "dev";
  if (version === null) return null;
  let protocolVersion = 1;
  if (Object.hasOwn(value, "protocolVersion")) {
    if (
      typeof value.protocolVersion !== "number" ||
      !Number.isSafeInteger(value.protocolVersion) ||
      value.protocolVersion < MIN_PROTOCOL_VERSION ||
      value.protocolVersion > PROTOCOL_VERSION
    ) {
      return null;
    }
    protocolVersion = value.protocolVersion;
  }
  let capabilities: AgentCapability[] = [];
  if (Object.hasOwn(value, "capabilities")) {
    const parsed = parseAgentCapabilities(value.capabilities);
    if (parsed === null) return null;
    capabilities = parsed;
  }
  return { token, hostname, version, protocolVersion, capabilities };
}

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
  protocol_version: number | null;
  capabilities: AgentCapability[];
  status: "online" | "offline";
  last_seen_at: string | null;
  created_at: string;
  sampled_at: string | null;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_percent: number | null;
};

/** Effective alert limits in percent; null disables that threshold. */
export type HostThresholds = {
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_percent: number | null;
};

/** Persisted per-metric alert condition state used for breach and cooldown tracking. */
export type AlertCondition = {
  agent_id: string;
  metric: "cpu" | "memory" | "disk";
  state: "ok" | "breaching" | "breached" | "cooldown";
  consecutive: number;
  cooldown_until: string | null;
  incident_id: string | null;
  updated_at: string;
};

/** Body accepted by `PUT /api/hosts/:id/thresholds`: at least one limit, each null or 0-100 finite. */
export type UpdateHostThresholdsRequest = Partial<Record<keyof HostThresholds, number | null>>;

const THRESHOLD_KEYS = ["cpu_percent", "memory_percent", "disk_percent"] as const;

/** Strict threshold update parser: known keys only, non-empty, each null or a finite 0-100 number. */
export function parseThresholdsUpdate(value: unknown): UpdateHostThresholdsRequest | null {
  if (!requestObject(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length || !keys.every((key) => (THRESHOLD_KEYS as readonly string[]).includes(key))) return null;
  const result: UpdateHostThresholdsRequest = {};
  for (const key of keys) {
    const input = value[key];
    if (input !== null && !(typeof input === "number" && Number.isFinite(input) && input >= 0 && input <= 100)) {
      return null;
    }
    result[key as keyof HostThresholds] = input;
  }
  return result;
}

/** Fleet host listing payload returned by `GET /api/hosts`. */
export type HostList = {
  hosts: Host[];
  total: number;
  online: number;
  limit: number;
  observed_at: string;
  stale_after_seconds: number;
  thresholds: HostThresholds;
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
