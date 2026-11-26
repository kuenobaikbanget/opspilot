import { expect, test } from "bun:test";
import { AI_PROVIDER_PRESETS, PROTOCOL_VERSION, finitePercent, isProviderProtocol, negotiateCapabilities, parseAgentCapabilities, parseAgentHello, parseAgentTimestamp, parseCreateAiProviderRequest, parseEnrollRequest, parseInvestigateRequest, parseTelemetry, parseThresholdsUpdate, parseUpdateAiProviderRequest, safeTool } from "../packages/contracts/src/index";
import { redact } from "../packages/ai/src/index";

test("only supported read-only diagnostics", () => {
  expect(safeTool("service_status")).toBe(true);
  expect(safeTool("execute_shell")).toBe(false);
});

test("reject nonfinite or out-of-range metrics", () => {
  expect(finitePercent(30)).toBe(true);
  expect(finitePercent(NaN)).toBe(false);
  expect(finitePercent(-1)).toBe(false);
  expect(finitePercent(101)).toBe(false);
});

test("redact obvious credentials", () => {
  expect(redact("token=secret password=abc")).not.toContain("token=secret");
  expect(redact("Authorization: Bearer abc123")).not.toContain("abc123");
});

const providerInput = {
  ...AI_PROVIDER_PRESETS.openai,
  apiKey: "sk-test-only",
  enabled: true,
};

test("provider protocols and official presets are explicit", () => {
  for (const preset of Object.values(AI_PROVIDER_PRESETS)) expect(isProviderProtocol(preset.protocol)).toBe(true);
  expect(isProviderProtocol("openai")).toBe(false);
  expect(isProviderProtocol(null)).toBe(false);
  expect(AI_PROVIDER_PRESETS.openai.defaultModel).toBe("gpt-4.1-mini");
  expect(AI_PROVIDER_PRESETS.anthropic.defaultModel).toBe("claude-sonnet-4-5");
  expect(AI_PROVIDER_PRESETS.gemini.defaultModel).toBe("gemini-2.5-flash");
});

test("provider create requires every field and trims input", () => {
  expect(parseCreateAiProviderRequest({ ...providerInput, name: "  Team  ", apiKey: " sk-test-only ", defaultModel: " model ", baseUrl: " https://example.com/v1 " })).toEqual({
    ...providerInput, name: "Team", apiKey: "sk-test-only", defaultModel: "model", baseUrl: "https://example.com/v1",
  });
  for (const field of Object.keys(providerInput)) {
    const missing: Record<string, unknown> = { ...providerInput };
    delete missing[field];
    expect(parseCreateAiProviderRequest(missing)).toBeNull();
  }
  for (const input of [null, [], "provider", {}, { ...providerInput, extra: true }, { ...providerInput, enabled: "true" }, { ...providerInput, protocol: "openai" }]) {
    expect(parseCreateAiProviderRequest(input)).toBeNull();
  }
});

test("provider patches reject empty unknown and invalid fields", () => {
  expect(parseUpdateAiProviderRequest({ enabled: false })).toEqual({ enabled: false });
  expect(parseUpdateAiProviderRequest({ name: " Team " })).toEqual({ name: "Team" });
  for (const input of [{}, [], null, { revision: 2 }, { name: "Team", unknown: true }, { apiKey: "" }, { apiKey: "   " }, { apiKey: "a b" }, { apiKey: "a\nb" }, { apiKey: "a\u0000b" }, { enabled: 1 }, { protocol: null }, { name: undefined }]) {
    expect(parseUpdateAiProviderRequest(input)).toBeNull();
  }
});

test("provider text fields enforce trimmed bounds", () => {
  for (const [field, max] of [["name", 80], ["defaultModel", 200], ["baseUrl", 2048], ["apiKey", 4096]] as const) {
    expect(parseUpdateAiProviderRequest({ [field]: "a".repeat(max) })).toEqual({ [field]: "a".repeat(max) });
    for (const input of ["", "  ", "a".repeat(max + 1), null, 1]) {
      expect(parseUpdateAiProviderRequest({ [field]: input })).toBeNull();
    }
  }
});

test("investigation requires explicit provider identity revision and model without legacy aliases", () => {
  const valid = { providerId: "d0000000-0000-4000-8000-000000000001", providerRevision: 1, model: " model " };
  expect(parseInvestigateRequest(valid)).toEqual({ ...valid, model: "model" });
  for (const input of [null, [], {}, { provider: "openai" }, { ...valid, provider: "openai" }, { ...valid, providerId: "bad" }, { ...valid, providerId: null }, { ...valid, model: "" }, { ...valid, model: "a".repeat(201) }]) {
    expect(parseInvestigateRequest(input)).toBeNull();
  }
  for (const providerRevision of [0, -1, 1.5, NaN, Infinity, "1", Number.MAX_SAFE_INTEGER + 1]) {
    expect(parseInvestigateRequest({ ...valid, providerRevision })).toBeNull();
  }
  for (const field of Object.keys(valid)) {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[field];
    expect(parseInvestigateRequest(missing)).toBeNull();
  }
});

const validTelemetry = (now: number) => ({
  type: "telemetry",
  timestamp: new Date(now).toISOString(),
  cpuPercent: 42.5,
  memoryPercent: 60,
  diskPercent: 99.9,
  networkRxBytes: 123456789,
  networkTxBytes: 0,
  uptimeSeconds: 93450,
  configHashes: { "/etc/nginx/nginx.conf": "a".repeat(64) },
});

test("telemetry accepts the exact bounded shape", () => {
  const now = Date.now();
  expect(parseTelemetry(validTelemetry(now), now)).toEqual(validTelemetry(now));
  // RFC 3339 without fraction (Go time.RFC3339) is accepted too.
  const t = { ...validTelemetry(now), timestamp: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z") };
  expect(parseTelemetry(t, now)).toEqual(t);
});

test("telemetry rejects NaN/Inf, out-of-range, fractional or negative counters, bad timestamps and extra keys", () => {
  const now = Date.now();
  const base = validTelemetry(now);
  for (const bad of [
    { ...base, cpuPercent: NaN },
    { ...base, memoryPercent: Infinity },
    { ...base, diskPercent: -Infinity },
    { ...base, cpuPercent: -0.1 },
    { ...base, cpuPercent: 100.0001 },
    { ...base, networkRxBytes: -1 },
    { ...base, networkTxBytes: 1.5 },
    { ...base, uptimeSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, uptimeSeconds: "10" },
    { ...base, timestamp: "2026-11-26 10:00:00Z" },
    { ...base, timestamp: "2026-02-30T00:00:00Z" },
    { ...base, timestamp: new Date(now - 121_000).toISOString() },
    { ...base, timestamp: new Date(now + 6_000).toISOString() },
    { ...base, configHashes: null },
    { ...base, configHashes: [] },
    { ...base, configHashes: { "relative/path": "a".repeat(64) } },
    { ...base, configHashes: { "/etc/x": "ABC" } },
    { ...base, extra: true },
    { ...base, configHashes: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`/f${i}`, "a".repeat(64)])) },
    null, [], "telemetry", {}, { type: "telemetry" },
  ]) {
    expect(parseTelemetry(bad, now)).toBeNull();
  }
  // Missing key rejects even when everything else is valid.
  const missing = { ...base } as Record<string, unknown>;
  delete missing.uptimeSeconds;
  expect(parseTelemetry(missing, now)).toBeNull();
});

test("agent timestamps are canonical UTC and bounded", () => {
  const now = Date.now();
  expect(parseAgentTimestamp(new Date(now).toISOString(), now)).toBe(now);
  expect(parseAgentTimestamp(new Date(now - 119_000).toISOString(), now)).toBe(now - 119_000);
  expect(parseAgentTimestamp(new Date(now - 121_000).toISOString(), now)).toBeNull();
  expect(parseAgentTimestamp(new Date(now + 6_000).toISOString(), now)).toBeNull();
  expect(parseAgentTimestamp("2026-13-01T00:00:00Z", now)).toBeNull();
  expect(parseAgentTimestamp("2026-11-26T00:00:00+01:00", now)).toBeNull();
  expect(parseAgentTimestamp(123, now)).toBeNull();
});

test("hello requires supported protocol version and filters capabilities to the known set", () => {
  expect(parseAgentHello({ type: "hello", protocolVersion: PROTOCOL_VERSION, agentVersion: "0.1.0", capabilities: ["telemetry", "diagnostics"] }))
    .toEqual({ type: "hello", protocolVersion: PROTOCOL_VERSION, agentVersion: "0.1.0", capabilities: ["telemetry", "diagnostics"] });
  // Unknown and duplicate advertised names are ignored, not fatal (forward compatibility).
  expect(parseAgentHello({ type: "hello", protocolVersion: 2, agentVersion: "x", capabilities: ["shell", "telemetry", "telemetry"] }))
    .toEqual({ type: "hello", protocolVersion: 2, agentVersion: "x", capabilities: ["telemetry"] });
  for (const bad of [
    null, [], {}, { type: "hello" },
    { type: "hello", protocolVersion: 0, agentVersion: "x", capabilities: [] },
    { type: "hello", protocolVersion: PROTOCOL_VERSION + 1, agentVersion: "x", capabilities: [] },
    { type: "hello", protocolVersion: 1.5, agentVersion: "x", capabilities: [] },
    { type: "hello", protocolVersion: "2", agentVersion: "x", capabilities: [] },
    { type: "hello", protocolVersion: 2, agentVersion: "", capabilities: [] },
    { type: "hello", protocolVersion: 2, agentVersion: "x", capabilities: "telemetry" },
    { type: "hello", protocolVersion: 2, agentVersion: "x", capabilities: [], extra: 1 },
  ]) {
    expect(parseAgentHello(bad)).toBeNull();
  }
  expect(negotiateCapabilities(["diagnostics", "telemetry"])).toEqual(["telemetry", "diagnostics"]);
  expect(negotiateCapabilities([])).toEqual([]);
  expect(parseAgentCapabilities(["telemetry", "systemd_status", "diagnostics"])).toHaveLength(3);
  expect(parseAgentCapabilities(["telemetry", "telemetry"])).toBeNull();
  expect(parseAgentCapabilities(["shell"])).toBeNull();
  expect(parseAgentCapabilities("telemetry")).toBeNull();
});

test("enrollment parser accepts legacy 3-field bodies and rejects unknown capabilities", () => {
  expect(parseEnrollRequest({ token: " t ", hostname: " h ", version: "0.1.0" }))
    .toEqual({ token: "t", hostname: "h", version: "0.1.0", protocolVersion: 1, capabilities: [] });
  expect(parseEnrollRequest({ token: "t", hostname: "h", version: "0.1.0", protocolVersion: 2, capabilities: ["telemetry"] }))
    .toEqual({ token: "t", hostname: "h", version: "0.1.0", protocolVersion: 2, capabilities: ["telemetry"] });
  for (const bad of [
    null, {}, { token: "", hostname: "h" }, { token: "t", hostname: "" },
    { token: "t", hostname: "h", version: "0.1.0", protocolVersion: 99 },
    { token: "t", hostname: "h", capabilities: ["nope"] },
    { token: "t", hostname: "h", extra: true },
    { token: "t", hostname: "h", version: 5 },
  ]) {
    expect(parseEnrollRequest(bad)).toBeNull();
  }
});

test("threshold updates accept null or finite 0-100 values and reject the rest", () => {
  expect(parseThresholdsUpdate({ cpu_percent: 80, disk_percent: null })).toEqual({ cpu_percent: 80, disk_percent: null });
  expect(parseThresholdsUpdate({ memory_percent: 0 })).toEqual({ memory_percent: 0 });
  for (const bad of [
    null, [], {}, { cpu_percent: -1 }, { cpu_percent: 100.5 }, { cpu_percent: NaN },
    { cpu_percent: Infinity }, { cpu_percent: "90" }, { bogus: 1 }, { cpu_percent: 90, bogus: null },
  ]) {
    expect(parseThresholdsUpdate(bad)).toBeNull();
  }
});
