import { expect, test } from "bun:test";
import {
  MAX_WORKLOADS_PER_REPORT,
  parseWorkloadInventory,
} from "../packages/contracts/src/index";

const observedAt = "2026-11-19T12:00:00.123Z";
const now = Date.parse(observedAt);
const base = { type: "workload_inventory", version: 1, observedAt };
const ok = {
  ...base,
  status: "ok",
  workloads: [
    { name: "web", runtime: "docker", state: "running", cpuPercent: 1.5, memoryBytes: 67108864 },
    { name: "nginx.service", runtime: "systemd", state: "stopped", cpuPercent: null, memoryBytes: null },
  ],
};

test("accepts measured, empty, skipped, disabled, unsupported and unavailable inventory reports", () => {
  const accepted = [
    ok,
    { ...base, status: "ok", workloads: [] },
    { ...base, status: "ok", workloads: [], skipped: ["systemd"] },
    { ...ok, skipped: ["docker", "systemd"] },
    { ...base, status: "disabled" },
    { ...base, status: "unsupported" },
    { ...base, status: "unsupported", reason: "systemd_manager_missing" },
    { ...base, status: "unavailable", reason: "docker_daemon_unreachable" },
  ];
  for (const report of accepted) {
    expect(parseWorkloadInventory(report, now)).toEqual(report);
  }
});

test("rejects malformed, over-count, mis-scoped and incompatible inventory reports", () => {
  const rejected = [
    null, [], "workload_inventory", {},
    { ...base, status: "unknown" },
    { ...ok, version: 2 },
    { ...ok, type: "systemd_status" },
    { ...ok, agentId: crypto.randomUUID() },
    { ...ok, workloads: "none" },
    { ...ok, workloads: Array.from({ length: MAX_WORKLOADS_PER_REPORT + 1 }, (_, i) => ({ name: `c${i}`, runtime: "docker", state: "running" })) },
    { ...ok, workloads: [ok.workloads[0], ok.workloads[0]] },
    { ...base, status: "ok" },
    { ...base, status: "ok", skipped: ["docker"] },
    { ...base, status: "disabled", workloads: [] },
    { ...base, status: "disabled", reason: "command_failed" },
    { ...base, status: "unsupported", skipped: ["docker"] },
    { ...base, status: "unavailable" },
    { ...base, status: "unavailable", reason: "not_a_reason" },
    { ...ok, reason: "command_failed" },
    { ...ok, skipped: ["docker", "docker"] },
    { ...ok, skipped: ["podman"] },
    { ...ok, skipped: "docker" },
  ];
  for (const report of rejected) {
    expect(parseWorkloadInventory(report, now)).toBeNull();
  }
});

test("rejects invalid workload names, runtimes, states and resource bounds", () => {
  const badEntries = [
    { name: "--all", runtime: "docker", state: "running" },
    { name: "a b", runtime: "docker", state: "running" },
    { name: "/tmp/x", runtime: "docker", state: "running" },
    { name: "x".repeat(129), runtime: "docker", state: "running" },
    { name: "nginx", runtime: "systemd", state: "running" },
    { name: "nginx.socket", runtime: "systemd", state: "running" },
    { name: "*.service", runtime: "systemd", state: "running" },
    { name: "a.service,b.service", runtime: "systemd", state: "running" },
    { name: "web", runtime: "podman", state: "running" },
    { name: "web", runtime: "docker", state: "exited" },
    { name: "web", runtime: "docker", state: null },
    { name: "web", runtime: "docker", state: "running", cpuPercent: -1 },
    { name: "web", runtime: "docker", state: "running", cpuPercent: 25601 },
    { name: "web", runtime: "docker", state: "running", cpuPercent: "1.5" },
    { name: "web", runtime: "docker", state: "running", memoryBytes: -1 },
    { name: "web", runtime: "docker", state: "running", memoryBytes: 1.5 },
    { name: "web", runtime: "docker", state: "running", memoryBytes: Number.MAX_SAFE_INTEGER + 1 },
    { name: "web", runtime: "docker", state: "running", extra: true },
    "not-an-object",
  ];
  for (const entry of badEntries) {
    expect(parseWorkloadInventory({ ...base, status: "ok", workloads: [entry] }, now)).toBeNull();
  }
  // Null resources are explicit "no measurement", distinct from zero.
  expect(parseWorkloadInventory({ ...base, status: "ok", workloads: [{ name: "web", runtime: "docker", state: "unknown", cpuPercent: null, memoryBytes: null }] }, now)).not.toBeNull();
});

test("rejects invalid, expired or future timestamps", () => {
  for (const time of ["2026-11-19T12:00:00Z", "2026-02-30T12:00:00.123Z", "2026-11-19T12:00:06.123Z", "2026-11-19T11:57:59.123Z", "not a date"]) {
    expect(parseWorkloadInventory({ ...ok, observedAt: time }, now)).toBeNull();
  }
});
