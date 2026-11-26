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
/** Maximum UTF-8 bytes of one workload inventory frame (well below the 64 KiB WS limit). */
export const MAX_WORKLOAD_INVENTORY_BYTES = 16 * 1024;
/** Maximum workload entries in one inventory report. */
export const MAX_WORKLOADS_PER_REPORT = 64;
/** Maximum workload rows returned by one fleet list page. */
export const WORKLOAD_LIST_LIMIT = 200;
/** Display freshness window for agent-collected workload inventory. */
export const WORKLOAD_STALE_AFTER_SECONDS = 120;
/** Highest CPU percent a workload may report (256 cores at 100%). */
export const MAX_WORKLOAD_CPU_PERCENT = 25_600;

export type WorkloadRuntime = "systemd" | "docker";
export type WorkloadState = "running" | "stopped" | "failed" | "unknown";
export type WorkloadCollectionStatus = "ok" | "disabled" | "unsupported" | "unavailable";
export type WorkloadCollector = "docker" | "systemd";
export type WorkloadUnavailableReason =
  | "docker_cli_missing"
  | "docker_daemon_unreachable"
  | "systemd_manager_missing"
  | "permission_denied"
  | "command_failed"
  | "command_timeout"
  | "output_overflow";

const WORKLOAD_UNAVAILABLE_REASONS: readonly string[] = [
  "docker_cli_missing",
  "docker_daemon_unreachable",
  "systemd_manager_missing",
  "permission_denied",
  "command_failed",
  "command_timeout",
  "output_overflow",
];
const WORKLOAD_COLLECTORS: readonly string[] = ["docker", "systemd"];
const dockerContainerNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const systemdUnitNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,71}\.service$/;

/** One measured workload inside an inventory report; resource fields are optional and nullable. */
export type WorkloadEntry = {
  name: string;
  runtime: WorkloadRuntime;
  state: WorkloadState;
  cpuPercent?: number | null;
  memoryBytes?: number | null;
};

type WorkloadInventoryBody =
  | { status: "ok"; workloads: WorkloadEntry[]; skipped?: WorkloadCollector[] }
  | { status: "disabled" }
  | { status: "unsupported"; reason?: WorkloadUnavailableReason }
  | { status: "unavailable"; reason: WorkloadUnavailableReason };

/** Agent-initiated snapshot of the opt-in read-only Docker/systemd workload inventory. */
export type WorkloadInventoryReport = {
  type: "workload_inventory";
  version: 1;
  observedAt: string;
} & WorkloadInventoryBody;

const WORKLOAD_ENTRY_KEYS: Record<string, true> = {
  name: true, runtime: true, state: true, cpuPercent: true, memoryBytes: true,
};

function parseWorkloadEntry(value: unknown): WorkloadEntry | null {
  if (!requestObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length < 3 || keys.length > 5 || !keys.every(k => WORKLOAD_ENTRY_KEYS[k]) ||
      !("name" in value) || !("runtime" in value) || !("state" in value)) return null;
  const { name, runtime, state, cpuPercent, memoryBytes } = value;
  if (typeof name !== "string" || typeof runtime !== "string" || typeof state !== "string") return null;
  if (runtime !== "docker" && runtime !== "systemd") return null;
  if (runtime === "docker" ? !dockerContainerNamePattern.test(name) : !systemdUnitNamePattern.test(name)) return null;
  if (state !== "running" && state !== "stopped" && state !== "failed" && state !== "unknown") return null;
  if (Object.hasOwn(value, "cpuPercent") && cpuPercent !== null &&
      (typeof cpuPercent !== "number" || !Number.isFinite(cpuPercent) || cpuPercent < 0 || cpuPercent > MAX_WORKLOAD_CPU_PERCENT)) return null;
  if (Object.hasOwn(value, "memoryBytes") && memoryBytes !== null &&
      (typeof memoryBytes !== "number" || !Number.isSafeInteger(memoryBytes) || memoryBytes < 0)) return null;
  return value as WorkloadEntry;
}

/** Accept only the exact v1 shape, bounded item count and a recent canonical UTC millisecond timestamp. */
export function parseWorkloadInventory(value: unknown, now = Date.now()): WorkloadInventoryReport | null {
  if (!requestObject(value) || value.type !== "workload_inventory" || value.version !== 1 ||
      typeof value.observedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt)) return null;
  const time = Date.parse(value.observedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value.observedAt ||
      time < now - 120_000 || time > now + 5_000) return null;

  const size = Object.keys(value).length;
  const { status, reason, skipped, workloads } = value;
  const hasReason = Object.hasOwn(value, "reason");
  const hasSkipped = Object.hasOwn(value, "skipped");
  const hasWorkloads = Object.hasOwn(value, "workloads");
  const validReason = typeof reason === "string" && WORKLOAD_UNAVAILABLE_REASONS.includes(reason);

  switch (status) {
    case "ok": {
      if (!hasWorkloads || hasReason || size !== (hasSkipped ? 6 : 5)) return null;
      if (!Array.isArray(workloads) || workloads.length > MAX_WORKLOADS_PER_REPORT) return null;
      const seen = new Set<string>();
      for (const entry of workloads) {
        const parsed = parseWorkloadEntry(entry);
        if (!parsed) return null;
        const key = `${parsed.runtime}:${parsed.name}`;
        if (seen.has(key)) return null;
        seen.add(key);
      }
      if (hasSkipped) {
        if (!Array.isArray(skipped) || skipped.length > 2) return null;
        const set = new Set<string>();
        for (const collector of skipped) {
          if (typeof collector !== "string" || !WORKLOAD_COLLECTORS.includes(collector) || set.has(collector)) return null;
          set.add(collector);
        }
      }
      return value as WorkloadInventoryReport;
    }
    case "disabled":
      if (hasReason || hasSkipped || hasWorkloads || size !== 4) return null;
      return value as WorkloadInventoryReport;
    case "unsupported":
      if (hasSkipped || hasWorkloads || size !== (hasReason ? 5 : 4) || (hasReason && !validReason)) return null;
      return value as WorkloadInventoryReport;
    case "unavailable":
      if (hasSkipped || hasWorkloads || size !== 5 || !hasReason || !validReason) return null;
      return value as WorkloadInventoryReport;
    default:
      return null;
  }
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

/** Deterministic, transparent reason tags produced by evidence-relevance scoring. */
export type EvidenceRelevanceSignal =
  | "cited_by_hypothesis"
  | "error_signal"
  | "category_match"
  | "keyword_overlap"
  | "source_priority";

/** Deterministic relevance data attached to an evidence item; computed without any LLM call. */
export type EvidenceRelevance = {
  /** Integer 0-100; higher means more relevant to the incident. */
  score: number;
  /** True only when the latest AI hypothesis cited this evidence ID. */
  cited: boolean;
  matchedSignals: EvidenceRelevanceSignal[];
};

/** An evidence item carrying its deterministic relevance annotation. */
export type ScoredEvidenceItem = {
  id: string;
  source: string;
  content: string;
  created_at: string | null;
  relevance: EvidenceRelevance;
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

export type EndpointMonitorRunCounts = { total: number; up: number; down: number };

export type EndpointMonitor = {
  id: string;
  agent_id: string | null;
  service_name: string | null;
  name: string;
  target_url: string;
  expected_status: number;
  probe_location: string;
  enabled: boolean;
  check_interval_seconds: number;
  run_counts: EndpointMonitorRunCounts;
  last_status: "up" | "down" | "unknown";
  last_http_status: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
  last_checked_at: string | null;
};

export type ServicesPayload = {
  endpoints: EndpointMonitor[];
};
export type WorkloadStateCounts = {
  total: number;
  running: number;
  stopped: number;
  failed: number;
  unknown: number;
};

/** Persisted per-host workload row scoped to one inventory collection source. */
export type Workload = {
  id: string;
  agent_id: string;
  name: string;
  runtime: "systemd" | "docker" | "process";
  state: WorkloadState;
  source: string;
  observed_at: string;
  cpu_percent: number | null;
  memory_bytes: number | null;
};

/** Latest workload-inventory collection status for one host. */
export type WorkloadCollection = {
  status: WorkloadCollectionStatus;
  reason: WorkloadUnavailableReason | null;
  skipped: WorkloadCollector[];
  observed_at: string;
  current: boolean;
};

/** Host-scoped workload inventory with per-workload freshness and host-scoped counts. */
export type HostWorkloads = {
  agent_id: string;
  online: boolean;
  checked_at: string;
  collection: WorkloadCollection | null;
  workloads: (Workload & { freshness: "fresh" | "stale" })[];
  counts: WorkloadStateCounts;
};

/** Fleet workload listing; totals and counts cover the whole fleet, not the capped page. */
export type WorkloadList = {
  workloads: Workload[];
  total: number;
  hosts_total: number;
  hosts_online: number;
  hosts_collecting: number;
  counts: WorkloadStateCounts;
  limit: number;
  observed_at: string;
  stale_after_seconds: number;
};

/** One persisted, timestamped probe execution with its actual named probe location. */
export type EndpointMonitorRun = {
  id: string;
  monitor_id: string;
  probe_location: string;
  status: "up" | "down";
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  started_at: string;
  finished_at: string;
  created_at: string;
};

export type EndpointRunsPayload = {
  runs: EndpointMonitorRun[];
  limit: number;
};

export type CreateEndpointMonitorRequest = {
  name: string;
  targetUrl: string;
  expectedStatus: number;
  agentId: string | null;
  serviceName: string | null;
  checkIntervalSeconds: number;
  enabled: boolean;
};

export type UpdateEndpointMonitorRequest = Partial<CreateEndpointMonitorRequest>;

export const ENDPOINT_NAME_MAX = 80;
export const ENDPOINT_TARGET_URL_MAX = 2048;
export const ENDPOINT_CHECK_INTERVAL_MIN_SECONDS = 15;
export const ENDPOINT_CHECK_INTERVAL_MAX_SECONDS = 86400;
export const ENDPOINT_RUNS_LIMIT = 50;
/** Bounded per-monitor run history retained in the database. */
export const ENDPOINT_RUNS_RETENTION = 200;

const PRIVATE_OR_METADATA_HOSTS: Record<string, true> = {
  localhost: true,
  "localhost.localdomain": true,
  "metadata.google.internal": true,
  metadata: true,
};


// IANA IPv4 special-purpose ranges: this host, private, CGNAT, loopback,
// link-local (incl. cloud metadata 169.254.0.0/16), benchmarking, documentation,
// multicast and reserved.
const BLOCKED_IPV4_SUBNETS: ReadonlyArray<readonly [base: number, prefix: number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc01fc400, 24], [0xc034c100, 24], [0xc0586300, 24], [0xc0a80000, 16],
  [0xc0af3000, 24], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
  [0xe0000000, 4], [0xf0000000, 4],
];

function ipv4ToInt(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function isBlockedIpv4Value(value: number): boolean {
  return BLOCKED_IPV4_SUBNETS.some(([base, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function isLoopbackIpv4Value(value: number): boolean {
  return (value & 0xff000000) === 0x7f000000;
}

/** Expands an IPv6 literal (with optional zone id and embedded IPv4 tail) to 8 groups. */
function expandIpv6(host: string): number[] | null {
  const zone = host.indexOf("%");
  const addr = zone === -1 ? host : host.slice(0, zone);
  const doubleColon = addr.indexOf("::");
  let head = addr;
  let tail: string | null = null;
  if (doubleColon !== -1) {
    if (addr.indexOf("::", doubleColon + 1) !== -1) return null;
    head = addr.slice(0, doubleColon);
    tail = addr.slice(doubleColon + 2);
  }
  const parseGroups = (input: string): number[] | null => {
    if (input === "") return [];
    const groups = input.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.includes(".")) {
        if (i !== groups.length - 1) return null;
        const v4 = ipv4ToInt(group);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const headGroups = parseGroups(head);
  const tailGroups = tail === null ? null : parseGroups(tail);
  if (!headGroups || (tail !== null && !tailGroups)) return null;
  if (tail === null) return headGroups.length === 8 ? headGroups : null;
  const total = headGroups.length + tailGroups!.length;
  if (total > 8) return null;
  return [...headGroups, ...new Array<number>(8 - total).fill(0), ...tailGroups!];
}

/** Compares the first `prefix` bits of two 128-bit addresses given as 8 groups. */
function ipv6InSubnet(groups: number[], base: readonly number[], prefix: number): boolean {
  let remaining = prefix;
  for (let i = 0; i < 8; i++) {
    if (remaining <= 0) return true;
    if (remaining >= 16) {
      if (groups[i] !== base[i]) return false;
      remaining -= 16;
      continue;
    }
    const mask = (0xffff << (16 - remaining)) & 0xffff;
    return (groups[i] & mask) === (base[i] & mask);
  }
  return true;
}

// Special-purpose subnets inside 2000::/3 (global unicast): Teredo/benchmarking,
// documentation, 6to4, ORCHIDv2, benchmarking. Everything outside 2000::/3
// (loopback, ULA, link-local, multicast, unspecified, IPv4-mapped) is rejected
// by the allowlist itself.
const BLOCKED_IPV6_SUBNETS: ReadonlyArray<readonly [base: readonly number[], prefix: number]> = [
  [[0x2001, 0, 0, 0, 0, 0, 0, 0], 23],
  [[0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32],
  [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16],
  [[0x2620, 0x004f, 0x8000, 0, 0, 0, 0, 0], 48],
  [[0x3fff, 0, 0, 0, 0, 0, 0, 0], 20],
];

function isBlockedIpv6Groups(groups: number[]): boolean {
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) embed an IPv4 address.
  const mapped =
    groups.slice(0, 5).every((g) => g === 0) &&
    (groups[5] === 0xffff || (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)));
  if (mapped) {
    const v4 = ((groups[6] << 16) | groups[7]) >>> 0;
    return isBlockedIpv4Value(v4);
  }
  if ((groups[0] & 0xe000) !== 0x2000) return true; // not global unicast 2000::/3
  return BLOCKED_IPV6_SUBNETS.some(([base, prefix]) => ipv6InSubnet(groups, base, prefix));
}

function isLoopbackIpv6Groups(groups: number[]): boolean {
  return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
}

/** Classifies an IP literal host; returns "blocked" | "loopback" | "public" | null when not a literal. */
function classifyIpLiteral(host: string): "blocked" | "loopback" | "public" | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const value = ipv4ToInt(host);
    if (value === null) return null;
    if (isLoopbackIpv4Value(value)) return "loopback";
    return isBlockedIpv4Value(value) ? "blocked" : "public";
  }
  if (host.includes(":")) {
    const groups = expandIpv6(host);
    if (!groups) return null;
    if (isLoopbackIpv6Groups(groups)) return "loopback";
    // Unmap IPv4-mapped/NAT64 loopback so the mock policy can allow it explicitly.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      const v4 = ((groups[6] << 16) | groups[7]) >>> 0;
      if (isLoopbackIpv4Value(v4)) return "loopback";
    }
    return isBlockedIpv6Groups(groups) ? "blocked" : "public";
  }
  return null;
}

/** Static SSRF/egress classification of a URL host: "blocked" | "loopback" | "public". */
export function classifyEndpointHost(hostname: string): "blocked" | "loopback" | "public" {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return "blocked";
  if (PRIVATE_OR_METADATA_HOSTS[host] === true || host.endsWith(".localhost")) return "blocked";
  const literal = classifyIpLiteral(host);
  if (literal) return literal;
  return "public";
}

/**
 * Validates an operator-supplied HTTP(S) endpoint check URL against SSRF/egress policy.
 * Only http/https schemes without credentials or fragments are allowed; private,
 * loopback, link-local, CGNAT, multicast, reserved and cloud-metadata destinations
 * (IPv4 and IPv6, including IPv4-mapped IPv6) are rejected. DNS names are re-validated
 * against every resolved address at execution time (see packages/ai endpoint-probe).
 */
export function validateEndpointTargetUrl(
  raw: string,
  options: { allowLoopbackMock?: boolean } = {},
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > ENDPOINT_TARGET_URL_MAX) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.hash) return null;
  if (parsed.port && !/^\d{1,5}$/.test(parsed.port)) return null;
  const classification = classifyEndpointHost(parsed.hostname);
  if (classification === "blocked") return null;
  if (classification === "loopback" && !options.allowLoopbackMock) return null;
  return parsed.toString();
}

/** Structural validation of a create payload; server-side URL egress policy is applied separately. */
export function parseCreateEndpointMonitorRequest(value: unknown): CreateEndpointMonitorRequest | null {
  if (!requestObject(value)) return null;
  const name = trimmedString(value.name, ENDPOINT_NAME_MAX);
  const targetUrl = trimmedString(value.targetUrl, ENDPOINT_TARGET_URL_MAX);
  if (!name || !targetUrl) return null;
  const expectedStatus = value.expectedStatus === undefined ? 200 : Number(value.expectedStatus);
  if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) return null;
  const checkIntervalSeconds =
    value.checkIntervalSeconds === undefined
      ? 60
      : Number(value.checkIntervalSeconds);
  if (
    !Number.isInteger(checkIntervalSeconds) ||
    checkIntervalSeconds < ENDPOINT_CHECK_INTERVAL_MIN_SECONDS ||
    checkIntervalSeconds > ENDPOINT_CHECK_INTERVAL_MAX_SECONDS
  ) return null;
  const agentId = value.agentId === undefined || value.agentId === null || value.agentId === "" ? null : String(value.agentId);
  const serviceName = trimmedString(value.serviceName, ENDPOINT_NAME_MAX);
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") return null;
  return { name, targetUrl, expectedStatus, agentId, serviceName, checkIntervalSeconds, enabled };
}

/** Structural validation of a patch payload; at least one field must be present. */
export function parseUpdateEndpointMonitorRequest(value: unknown): UpdateEndpointMonitorRequest | null {
  if (!requestObject(value)) return null;
  const out: UpdateEndpointMonitorRequest = {};
  if (value.name !== undefined) {
    const name = trimmedString(value.name, ENDPOINT_NAME_MAX);
    if (!name) return null;
    out.name = name;
  }
  if (value.targetUrl !== undefined) {
    const targetUrl = trimmedString(value.targetUrl, ENDPOINT_TARGET_URL_MAX);
    if (!targetUrl) return null;
    out.targetUrl = targetUrl;
  }
  if (value.expectedStatus !== undefined) {
    const expectedStatus = Number(value.expectedStatus);
    if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) return null;
    out.expectedStatus = expectedStatus;
  }
  if (value.agentId !== undefined) {
    out.agentId = value.agentId === null || value.agentId === "" ? null : String(value.agentId);
  }
  if (value.serviceName !== undefined) {
    out.serviceName = trimmedString(value.serviceName, ENDPOINT_NAME_MAX);
  }
  if (value.checkIntervalSeconds !== undefined) {
    const checkIntervalSeconds = Number(value.checkIntervalSeconds);
    if (
      !Number.isInteger(checkIntervalSeconds) ||
      checkIntervalSeconds < ENDPOINT_CHECK_INTERVAL_MIN_SECONDS ||
      checkIntervalSeconds > ENDPOINT_CHECK_INTERVAL_MAX_SECONDS
    ) return null;
    out.checkIntervalSeconds = checkIntervalSeconds;
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") return null;
    out.enabled = value.enabled;
  }
  return Object.keys(out).length ? out : null;
}
