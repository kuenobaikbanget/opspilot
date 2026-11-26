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
