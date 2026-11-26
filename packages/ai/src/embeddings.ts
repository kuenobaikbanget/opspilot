import type { ProviderProtocol } from "@opspilot/contracts";
import type { ProviderConnection } from "./index";
import { normalizeProviderBaseUrl, postProviderJson, type ProviderPost } from "./provider-http";
import { redact } from "./redaction";

/** Maximum characters of redacted input sent to an embedding endpoint. */
export const MAX_EMBEDDING_INPUT_CHARS = 2000;
/** Maximum accepted embedding dimensionality. */
export const MAX_EMBEDDING_DIMENSIONS = 4096;

export type EmbeddingErrorCode = "embedding_unsupported" | "embedding_invalid_response";

const messages: Record<EmbeddingErrorCode, string> = {
  embedding_unsupported: "This provider protocol does not offer an embeddings endpoint; use FTS-only memory retrieval.",
  embedding_invalid_response: "Embedding provider returned an invalid vector.",
};

/** Typed embedding failure; never carries upstream bodies, URLs or auth material. */
export class EmbeddingError extends Error {
  constructor(public readonly code: EmbeddingErrorCode) {
    super(messages[code]);
    this.name = "EmbeddingError";
  }
}

/**
 * Anthropic reasoning models do not imply an Anthropic embedding service:
 * only `openai-compatible` and `gemini` connections can produce embeddings.
 */
export function supportsEmbeddings(protocol: ProviderProtocol): boolean {
  return protocol === "openai-compatible" || protocol === "gemini";
}

export type GeneratedEmbedding = {
  vector: number[];
  dimensions: number;
  model: string;
};

function valueAt(value: unknown, path: (string | number)[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(value)) return undefined;
      value = value[key];
    } else {
      value = Object.getOwnPropertyDescriptor(value, key)?.value;
    }
  }
  return value;
}

function extractVector(response: unknown, protocol: ProviderProtocol): unknown {
  if (protocol === "openai-compatible") return valueAt(response, ["data", 0, "embedding"]);
  return valueAt(response, ["embedding", "values"]);
}

/** Validates a provider vector and returns a fresh L2-normalized copy. */
export function normalizeEmbeddingVector(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EMBEDDING_DIMENSIONS) {
    throw new EmbeddingError("embedding_invalid_response");
  }
  const vector: number[] = [];
  let norm = 0;
  for (const component of raw) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new EmbeddingError("embedding_invalid_response");
    }
    vector.push(component);
    norm += component * component;
  }
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) throw new EmbeddingError("embedding_invalid_response");
  return vector.map((component) => component / norm);
}

/**
 * Generates one L2-normalized embedding for `text` through the DNS-pinned public
 * HTTPS egress client. The text is redacted and length-bounded BEFORE any network
 * request; `anthropic` is rejected with `embedding_unsupported` without any I/O.
 */
export async function generateEmbedding(
  connection: ProviderConnection,
  text: string,
  post: ProviderPost = postProviderJson,
): Promise<GeneratedEmbedding> {
  if (!supportsEmbeddings(connection.protocol)) {
    throw new EmbeddingError("embedding_unsupported");
  }
  const input = redact(text).slice(0, MAX_EMBEDDING_INPUT_CHARS);
  if (!input.trim()) throw new EmbeddingError("embedding_invalid_response");
  const baseUrl = normalizeProviderBaseUrl(connection.baseUrl);

  let response: unknown;
  if (connection.protocol === "openai-compatible") {
    response = await post(
      new URL(`${baseUrl}/embeddings`),
      { Authorization: `Bearer ${connection.apiKey}` },
      { model: connection.model, input },
    );
  } else {
    response = await post(
      new URL(`${baseUrl}/models/${encodeURIComponent(connection.model)}:embedContent`),
      { "x-goog-api-key": connection.apiKey },
      {
        model: `models/${connection.model}`,
        content: { parts: [{ text: input }] },
      },
    );
  }

  const vector = normalizeEmbeddingVector(extractVector(response, connection.protocol));
  return { vector, dimensions: vector.length, model: connection.model };
}
