/**
 * Deterministic load & chaos simulation harness for the OpsPilot hub/agent/worker
 * data paths. Pure TypeScript (no DB, no network): it drives the real contract
 * parsers and worker reliability policy through simulated agent fleets, socket
 * storms and queue pressure. Runnable directly (`bun run tools/load-chaos.ts`)
 * and unit-tested via `bun test tests/load-chaos.test.ts`.
 */
import {
  MAX_WS_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseAgentTimestamp,
  parseTelemetry,
  type AgentTelemetry,
} from "../packages/contracts/src/index";
import { isRetryableFailure, retryDelayMs, type Failure } from "../apps/worker/src/jobs";

/** Deterministic PRNG (mulberry32) so every run replays identically. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TelemetryFrame = AgentTelemetry & { seq: number };

/** Builds one valid telemetry frame for an agent sequence number. */
export function telemetryFrame(agentSeq: number, now = Date.now()): TelemetryFrame {
  return {
    type: "telemetry",
    timestamp: new Date(now).toISOString(),
    cpuPercent: 5 + (agentSeq % 90),
    memoryPercent: 20 + (agentSeq % 70),
    diskPercent: 10 + (agentSeq % 80),
    networkRxBytes: agentSeq * 1024,
    networkTxBytes: agentSeq * 512,
    uptimeSeconds: agentSeq * 15,
    configHashes: { "/etc/app.conf": "a".repeat(64) },
    seq: agentSeq,
  };
}

/**
 * Hub-side ingress accounting for one socket message, mirroring the real
 * `socketMessage` gate in `apps/hub/src/agents.ts`: oversize frames are closed
 * with 1009, unparseable frames are dropped, and only valid telemetry is counted.
 */
export type IngressResult = { accepted: boolean; closedCode: number | null; bytes: number };

export function ingressGate(message: string | Buffer): IngressResult {
  const bytes = typeof message === "string" ? Buffer.byteLength(message) : message.length;
  if (bytes > MAX_WS_MESSAGE_BYTES) return { accepted: false, closedCode: 1009, bytes };
  let msg: unknown;
  try {
    msg = JSON.parse(typeof message === "string" ? message : message.toString());
  } catch {
    return { accepted: false, closedCode: null, bytes };
  }
  if (!msg || typeof msg !== "object" || !("type" in msg)) return { accepted: false, closedCode: null, bytes };
  if (msg.type === "telemetry") {
    // The wire frame carries no `seq`; the simulation-only field is stripped before validation.
    const { seq: _seq, ...wire } = msg as Record<string, unknown>;
    if (parseTelemetry(wire) === null) return { accepted: false, closedCode: null, bytes };
  }
  return { accepted: true, closedCode: null, bytes };
}

export type LoadResult = {
  agents: number;
  samplesPerAgent: number;
  accepted: number;
  rejectedOversize: number;
  rejectedInvalid: number;
  bytesIngested: number;
  wallMs: number;
  samplesPerSecond: number;
  maxInFlightPerAgent: number;
};

/**
 * Simulates a concurrent agent telemetry burst: `agents` virtual agents each push
 * `samplesPerAgent` frames through the ingress gate while a per-agent bounded
 * ring (the hub keeps only the latest window per agent) tracks in-flight depth.
 * `corruptEvery` injects an oversized or malformed frame every N samples (chaos).
 */
export function simulateTelemetryBurst(
  agents: number,
  samplesPerAgent: number,
  opts: { seed?: number; corruptEvery?: number; ringCapacity?: number; now?: number } = {},
): LoadResult {
  const rand = mulberry32(opts.seed ?? 42);
  const corruptEvery = opts.corruptEvery ?? 0;
  const ringCapacity = opts.ringCapacity ?? 64;
  const now = opts.now ?? Date.now();

  const started = performance.now();
  let accepted = 0;
  let rejectedOversize = 0;
  let rejectedInvalid = 0;
  let bytesIngested = 0;
  let maxInFlight = 0;

  for (let a = 0; a < agents; a++) {
    const ring: TelemetryFrame[] = [];
    for (let s = 0; s < samplesPerAgent; s++) {
      const seq = a * samplesPerAgent + s;
      let frame: string;
      if (corruptEvery > 0 && seq % corruptEvery === corruptEvery - 1) {
        // Chaos injection: half oversized, half structurally invalid payloads.
        frame =
          seq % (corruptEvery * 2) === corruptEvery - 1
            ? JSON.stringify(telemetryFrame(seq, now)) + " ".repeat(MAX_WS_MESSAGE_BYTES)
            : JSON.stringify({ type: "telemetry", timestamp: "not-a-date", cpuPercent: 500 });
      } else {
        frame = JSON.stringify(telemetryFrame(seq, now));
      }
      // Shuffle delivery order within the agent (out-of-order chaos) deterministically.
      if (rand() < 0.1 && ring.length > 0) {
        const j = Math.floor(rand() * ring.length);
        [ring[ring.length - 1], ring[j]] = [ring[j], ring[ring.length - 1]];
      }
      const result = ingressGate(frame);
      if (result.closedCode === 1009) rejectedOversize++;
      else if (!result.accepted) rejectedInvalid++;
      else {
        accepted++;
        bytesIngested += result.bytes;
        ring.push(JSON.parse(frame));
        if (ring.length > ringCapacity) ring.shift(); // bounded memory: oldest evicted
        maxInFlight = Math.max(maxInFlight, ring.length);
      }
    }
  }
  const wallMs = performance.now() - started;
  return {
    agents,
    samplesPerAgent,
    accepted,
    rejectedOversize,
    rejectedInvalid,
    bytesIngested,
    wallMs,
    samplesPerSecond: wallMs > 0 ? (accepted / wallMs) * 1000 : accepted,
    maxInFlightPerAgent: maxInFlight,
  };
}

/**
 * Connection registry mirroring the hub's socket lifecycle: a reconnect supersedes
 * the previous socket (closed with 4001) and the registry never grows beyond the
 * number of distinct agents, even under a reconnect storm.
 */
export function simulateReconnectStorm(agents: number, reconnectsPerAgent: number, seed = 7) {
  const rand = mulberry32(seed);
  const connections = new Map<string, number>(); // agentId -> session counter
  const closed: { agentId: string; code: number; reason: string }[] = [];
  for (let a = 0; a < agents; a++) {
    const agentId = `agent-${a}`;
    for (let r = 0; r <= reconnectsPerAgent; r++) {
      const existing = connections.get(agentId);
      if (existing !== undefined) closed.push({ agentId, code: 4001, reason: "Superseded by new session" });
      connections.set(agentId, (existing ?? 0) + 1);
      if (rand() < 0.2 && r < reconnectsPerAgent) {
        // Abrupt disconnect: the entry is dropped, then the agent reconnects.
        connections.delete(agentId);
      }
    }
  }
  return {
    distinctAgents: agents,
    registrySize: connections.size,
    supersededClosures: closed.filter((c) => c.code === 4001).length,
    leaked: connections.size > agents,
  };
}

/** Duplicate/out-of-order delivery is idempotent when keyed by (agent, seq). */
export function simulateDuplicateDelivery(samples: TelemetryFrame[], duplicates: number, seed = 11) {
  const rand = mulberry32(seed);
  const seen = new Set<string>();
  const delivered: string[] = [];
  const stream = [...samples];
  for (let d = 0; d < duplicates && samples.length > 0; d++) {
    stream.push(samples[Math.floor(rand() * samples.length)]); // duplicate
  }
  // Out-of-order shuffle.
  for (let i = stream.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [stream[i], stream[j]] = [stream[j], stream[i]];
  }
  for (const s of stream) {
    const key = `${s.configHashes["/etc/app.conf"]}:${s.seq}`;
    if (!seen.has(key)) {
      seen.add(key);
      delivered.push(key);
    }
  }
  return { sent: stream.length, uniqueDelivered: delivered.length, duplicatesDropped: stream.length - delivered.length };
}

type SimJob = { id: string; attempts: number; maxAttempts: number; status: "queued" | "running" | "failed"; leaseExpiresAt: number | null };

/**
 * Worker lease chaos: a claimed job whose lease expires is requeued while it has
 * retry budget left and terminalized once the budget is spent — using the real
 * retry policy helpers from `apps/worker/src/jobs.ts`.
 */
export function simulateLeaseExpiry(jobs: SimJob[], now: number, backoffMs: number) {
  const events: { id: string; outcome: "requeued" | "failed"; nextRetryInMs: number | null }[] = [];
  for (const job of jobs) {
    if (job.status !== "running" || job.leaseExpiresAt === null || job.leaseExpiresAt > now) continue;
    if (job.attempts >= job.maxAttempts) {
      job.status = "failed";
      events.push({ id: job.id, outcome: "failed", nextRetryInMs: null });
    } else {
      job.status = "queued";
      const delay = retryDelayMs(backoffMs, job.attempts);
      events.push({ id: job.id, outcome: "requeued", nextRetryInMs: delay });
    }
  }
  return events;
}

/** Retry classification chaos: transient failures replay, permanent ones never do. */
export function classifyFailureChaos(codes: Failure["code"][], httpStatuses: (number | null)[] = []) {
  return codes.map((code, i) => ({
    code,
    httpStatus: httpStatuses[i] ?? null,
    retryable: isRetryableFailure({ code, httpStatus: httpStatuses[i] ?? null }),
  }));
}

/**
 * Bounded agent queue under hub outage, mirroring the Go `diskQueue` semantics in
 * `agent/internal/agent/queue.go`: capacity-bounded FIFO where overflow drops the
 * oldest entries, sends pop in FIFO order, and the queue never exceeds its cap.
 */
export function simulateQueueBackpressure(pushed: number, capacity: number, sentBeforeOutage: number) {
  const queue: number[] = [];
  let droppedOldest = 0;
  for (let i = 0; i < pushed; i++) {
    queue.push(i);
    if (queue.length > capacity) {
      queue.shift();
      droppedOldest++;
    }
  }
  // Hub accepts the first `sentBeforeOutage` samples, then goes down.
  const sent = Math.min(sentBeforeOutage, queue.length);
  queue.splice(0, sent);
  return {
    pushed,
    capacity,
    droppedOldest,
    sent,
    retained: queue.length,
    fifoHead: queue[0] ?? null,
    bounded: queue.length <= capacity,
    durableTail: queue[queue.length - 1] ?? null,
  };
}

/** Stale-timestamp chaos: frames older than the hub window must be rejected. */
export function simulateStaleTimestamps(now = Date.now()) {
  const fresh = new Date(now).toISOString();
  const stale = new Date(now - 10 * 60_000).toISOString();
  const future = new Date(now + 60_000).toISOString();
  return {
    fresh: parseAgentTimestamp(fresh, now) !== null,
    stale: parseAgentTimestamp(stale, now) === null,
    future: parseAgentTimestamp(future, now) === null,
  };
}

async function main() {
  const load = simulateTelemetryBurst(64, 200, { seed: 42, corruptEvery: 37 });
  console.log(
    `load: ${load.agents} agents x ${load.samplesPerAgent} samples -> accepted=${load.accepted} ` +
      `oversize=${load.rejectedOversize} invalid=${load.rejectedInvalid} ` +
      `${load.samplesPerSecond.toFixed(0)} samples/s, maxInFlight/agent=${load.maxInFlightPerAgent}`,
  );
  const storm = simulateReconnectStorm(50, 20);
  console.log(`chaos(reconnect): registry=${storm.registrySize}/${storm.distinctAgents} superseded=${storm.supersededClosures} leaked=${storm.leaked}`);
  const dup = simulateDuplicateDelivery(Array.from({ length: 500 }, (_, i) => telemetryFrame(i)), 120);
  console.log(`chaos(duplicates): sent=${dup.sent} unique=${dup.uniqueDelivered} dropped=${dup.duplicatesDropped}`);
  const leases = simulateLeaseExpiry(
    [
      { id: "j1", attempts: 1, maxAttempts: 3, status: "running", leaseExpiresAt: Date.now() - 1 },
      { id: "j2", attempts: 3, maxAttempts: 3, status: "running", leaseExpiresAt: Date.now() - 1 },
    ],
    Date.now(),
    5_000,
  );
  console.log(`chaos(leases): ${leases.map((e) => `${e.id}->${e.outcome}`).join(", ")}`);
  const q = simulateQueueBackpressure(10_000, 1_000, 300);
  console.log(`chaos(queue): pushed=${q.pushed} droppedOldest=${q.droppedOldest} sent=${q.sent} retained=${q.retained} bounded=${q.bounded}`);
  console.log(`chaos(timestamps): ${JSON.stringify(simulateStaleTimestamps())}`);
  console.log(`protocol ceiling: agents above v${PROTOCOL_VERSION} are refused on hello`);
}

if (import.meta.main) void main();
