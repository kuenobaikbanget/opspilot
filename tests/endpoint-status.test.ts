import { expect, test } from "bun:test";
import type { EndpointMonitor } from "../packages/contracts/src/index";
import {
  ENDPOINT_STALE_AFTER_MS,
  endpointBadgeText,
  endpointCounts,
  endpointOutcome,
  endpointRows,
  endpointStatus,
  formatTimestamp,
} from "../apps/web/lib/endpoint-status";

const now = Date.parse("2026-11-26T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function monitor(overrides: Partial<EndpointMonitor>): EndpointMonitor {
  return {
    id: "e0000000-0000-4000-8000-000000000001",
    agent_id: null,
    service_name: null,
    name: "api",
    target_url: "https://api.example.com/health",
    expected_status: 200,
    probe_location: "hub-local",
    last_status: "up",
    last_http_status: 200,
    last_latency_ms: 42,
    last_error: null,
    last_checked_at: iso(now - 1000),
    ...overrides,
  };
}

test("endpoint status separates fresh up/down, pending and stale at the 60s boundary", () => {
  expect(endpointStatus(monitor({ last_status: "up", last_checked_at: iso(now - 1000) }), now)).toBe("up");
  expect(endpointStatus(monitor({ last_status: "down", last_http_status: 503, last_checked_at: iso(now - 59_999) }), now)).toBe("down");
  expect(endpointStatus(monitor({ last_status: "up", last_checked_at: iso(now - ENDPOINT_STALE_AFTER_MS) }), now)).toBe("stale");
  expect(endpointStatus(monitor({ last_status: "up", last_checked_at: iso(now - ENDPOINT_STALE_AFTER_MS - 1) }), now)).toBe("stale");
  // unknown with or without a timestamp, and missing/unparseable timestamps, are pending.
  expect(endpointStatus(monitor({ last_status: "unknown", last_checked_at: null, last_http_status: null, last_latency_ms: null }), now)).toBe("pending");
  expect(endpointStatus(monitor({ last_status: "unknown", last_checked_at: iso(now) }), now)).toBe("pending");
  expect(endpointStatus(monitor({ last_status: "up", last_checked_at: null }), now)).toBe("pending");
  expect(endpointStatus(monitor({ last_status: "up", last_checked_at: "not-a-time" }), now)).toBe("pending");
});

test("stale results keep their historical outcome text and check time but are not counted up or down", () => {
  const stale = monitor({ last_status: "down", last_http_status: 503, last_checked_at: iso(now - 120_000) });
  expect(endpointStatus(stale, now)).toBe("stale");
  expect(endpointOutcome(stale)).toBe("Down · HTTP 503");
  expect(endpointBadgeText(stale, "stale")).toBe("Stale");
  expect(formatTimestamp(stale.last_checked_at)).not.toBe("Not observed");
  const counts = endpointCounts(endpointRows([stale, monitor({ id: "e0000000-0000-4000-8000-000000000002", last_status: "up" })], now));
  expect(counts).toEqual({ configured: 2, up: 1, down: 0, pending: 0, stale: 1 });
});

test("outcome text reports explicit error reasons and never fabricates a status", () => {
  expect(endpointOutcome(monitor({ last_status: "up", last_http_status: 200, last_latency_ms: 42 }))).toBe("Up · HTTP 200 · 42 ms");
  expect(endpointOutcome(monitor({ last_status: "up", last_http_status: null, last_latency_ms: null }))).toBe("Up");
  expect(endpointOutcome(monitor({ last_status: "down", last_http_status: null, last_error: "dns_failed" }))).toBe("Down · dns_failed");
  expect(endpointOutcome(monitor({ last_status: "down", last_http_status: null, last_error: null }))).toBe("Down · unreachable");
  expect(endpointOutcome(monitor({ last_status: "unknown", last_http_status: null, last_latency_ms: null, last_checked_at: null }))).toBe("No check result yet");
  expect(endpointBadgeText(monitor({ last_status: "unknown", last_checked_at: null, last_http_status: null, last_latency_ms: null }), "pending")).toBe("Pending");
  expect(formatTimestamp(null)).toBe("Not observed");
  expect(formatTimestamp("garbage")).toBe("Not observed");
});
