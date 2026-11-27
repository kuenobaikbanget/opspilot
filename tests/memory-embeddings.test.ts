import { describe, expect, test } from "bun:test";
import {
  EmbeddingError,
  generateEmbedding,
  MAX_EMBEDDING_DIMENSIONS,
  MAX_EMBEDDING_INPUT_CHARS,
  normalizeEmbeddingVector,
  supportsEmbeddings,
} from "../packages/ai/src/embeddings";
import { ProviderError, type ProviderPost } from "../packages/ai/src/provider-http";
import { cosineSimilarity, reciprocalRankFusion } from "../packages/ai/src/memory-retrieval";
import { encryptProviderKey, readProviderMasterKey } from "../packages/ai/src/credentials";
import { indexPendingMemoryEmbeddings } from "../apps/worker/src/memory-embeddings";
import type { ProviderConnection } from "../packages/ai/src/index";

const openai: ProviderConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  protocol: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test-key-0123456789",
  model: "text-embedding-3-small",
};
const gemini: ProviderConnection = {
  id: "22222222-2222-4222-8222-222222222222",
  protocol: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  apiKey: "gemini-test-key",
  model: "text-embedding-004",
};
const anthropic: ProviderConnection = {
  id: "33333333-3333-4333-8333-333333333333",
  protocol: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "sk-ant-test-key-0123456789",
  model: "claude-sonnet-4-5",
};

type Captured = { url: string; headers: Record<string, string>; body: unknown };

function recordingPost(response: unknown): { post: ProviderPost; calls: Captured[] } {
  const calls: Captured[] = [];
  const post: ProviderPost = async (url, headers, body) => {
    calls.push({ url: url.toString(), headers: { ...headers }, body });
    return response;
  };
  return { post, calls };
}

describe("supportsEmbeddings", () => {
  test("openai-compatible and gemini support embeddings; anthropic does not", () => {
    expect(supportsEmbeddings("openai-compatible")).toBe(true);
    expect(supportsEmbeddings("gemini")).toBe(true);
    expect(supportsEmbeddings("anthropic")).toBe(false);
  });
});

describe("generateEmbedding", () => {
  test("openai-compatible posts to /embeddings with bearer auth and returns an L2-normalized vector", async () => {
    const { post, calls } = recordingPost({ data: [{ embedding: [3, 4] }] });
    const result = await generateEmbedding(openai, "nginx 502 upstream down", post);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${openai.apiKey}`);
    expect(calls[0].body).toEqual({ model: "text-embedding-3-small", input: "nginx 502 upstream down" });
    expect(result.dimensions).toBe(2);
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.vector[0]).toBeCloseTo(0.6, 10);
    expect(result.vector[1]).toBeCloseTo(0.8, 10);
    const norm = Math.hypot(...result.vector);
    expect(Math.abs(norm - 1)).toBeLessThan(1e-12);
  });

  test("gemini posts to /models/<encoded>:embedContent with the API key header", async () => {
    const { post, calls } = recordingPost({ embedding: { values: [1, 2, 2] } });
    const result = await generateEmbedding(gemini, "disk full on root", post);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent");
    expect(calls[0].headers["x-goog-api-key"]).toBe(gemini.apiKey);
    expect(calls[0].body).toEqual({
      model: "models/text-embedding-004",
      content: { parts: [{ text: "disk full on root" }] },
    });
    expect(result.dimensions).toBe(3);
    const norm = Math.hypot(...result.vector);
    expect(Math.abs(norm - 1)).toBeLessThan(1e-12);
  });

  test("anthropic is rejected with embedding_unsupported and makes NO network request", async () => {
    const { post, calls } = recordingPost({});
    let caught: unknown;
    try {
      await generateEmbedding(anthropic, "anything", post);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EmbeddingError);
    expect((caught as EmbeddingError).code).toBe("embedding_unsupported");
    expect(calls.length).toBe(0);
  });

  test("redacts secrets from the input before any outbound request", async () => {
    const { post, calls } = recordingPost({ data: [{ embedding: [1] }] });
    const secret = "sk-live-abcdef1234567890abcdef";
    await generateEmbedding(openai, `resolution used api_key=${secret} and password=hunter2`, post);
    const input = (calls[0].body as { input: string }).input;
    expect(input).not.toContain(secret);
    expect(input).not.toContain("hunter2");
    expect(input).toContain("[REDACTED]");
    expect(JSON.stringify(calls[0].body)).not.toContain(secret);
  });

  test("bounds the redacted input length", async () => {
    const { post, calls } = recordingPost({ data: [{ embedding: [1] }] });
    await generateEmbedding(openai, "x".repeat(MAX_EMBEDDING_INPUT_CHARS * 3), post);
    expect((calls[0].body as { input: string }).input.length).toBe(MAX_EMBEDDING_INPUT_CHARS);
  });

  test("rejects non-HTTPS or malformed base URLs before any request", async () => {
    const { post, calls } = recordingPost({ data: [{ embedding: [1] }] });
    await expect(generateEmbedding({ ...openai, baseUrl: "http://api.openai.com/v1" }, "q", post))
      .rejects.toBeInstanceOf(ProviderError);
    expect(calls.length).toBe(0);
  });

  test("rejects invalid provider vectors without throwing raw errors", async () => {
    const invalid: unknown[] = [
      {},
      { data: [] },
      { data: [{ embedding: [] }] },
      { data: [{ embedding: "nope" }] },
      { data: [{ embedding: [Number.NaN, 1] }] },
      { data: [{ embedding: [Number.POSITIVE_INFINITY, 1] }] },
      { data: [{ embedding: [0, 0] }] },
      { data: [{ embedding: new Array(MAX_EMBEDDING_DIMENSIONS + 1).fill(0.1) }] },
      { embedding: { values: [] } },
    ];
    for (const response of invalid) {
      const { post } = recordingPost(response);
      let caught: unknown;
      try {
        await generateEmbedding(openai, "query", post);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EmbeddingError);
      expect((caught as EmbeddingError).code).toBe("embedding_invalid_response");
    }
    const { post: geminiPost } = recordingPost({ embedding: { values: [1, Number.NaN] } });
    await expect(generateEmbedding(gemini, "query", geminiPost)).rejects.toBeInstanceOf(EmbeddingError);
  });

  test("normalizeEmbeddingVector accepts bounded finite vectors and normalizes them", () => {
    expect(normalizeEmbeddingVector([0, 0, 5])).toEqual([0, 0, 1]);
    expect(() => normalizeEmbeddingVector([])).toThrow(EmbeddingError);
    expect(() => normalizeEmbeddingVector([1, "2" as unknown as number])).toThrow(EmbeddingError);
  });
});

describe("cosineSimilarity", () => {
  test("identical vectors score 1, orthogonal 0, opposite -1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
  });

  test("length mismatch, zero norm and non-finite input score 0 (never NaN)", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([Number.NaN, 1], [1, 1])).toBe(0);
  });
});

describe("reciprocalRankFusion", () => {
  const a = { id: "a", created_at: "2025-01-01T00:00:00.000Z", tag: "A" };
  const b = { id: "b", created_at: "2025-01-02T00:00:00.000Z", tag: "B" };
  const c = { id: "c", created_at: "2025-01-03T00:00:00.000Z", tag: "C" };

  test("fuses both rankings with 1/(k+rank) contributions", () => {
    const fused = reciprocalRankFusion(
      [{ ...a, fts_score: 0.9 }, { ...b, fts_score: 0.5 }],
      [{ ...b, vector_score: 0.8 }, { ...c, vector_score: 0.4 }],
      { k: 60 },
    );
    expect(fused.map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(fused[0].hybrid_score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(fused[0].retrieval_method).toBe("hybrid_rrf");
    expect(fused[0].fts_score).toBe(0.5);
    expect(fused[0].vector_score).toBe(0.8);
    expect(fused[1].vector_score).toBeNull();
    expect(fused[2].fts_score).toBeNull();
  });

  test("empty vector list returns the FTS ranking tagged fts with hybrid_score = fts_score", () => {
    const fused = reciprocalRankFusion([{ ...a, fts_score: 0.7 }, { ...b, fts_score: 0.2 }], []);
    expect(fused.map((item) => item.id)).toEqual(["a", "b"]);
    expect(fused.every((item) => item.retrieval_method === "fts")).toBe(true);
    expect(fused[0].hybrid_score).toBe(0.7);
    expect(fused[0].vector_score).toBeNull();
  });

  test("ties break by hybrid_score desc, created_at desc, id asc (deterministic)", () => {
    const older = { id: "z-old", created_at: "2025-01-01T00:00:00.000Z" };
    const newer = { id: "a-new", created_at: "2025-02-01T00:00:00.000Z" };
    // Equal fusion scores (one FTS rank-1 leg vs one vector rank-1 leg):
    // the newer created_at wins the tie.
    const fused = reciprocalRankFusion(
      [{ ...older, fts_score: 1 }],
      [{ ...newer, vector_score: 1 }],
    );
    expect(fused.map((item) => item.id)).toEqual(["a-new", "z-old"]);
    // Same score, same created_at -> id asc.
    const tie = reciprocalRankFusion(
      [{ id: "b", created_at: "2025-01-01T00:00:00.000Z", fts_score: 1 }, { id: "a", created_at: "2025-01-01T00:00:00.000Z", fts_score: 1 }],
      [],
    );
    expect(tie.map((item) => item.id)).toEqual(["a", "b"]);
    // Distinct Date instances with the exact same timestamp also normalize to ISO strings and tie-break by id asc.
    const dateTie = reciprocalRankFusion(
      [
        { id: "b", created_at: new Date("2025-01-01T00:00:00.000Z") as unknown as string, fts_score: 1 },
        { id: "a", created_at: new Date("2025-01-01T00:00:00.000Z") as unknown as string, fts_score: 1 },
      ],
      [],
    );
    expect(dateTie.map((item) => item.id)).toEqual(["a", "b"]);
    expect(dateTie.every((item) => typeof item.created_at === "string" && item.created_at === "2025-01-01T00:00:00.000Z")).toBe(true);
  });

  test("respects limit, k and weights", () => {
    const fused = reciprocalRankFusion(
      [{ ...a, fts_score: 1 }, { ...b, fts_score: 1 }, { ...c, fts_score: 1 }],
      [{ ...c, vector_score: 1 }],
      { limit: 2, k: 0, ftsWeight: 1, vectorWeight: 10 },
    );
    expect(fused.length).toBe(2);
    expect(fused[0].id).toBe("c"); // vector weight dominates
    expect(fused[0].hybrid_score).toBeCloseTo(1 / 3 + 10, 12);
    const kSensitive = reciprocalRankFusion([{ ...a, fts_score: 1 }], [{ ...a, vector_score: 1 }], { k: 1 });
    expect(kSensitive[0].hybrid_score).toBeCloseTo(1 / 2 + 1 / 2, 12);
  });
});

describe("indexPendingMemoryEmbeddings atomic vector update", () => {
  const masterKey = readProviderMasterKey({ AI_PROVIDER_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" })!;

  function mockPgVectorDb(
    failUpdate: boolean,
    options: {
      consentGranted?: boolean;
      redactPii?: boolean;
      emptyPrivacy?: boolean;
      summary?: string;
      resolution?: string;
    } = {},
  ) {
    const updates: string[] = [];
    const providerId = "11111111-1111-4111-8111-111111111111";
    const ciphertext = encryptProviderKey(providerId, "sk-test-atomic-0123456789", masterKey);
    const exec = async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("FROM privacy_settings")) {
        if (options.emptyPrivacy) return [];
        return [{
          ai_egress_consent_granted: options.consentGranted ?? true,
          consent_version: "2026-04-01",
          consented_at: "2026-04-01T00:00:00.000Z",
          consented_by: "admin",
          redact_pii: options.redactPii ?? false,
          updated_at: "2026-04-01T00:00:00.000Z",
        }];
      }
      if (sql.includes("FROM ai_providers")) {
        return [{ id: providerId, protocol: "openai-compatible", base_url: "https://api.openai.com/v1", default_model: "text-embedding-3-small", api_key_ciphertext: ciphertext }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ exists: true }];
      }
      if (sql.includes("FROM incident_memory")) {
        return [{
          id: "22222222-2222-4222-8222-222222222222",
          summary: options.summary ?? "s",
          resolution: options.resolution ?? "r",
        }];
      }
      if (sql.includes("UPDATE incident_memory")) {
        updates.push(sql);
        if (failUpdate) throw new Error("vector dimension mismatch");
        return [];
      }
      return [];
    };
    const db = Object.assign(
      (strings: TemplateStringsArray) => exec(strings),
      { begin: async <T>(fn: (tx: unknown) => Promise<T>) => fn(exec) },
    );
    return { db: db as never, updates };
  }

  test("updates embedding_values, embedding_vector, and embedded_at in one atomic UPDATE", async () => {
    const { db, updates } = mockPgVectorDb(false);
    const embedFn = async () => ({ vector: [0.6, 0.8], dimensions: 2, model: "text-embedding-3-small" });
    const count = await indexPendingMemoryEmbeddings(db, masterKey, embedFn, { enabled: true });
    expect(count).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("embedding_values =");
    expect(updates[0]).toContain("embedding_vector =");
    expect(updates[0]).toContain("embedded_at = NOW()");
  });

  test("failed vector UPDATE leaves row unprocessed without a partial embedded_at update", async () => {
    const { db, updates } = mockPgVectorDb(true);
    const embedFn = async () => ({ vector: [0.6, 0.8], dimensions: 2, model: "text-embedding-3-small" });
    const count = await indexPendingMemoryEmbeddings(db, masterKey, embedFn, { enabled: true });
    expect(count).toBe(0);
    expect(updates).toHaveLength(1);
  });

  test("skips embedding cleanly when workspace AI egress consent is not granted", async () => {
    for (const opts of [{ consentGranted: false }, { emptyPrivacy: true }]) {
      const { db, updates } = mockPgVectorDb(false, opts);
      let called = false;
      const embedFn = async () => {
        called = true;
        return { vector: [1, 0], dimensions: 2, model: "text-embedding-3-small" };
      };
      const count = await indexPendingMemoryEmbeddings(db, masterKey, embedFn, { enabled: true });
      expect(count).toBe(0);
      expect(called).toBe(false);
      expect(updates).toHaveLength(0);
    }
  });

  test("respects privacy_settings.redact_pii when preparing embedding text", async () => {
    const captured: string[] = [];
    const embedFn = async (_conn: ProviderConnection, text: string) => {
      captured.push(text);
      return { vector: [0.6, 0.8], dimensions: 2, model: "text-embedding-3-small" };
    };

    const piiOn = mockPgVectorDb(false, {
      redactPii: true,
      summary: "Alert from ops@example.com on 10.20.30.40",
      resolution: "Restarted service with password=hunter2secret",
    });
    expect(await indexPendingMemoryEmbeddings(piiOn.db, masterKey, embedFn, { enabled: true })).toBe(1);
    expect(captured[0]).not.toContain("ops@example.com");
    expect(captured[0]).not.toContain("10.20.30.40");
    expect(captured[0]).not.toContain("hunter2secret");
    expect(captured[0]).toContain("[REDACTED_EMAIL]");
    expect(captured[0]).toContain("[REDACTED_IP]");

    const piiOff = mockPgVectorDb(false, {
      redactPii: false,
      summary: "Alert from ops@example.com on 10.20.30.40",
      resolution: "Restarted service with password=hunter2secret",
    });
    expect(await indexPendingMemoryEmbeddings(piiOff.db, masterKey, embedFn, { enabled: true })).toBe(1);
    expect(captured[1]).toContain("ops@example.com");
    expect(captured[1]).toContain("10.20.30.40");
    expect(captured[1]).not.toContain("hunter2secret");
  });
});
