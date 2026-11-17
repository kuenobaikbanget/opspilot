export const MAX_WS_MESSAGE_BYTES = 64 * 1024;
export const ALLOWED_TOOLS = ["service_status", "listening_ports", "docker_status", "disk_usage", "recent_logs"] as const;
export type DiagnosticTool = (typeof ALLOWED_TOOLS)[number];
export type Provider = "openai" | "anthropic" | "gemini";
export type AgentTelemetry = {
 type: "telemetry"; timestamp: string; cpuPercent: number; memoryPercent: number; diskPercent: number;
 networkRxBytes: number; networkTxBytes: number; uptimeSeconds: number; configHashes: Record<string, string>;
};
export type DiagnosticRequest = { type: "diagnostic_request"; requestId: string; tool: DiagnosticTool; service?: string };
export type DiagnosticResult = { type: "diagnostic_result"; requestId: string; tool: string; ok: boolean; content: string };
export type Diagnosis = { probable_cause: string; confidence: "low"|"medium"|"high"; evidence_ids: string[]; missing_evidence: string[]; recommended_checks: string[] };
export function safeTool(x: unknown): x is DiagnosticTool { return typeof x === "string" && (ALLOWED_TOOLS as readonly string[]).includes(x); }
export function finitePercent(x: unknown): x is number { return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100; }

export type Host = {
 id: string; hostname: string; version: string; status: "online" | "offline";
 last_seen_at: string | null; created_at: string; sampled_at: string | null;
 cpu_percent: number | null; memory_percent: number | null; disk_percent: number | null;
};
export type HostList = {
 hosts: Host[]; total: number; online: number; limit: number;
 observed_at: string; stale_after_seconds: number;
};
export type HostMetric = {
 sampled_at: string; cpu_percent: number; memory_percent: number; disk_percent: number;
 network_rx_bytes: number; network_tx_bytes: number;
};
