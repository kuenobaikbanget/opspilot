import { expect, test } from "bun:test";
import { AI_PROVIDER_PRESETS, finitePercent, isProviderProtocol, parseCreateAiProviderRequest, parseInvestigateRequest, parseUpdateAiProviderRequest, safeTool } from "../packages/contracts/src/index";
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
