import { expect, test } from "bun:test";
import {
  ingressGate,
  mulberry32,
  simulateDuplicateDelivery,
  simulateLeaseExpiry,
  simulateQueueBackpressure,
  simulateReconnectStorm,
  simulateStaleTimestamps,
  simulateTelemetryBurst,
  telemetryFrame,
} from "../tools/load-chaos";
import { MAX_WS_MESSAGE_BYTES, PROTOCOL_VERSION, parseTelemetry } from "../packages/contracts/src/index";

test("load: 64 agents x 200 samples burst is fully accounted and bounded", () => {
  const r = simulateTelemetryBurst(64, 200, { seed: 42, corruptEvery: 37 });
  const total = r.agents * r.samplesPerAgent;
  expect(r.accepted + r.rejectedOversize + r.rejectedInvalid).toBe(total);
  expect(r.rejectedOversize).toBeGreaterThan(0); // chaos injection actually fired
  expect(r.rejectedInvalid).toBeGreaterThan(0);
  expect(r.accepted).toBeGreaterThan(total * 0.9);
  expect(r.maxInFlightPerAgent).toBeLessThanOrEqual(64); // ring stays bounded
  expect(r.samplesPerSecond).toBeGreaterThan(1_000); // fast, reproducible harness
  // Determinism: same seed replays identically.
  const replay = simulateTelemetryBurst(64, 200, { seed: 42, corruptEvery: 37 });
  expect(replay.accepted).toBe(r.accepted);
  expect(replay.rejectedOversize).toBe(r.rejectedOversize);
});

test("load: payload size enforcement rejects frames above MAX_WS_MESSAGE_BYTES with 1009", () => {
  const ok = JSON.stringify(telemetryFrame(1));
  expect(ingressGate(ok).accepted).toBe(true);
  const oversized = JSON.stringify(telemetryFrame(1)) + " ".repeat(MAX_WS_MESSAGE_BYTES);
  const res = ingressGate(oversized);
  expect(res.accepted).toBe(false);
  expect(res.closedCode).toBe(1009);
  expect(Buffer.byteLength(ok)).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
});

test("hub socketMessage: oversize frames close the real socket path with 1009, bad JSON is dropped", async () => {
  // The hub db module requires DATABASE_URL at import time but connects lazily;
  // these paths return before any query runs.
  process.env.DATABASE_URL ??= "postgres://opspilot:unused@127.0.0.1:1/unused";
  const { socketMessage } = await import("../apps/hub/src/agents");
  const closed: [number, string][] = [];
  const ws = {
    data: { agentId: "00000000-0000-4000-8000-000000000000", sessionId: "s" },
    close(code: number, reason: string) {
      closed.push([code, reason]);
    },
    send() {},
  } as never;
  await socketMessage(ws, "x".repeat(MAX_WS_MESSAGE_BYTES + 1));
  expect(closed).toEqual([[1009, "Message too large"]]);
  await socketMessage(ws, "not json");
  expect(closed.length).toBe(1); // silently dropped, no close
  // Agents advertising a newer wire protocol are refused with 4000 before any DB access.
  await socketMessage(ws, JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1, agentVersion: "9.9.9", capabilities: [] }));
  expect(closed[1]).toEqual([4000, "Unsupported protocol version"]);
});

test("negative: malformed, oversized and non-telemetry frames are never accepted", () => {
  expect(ingressGate("not json at all").accepted).toBe(false);
  expect(ingressGate(JSON.stringify({ noType: true })).accepted).toBe(false);
  const { seq: _seq, ...wire1 } = telemetryFrame(1);
  expect(ingressGate(JSON.stringify({ type: "telemetry", timestamp: "bogus" })).accepted).toBe(false);
  expect(ingressGate(JSON.stringify({ ...wire1, cpuPercent: 101 })).accepted).toBe(false);
  expect(ingressGate(JSON.stringify({ ...wire1, cpuPercent: Infinity })).accepted).toBe(false);
  expect(ingressGate(JSON.stringify({ ...wire1, networkRxBytes: -1 })).accepted).toBe(false);
  expect(ingressGate("x".repeat(MAX_WS_MESSAGE_BYTES + 1)).closedCode).toBe(1009);
});

test("chaos: reconnect storm supersedes old sockets and never leaks registry entries", () => {
  const storm = simulateReconnectStorm(50, 20);
  expect(storm.leaked).toBe(false);
  expect(storm.registrySize).toBeLessThanOrEqual(storm.distinctAgents);
  expect(storm.supersededClosures).toBeGreaterThan(0);
});

test("chaos: duplicate and out-of-order deliveries collapse to unique samples", () => {
  const samples = Array.from({ length: 500 }, (_, i) => telemetryFrame(i));
  const r = simulateDuplicateDelivery(samples, 120);
  expect(r.sent).toBe(620);
  expect(r.uniqueDelivered).toBe(500);
  expect(r.duplicatesDropped).toBe(120);
});

test("chaos: expired worker leases requeue within budget and terminalize when exhausted", () => {
  const now = Date.now();
  const jobs = [
    { id: "j1", attempts: 1, maxAttempts: 3, status: "running" as const, leaseExpiresAt: now - 1 },
    { id: "j2", attempts: 3, maxAttempts: 3, status: "running" as const, leaseExpiresAt: now - 1 },
    { id: "j3", attempts: 1, maxAttempts: 3, status: "running" as const, leaseExpiresAt: now + 60_000 }, // healthy lease untouched
  ];
  const events = simulateLeaseExpiry(jobs, now, 5_000);
  expect(events.find((e) => e.id === "j1")?.outcome).toBe("requeued");
  expect(events.find((e) => e.id === "j1")?.nextRetryInMs).toBe(5_000);
  expect(events.find((e) => e.id === "j2")?.outcome).toBe("failed");
  expect(events.find((e) => e.id === "j3")).toBeUndefined();
  expect(jobs[2].status).toBe("running");
});

test("chaos: queue backpressure under hub outage stays bounded and FIFO", () => {
  const q = simulateQueueBackpressure(10_000, 1_000, 300);
  expect(q.bounded).toBe(true);
  expect(q.droppedOldest).toBe(9_000);
  expect(q.sent).toBe(300);
  expect(q.retained).toBe(700);
  expect(q.fifoHead).toBe(9_300); // capacity eviction dropped the oldest first; oldest retained is the first unsent sample
  expect(q.durableTail).toBe(9_999);
  // Never pushes past capacity even with zero sends.
  const stuck = simulateQueueBackpressure(5_000, 100, 0);
  expect(stuck.retained).toBe(100);
  expect(stuck.bounded).toBe(true);
});

test("chaos: stale and future-skewed timestamps are rejected, fresh ones accepted", () => {
  const r = simulateStaleTimestamps();
  expect(r.fresh).toBe(true); // fresh accepted
  expect(r.stale).toBe(true); // stale rejected
  expect(r.future).toBe(true); // future-skewed rejected
});

test("contracts: real parser accepts generated frames and enforces protocol ceiling", () => {
  const { seq: _seq, ...frame } = telemetryFrame(7);
  expect(parseTelemetry(frame)).not.toBeNull();
  expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  expect(mulberry32(1)()).toBe(mulberry32(1)()); // seeded determinism
});
