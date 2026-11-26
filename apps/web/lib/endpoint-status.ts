import type { EndpointMonitor } from "@opspilot/contracts";

// Worker probes become eligible after 15s; allow 60s for polling and queue delays.
// Aging is independent of page refresh: callers pass a ticking `now`.
export const ENDPOINT_STALE_AFTER_MS = 60_000;

export type EndpointStatus = "up" | "down" | "pending" | "stale";

export type EndpointRow = { endpoint: EndpointMonitor; status: EndpointStatus };

/**
 * Classifies one monitor's latest check. `unknown` or a missing/unparseable check time is
 * pending; a result aged 60s or more is stale (it keeps its original outcome and time but is
 * not a current up/down); otherwise the stored outcome applies.
 */
export function endpointStatus(endpoint: EndpointMonitor, now: number): EndpointStatus {
  if (endpoint.last_status === "unknown") return "pending";
  const checkedAt = Date.parse(endpoint.last_checked_at ?? "");
  if (!Number.isFinite(checkedAt)) return "pending";
  return now >= checkedAt + ENDPOINT_STALE_AFTER_MS ? "stale" : endpoint.last_status;
}

export function endpointRows(endpoints: EndpointMonitor[], now: number): EndpointRow[] {
  return endpoints.map(endpoint => ({ endpoint, status: endpointStatus(endpoint, now) }));
}

export type EndpointCounts = Record<EndpointStatus, number> & { configured: number };

export function endpointCounts(rows: EndpointRow[]): EndpointCounts {
  const counts: EndpointCounts = { configured: rows.length, up: 0, down: 0, pending: 0, stale: 0 };
  for (const { status } of rows) counts[status]++;
  return counts;
}

/** Observed result of the last check, including explicit error reasons; never fabricated. */
export function endpointOutcome(endpoint: EndpointMonitor): string {
  if (endpoint.last_status === "up") {
    return `Up${endpoint.last_http_status !== null ? ` · HTTP ${endpoint.last_http_status}` : ""}${endpoint.last_latency_ms !== null ? ` · ${endpoint.last_latency_ms} ms` : ""}`;
  }
  if (endpoint.last_status === "down") {
    return `Down · ${endpoint.last_http_status !== null ? `HTTP ${endpoint.last_http_status}` : endpoint.last_error ?? "unreachable"}`;
  }
  return "No check result yet";
}

export function endpointBadgeText(endpoint: EndpointMonitor, status: EndpointStatus): string {
  if (status === "stale") return "Stale";
  if (status === "pending") return "Pending";
  return endpointOutcome(endpoint);
}

export function endpointBadgeTone(status: EndpointStatus): "success" | "danger" | "neutral" {
  return status === "up" ? "success" : status === "down" ? "danger" : "neutral";
}

/** Milliseconds until a current up/down result ages out, or Infinity when not applicable. */
export function endpointExpiry(endpoint: EndpointMonitor): number {
  const checkedAt = Date.parse(endpoint.last_checked_at ?? "");
  if (!Number.isFinite(checkedAt)) return Infinity;
  return checkedAt + ENDPOINT_STALE_AFTER_MS;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export function formatTimestamp(value: string | null): string {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? dateTime.format(timestamp) : "Not observed";
}
