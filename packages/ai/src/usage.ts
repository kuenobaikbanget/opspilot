import type { Diagnosis, ProviderProtocol } from "@opspilot/contracts";

/**
 * Token usage reported by a provider response, plus an optional USD cost estimate.
 *
 * `estimatedCostUsd` is a best-effort reference estimate from the static catalog
 * below; it is `null` (with `pricingSource: "unknown"`) whenever the model is not
 * in the catalog or the response lacked usable input/output token counts. Costs are
 * never fabricated, and no hard budget block is applied here.
 */
export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  pricingSource: "catalog" | "unknown";
};

export type DiagnosisWithUsage = {
  diagnosis: Diagnosis;
  usage: ProviderUsage;
};

/**
 * Static reference pricing in USD per 1M tokens, for common known models only.
 * Thinking/reasoning tokens are billed at the output rate (Gemini bills thoughts
 * separately from candidatesTokenCount, while OpenAI already includes
 * completion_tokens_details.reasoning_tokens inside completion_tokens).
 * These are vendor list prices at documentation time, not quotes; they exist only to
 * give operators an order-of-magnitude estimate. Unknown or custom models always
 * return `estimatedCostUsd: null`.
 */
const MODEL_PRICING_PER_1M: Record<string, { input: number; output: number }> = {
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
  "gpt-4.1": { input: 2.00, output: 8.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "claude-sonnet-4-5": { input: 3.00, output: 15.00 },
  "claude-3-5-sonnet": { input: 3.00, output: 15.00 },
  "gemini-2.5-flash": { input: 0.30, output: 2.50 },
  "gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
  "gemini-2.5-pro": { input: 1.25, output: 10.00 },
};

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** USD estimate from the static catalog, or null for unknown/custom models or missing input/output counts. */
export function estimateCostUsd(model: string, inputTokens: number | null, outputTokens: number | null, thinkingTokens: number): { estimatedCostUsd: number | null; pricingSource: "catalog" | "unknown" } {
  const pricing = MODEL_PRICING_PER_1M[model];
  if (!pricing || inputTokens === null || outputTokens === null) {
    return { estimatedCostUsd: null, pricingSource: "unknown" };
  }
  const cost = (inputTokens * pricing.input + (outputTokens + thinkingTokens) * pricing.output) / 1_000_000;
  return { estimatedCostUsd: Math.round(cost * 1_000_000) / 1_000_000, pricingSource: "catalog" };
}

function finish(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  thinkingTokens: number,
  totalTokens: number | null,
  thinkingIncludedInOutput = false,
): ProviderUsage {
  const extraThinking = thinkingIncludedInOutput ? 0 : thinkingTokens;
  const total = totalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens + extraThinking : 0);
  const { estimatedCostUsd, pricingSource } = estimateCostUsd(model, inputTokens, outputTokens, extraThinking);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    thinkingTokens,
    totalTokens: Math.max(total, 0),
    estimatedCostUsd,
    pricingSource,
  };
}

/** OpenAI-compatible: usage.prompt_tokens / completion_tokens / total_tokens, optional completion_tokens_details.reasoning_tokens (already included in completion_tokens). */
export function usageFromOpenAICompatible(model: string, response: unknown): ProviderUsage {
  const usage = object(object(response).usage);
  const details = object(usage.completion_tokens_details);
  return finish(
    model,
    nonNegativeInt(usage.prompt_tokens),
    nonNegativeInt(usage.completion_tokens),
    nonNegativeInt(details.reasoning_tokens) ?? 0,
    nonNegativeInt(usage.total_tokens),
    true,
  );
}

/** Anthropic: usage.input_tokens / output_tokens; total computed when omitted. */
export function usageFromAnthropic(model: string, response: unknown): ProviderUsage {
  const usage = object(object(response).usage);
  return finish(
    model,
    nonNegativeInt(usage.input_tokens),
    nonNegativeInt(usage.output_tokens),
    0,
    nonNegativeInt(usage.total_tokens),
  );
}

/** Gemini: usageMetadata.promptTokenCount / candidatesTokenCount / thoughtsTokenCount / totalTokenCount. */
export function usageFromGemini(model: string, response: unknown): ProviderUsage {
  const meta = object(object(response).usageMetadata);
  return finish(
    model,
    nonNegativeInt(meta.promptTokenCount),
    nonNegativeInt(meta.candidatesTokenCount),
    nonNegativeInt(meta.thoughtsTokenCount) ?? 0,
    nonNegativeInt(meta.totalTokenCount),
  );
}

/** Extracts usage from a raw provider response according to its wire protocol. */
export function usageFromProviderResponse(protocol: ProviderProtocol, model: string, response: unknown): ProviderUsage {
  if (protocol === "openai-compatible") return usageFromOpenAICompatible(model, response);
  if (protocol === "anthropic") return usageFromAnthropic(model, response);
  return usageFromGemini(model, response);
}
