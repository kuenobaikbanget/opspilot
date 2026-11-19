import { expect, test } from "bun:test";
import { parseSystemdReport } from "../packages/contracts/src/index";

const observedAt = "2026-11-19T12:00:00.123Z";
const now = Date.parse(observedAt);
const base = { type: "systemd_status", version: 1, observedAt };
const observed = { ...base, status: "observed", unit: "backup@daily.service", state: "stopped" };

test("accepts measured, intentionally empty, unsupported, and collection-unavailable reports", () => {
  for (const report of [observed, { ...base, status: "disabled" },
    { ...base, status: "unsupported", unit: "example.service" },
    { ...base, status: "unavailable", unit: "example.service" }, { ...base, status: "unavailable" }]) {
    expect(parseSystemdReport(report, now)).toEqual(report);
  }
});

test("rejects malformed, over-count, mis-scoped, and incompatible reports", () => {
  for (const report of [null, [], "systemd_status", { ...base, status: "unknown" },
    { ...observed, version: 2 }, { ...observed, state: "inactive" },
    { ...observed, state: null }, { ...observed, unit: null }, { ...observed, agentId: crypto.randomUUID() },
    { ...base, status: "observed", units: [observed, observed] },
    { ...base, status: "disabled", unit: "example.service" }, { ...base, status: "unsupported" },
    { ...base, status: "unavailable", state: "stopped" }]) {
    expect(parseSystemdReport(report, now)).toBeNull();
  }
});

test("rejects nonliteral service names and invalid, expired or future timestamps", () => {
  for (const unit of ["-n.service", "--all.service", "*.service", "nginx", "nginx.socket", "/tmp/a.service", "foo.service\n", "foo.service\r", "one.service,two.service", "x".repeat(73) + ".service"]) {
    expect(parseSystemdReport({ ...observed, unit }, now)).toBeNull();
  }
  for (const time of ["2026-11-19T12:00:00Z", "2026-02-30T12:00:00.123Z", "2026-11-19T12:00:06.123Z", "2026-11-19T11:57:59.123Z", "not a date"]) {
    expect(parseSystemdReport({ ...observed, observedAt: time }, now)).toBeNull();
  }
});
