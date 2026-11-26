import { expect, test } from "bun:test";
import type { ProviderProtocol } from "../packages/contracts/src/index";
import { generateDiagnosis, generateDiagnosisWithUsage, type ProviderConnection } from "../packages/ai/src/index";
import {
  estimateCostUsd,
  usageFromAnthropic,
  usageFromGemini,
  usageFromOpenAICompatible,
  usageFromProviderResponse,
} from "../packages/ai/src/usage";
import { FIXTURE_DUMMY_KEY, fixtureInput, startProviderFixture, type FixtureRequest } from "./helpers/provider-https-fixture";
import type { ServerResponse } from "node:http";

const incident = { title: "Synthetic cost incident", category: "service_failure" };
const evidence = [{ id: "d0000000-0000-4000-8000-000000000041", source: "measured-log", content: "Upstream connection refused; measured sample only." }];

function respondingWith(usage: unknown, perProtocol: "usage" | "usageMetadata"): (request: FixtureRequest, response: ServerResponse) => void {
  return (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const text = JSON.stringify({
      probable_cause: "Synthetic fixture hypothesis; not a confirmed root cause.",
      confidence: "medium",
      evidence_ids: [evidence[0].id],
      missing_evidence: [],
      recommended_checks: [],
    });
    if (request.path.endsWith("/chat/completions")) {
      response.end(JSON.stringify({ choices: [{ message: { content: text } }], [perProtocol]: usage }));
    } else if (request.path.endsWith("/messages")) {
      response.end(JSON.stringify({ content: [{ type: "text", text }], [perProtocol]: usage }));
    } else {
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], [perProtocol]: usage }));
    }
  };
}

test("openai-compatible usage extraction: prompt/completion/total plus reasoning tokens (no double-count)", () => {
  const usage = usageFromOpenAICompatible("gpt-4.1-mini", {
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      completion_tokens_details: { reasoning_tokens: 100 },
    },
  });
  expect(usage).toEqual({
    inputTokens: 1000,
    outputTokens: 500,
    thinkingTokens: 100,
    totalTokens: 1500,
    estimatedCostUsd: 0.0012,
    pricingSource: "catalog",
  });
});

test("openai-compatible usage computes total when omitted without double-counting reasoning tokens", () => {
  const usage = usageFromOpenAICompatible("gpt-4o-mini", {
    usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } },
  });
  expect(usage.inputTokens).toBe(10);
  expect(usage.outputTokens).toBe(5);
  expect(usage.thinkingTokens).toBe(3);
  expect(usage.totalTokens).toBe(15);
  expect(usage.estimatedCostUsd).toBe(0.000005); // rounded to 6 decimals like NUMERIC(12,6)
  expect(usage.pricingSource).toBe("catalog");
});

test("anthropic usage extraction: input/output tokens, computed total, catalog cost", () => {
  const usage = usageFromAnthropic("claude-sonnet-4-5", { usage: { input_tokens: 2000, output_tokens: 1000 } });
  expect(usage).toEqual({
    inputTokens: 2000,
    outputTokens: 1000,
    thinkingTokens: 0,
    totalTokens: 3000,
    estimatedCostUsd: 0.021,
    pricingSource: "catalog",
  });
});

test("gemini usage extraction: prompt/candidates/thoughts/total token counts", () => {
  const usage = usageFromGemini("gemini-2.5-flash", {
    usageMetadata: {
      promptTokenCount: 5000,
      candidatesTokenCount: 1000,
      thoughtsTokenCount: 500,
      totalTokenCount: 6500,
    },
  });
  expect(usage).toEqual({
    inputTokens: 5000,
    outputTokens: 1000,
    thinkingTokens: 500,
    totalTokens: 6500,
    estimatedCostUsd: 0.00525,
    pricingSource: "catalog",
  });
});

test("missing or malformed usage fields never fabricate counts or costs", () => {
  for (const response of [{}, { usage: null }, { usage: { prompt_tokens: "many", completion_tokens: -1 } }, { usageMetadata: { promptTokenCount: 1.5 } }]) {
    const usage = usageFromProviderResponse("openai-compatible", "gpt-4.1", response);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.thinkingTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.estimatedCostUsd).toBeNull();
    expect(usage.pricingSource).toBe("unknown");
  }
});

test("unknown or custom models return null cost with unknown pricing source even with token counts", () => {
  expect(estimateCostUsd("my-fine-tuned-model", 1000, 500, 0)).toEqual({ estimatedCostUsd: null, pricingSource: "unknown" });
  expect(estimateCostUsd("gpt-4.1-mini", null, 500, 0)).toEqual({ estimatedCostUsd: null, pricingSource: "unknown" });
  expect(estimateCostUsd("gpt-4.1-mini", 1000, null, 0)).toEqual({ estimatedCostUsd: null, pricingSource: "unknown" });
  const usage = usageFromAnthropic("custom-local-llm", { usage: { input_tokens: 100, output_tokens: 50 } });
  expect(usage.inputTokens).toBe(100);
  expect(usage.outputTokens).toBe(50);
  expect(usage.estimatedCostUsd).toBeNull();
  expect(usage.pricingSource).toBe("unknown");
});

test("catalog covers every documented reference model", () => {
  for (const model of ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "claude-sonnet-4-5", "claude-3-5-sonnet", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"]) {
    expect(estimateCostUsd(model, 1_000_000, 1_000_000, 0).pricingSource).toBe("catalog");
    expect(estimateCostUsd(model, 1_000_000, 1_000_000, 0).estimatedCostUsd).toBeGreaterThan(0);
  }
});

const protocols: { protocol: ProviderProtocol; model: string; usage: unknown; expected: unknown }[] = [
  {
    protocol: "openai-compatible",
    model: "gpt-4.1-mini",
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, completion_tokens_details: { reasoning_tokens: 100 } },
    expected: { inputTokens: 1000, outputTokens: 500, thinkingTokens: 100, totalTokens: 1500, estimatedCostUsd: 0.0012, pricingSource: "catalog" },
  },
  {
    protocol: "anthropic",
    model: "claude-sonnet-4-5",
    usage: { input_tokens: 2000, output_tokens: 1000 },
    expected: { inputTokens: 2000, outputTokens: 1000, thinkingTokens: 0, totalTokens: 3000, estimatedCostUsd: 0.021, pricingSource: "catalog" },
  },
  {
    protocol: "gemini",
    model: "gemini-2.5-flash",
    usage: { promptTokenCount: 5000, candidatesTokenCount: 1000, thoughtsTokenCount: 500, totalTokenCount: 6500 },
    expected: { inputTokens: 5000, outputTokens: 1000, thinkingTokens: 500, totalTokens: 6500, estimatedCostUsd: 0.00525, pricingSource: "catalog" },
  },
];

for (const { protocol, model, usage, expected } of protocols) {
  test(`${protocol}: generateDiagnosisWithUsage returns diagnosis plus provider usage and catalog cost estimate`, async () => {
    const fixture = await startProviderFixture({ handler: respondingWith(usage, protocol === "gemini" ? "usageMetadata" : "usage") });
    const connection: ProviderConnection = {
      id: "d0000000-0000-4000-8000-000000000011", protocol,
      baseUrl: fixture.baseUrl, apiKey: FIXTURE_DUMMY_KEY, model,
    };
    try {
      const { diagnosis, usage: reported } = await generateDiagnosisWithUsage(connection, incident, evidence, [], fixture.post);
      expect(diagnosis.evidence_ids).toEqual([evidence[0].id]);
      expect(diagnosis.confidence).toBe("medium");
      expect(reported).toEqual(expected);
      expect(fixtureInput(fixture.requests[0]!.body).evidence).toEqual(evidence);
      // Backwards-compatible wrapper returns only the diagnosis.
      const legacy = await generateDiagnosis(connection, incident, evidence, [], fixture.post);
      expect(legacy).toEqual(diagnosis);
      expect("usage" in legacy).toBe(false);
    } finally { await fixture.close(); }
  });

  test(`${protocol}: response without usage metadata yields zeroed usage and null cost`, async () => {
    const fixture = await startProviderFixture(); // default handler sends no usage fields
    const connection: ProviderConnection = {
      id: "d0000000-0000-4000-8000-000000000011", protocol,
      baseUrl: fixture.baseUrl, apiKey: FIXTURE_DUMMY_KEY, model,
    };
    try {
      const { usage } = await generateDiagnosisWithUsage(connection, incident, evidence, [], fixture.post);
      expect(usage).toEqual({
        inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0,
        estimatedCostUsd: null, pricingSource: "unknown",
      });
    } finally { await fixture.close(); }
  });

  test(`${protocol}: custom model name never produces a fabricated cost`, async () => {
    const fixture = await startProviderFixture({ handler: respondingWith(usage, protocol === "gemini" ? "usageMetadata" : "usage") });
    const connection: ProviderConnection = {
      id: "d0000000-0000-4000-8000-000000000011", protocol,
      baseUrl: fixture.baseUrl, apiKey: FIXTURE_DUMMY_KEY, model: "custom-vendor-model-7b-local",
    };
    try {
      const { usage: reported } = await generateDiagnosisWithUsage(connection, incident, evidence, [], fixture.post);
      expect(reported.inputTokens).toBeGreaterThan(0);
      expect(reported.estimatedCostUsd).toBeNull();
      expect(reported.pricingSource).toBe("unknown");
    } finally { await fixture.close(); }
  });
}
