import { describe, expect, test } from "bun:test";
import {
  CONCEPT_VOCABULARY,
  conceptEmbedding,
  evaluateCorpus,
  ftsRank,
  hybridRank,
  rankIds,
  tokenize,
  vectorRank,
} from "./memory-retrieval-fixtures/harness";
import { MEMORY_RECORDS, QUERY_CASES } from "./memory-retrieval-fixtures/corpus";

const evaluation = evaluateCorpus();
const { modes } = evaluation;

describe("repeat-incident recall corpus", () => {
  test("loads 15-20 memory records and 15-20 query cases", () => {
    expect(evaluation.memoryCount).toBeGreaterThanOrEqual(15);
    expect(evaluation.memoryCount).toBeLessThanOrEqual(20);
    expect(evaluation.queryCount).toBeGreaterThanOrEqual(15);
    expect(evaluation.queryCount).toBeLessThanOrEqual(20);
  });

  test("covers exact-keyword, paraphrase/synonym and distractor cases", () => {
    const kinds = new Set(QUERY_CASES.map((entry) => entry.kind));
    expect(kinds).toEqual(new Set(["exact", "paraphrase", "distractor"]));
    expect(QUERY_CASES.filter((entry) => entry.kind === "exact").length).toBeGreaterThanOrEqual(4);
    expect(QUERY_CASES.filter((entry) => entry.kind === "paraphrase").length).toBeGreaterThanOrEqual(6);
    expect(QUERY_CASES.filter((entry) => entry.kind === "distractor").length).toBeGreaterThanOrEqual(3);
  });

  test("every gold expectation references a real memory record", () => {
    const ids = new Set(MEMORY_RECORDS.map((record) => record.id));
    for (const queryCase of QUERY_CASES) {
      for (const expected of queryCase.expected) expect(ids.has(expected)).toBe(true);
    }
  });

  test("paraphrase queries genuinely miss their gold memory under lexical FTS", () => {
    const paraphrases = QUERY_CASES.filter((entry) => entry.kind === "paraphrase");
    let missed = 0;
    for (const queryCase of paraphrases) {
      const top = ftsRank(queryCase.query).slice(0, 5).map((item) => item.id);
      if (!queryCase.expected.some((id) => top.includes(id))) missed++;
    }
    // Vocabulary mismatch is real: most paraphrases are invisible to FTS at rank<=5.
    expect(missed).toBeGreaterThanOrEqual(paraphrases.length / 2);
  });
});

describe("recall benchmark: FTS-only vs vector-only vs hybrid RRF", () => {
  test("reports Recall@1/@3/@5 and MRR for all three modes", () => {
    for (const mode of ["fts", "vector", "hybrid"] as const) {
      const metrics = modes[mode];
      for (const value of [metrics.recallAt1, metrics.recallAt3, metrics.recallAt5, metrics.mrr]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  test("EXIT GATE: hybrid RRF Recall@5 >= 0.85 and strictly above FTS-only Recall@5", () => {
    expect(modes.hybrid.recallAt5).toBeGreaterThanOrEqual(0.85);
    expect(modes.hybrid.recallAt5).toBeGreaterThan(modes.fts.recallAt5);
  });

  test("EXIT GATE: hybrid RRF MRR strictly above FTS-only MRR", () => {
    expect(modes.hybrid.mrr).toBeGreaterThan(modes.fts.mrr);
  });

  test("hybrid preserves exact-term recall (exact cases rank gold at top-1 like FTS)", () => {
    expect(modes.hybrid.byKind.exact.recallAt1).toBe(1);
    expect(modes.hybrid.byKind.exact.recallAt1).toBe(modes.fts.byKind.exact.recallAt1);
    expect(modes.hybrid.byKind.exact.mrr).toBe(modes.fts.byKind.exact.mrr);
  });

  test("hybrid recovers paraphrased repeats that FTS alone misses", () => {
    expect(modes.hybrid.byKind.paraphrase.recallAt5).toBeGreaterThan(modes.fts.byKind.paraphrase.recallAt5);
    expect(modes.hybrid.byKind.paraphrase.recallAt5).toBeGreaterThanOrEqual(0.9);
  });

  test("distractor queries never surface an irrelevant memory at top-1 in any mode", () => {
    for (const mode of ["fts", "vector", "hybrid"] as const) {
      expect(modes[mode].falseTop1Rate).toBe(0);
    }
    for (const queryCase of QUERY_CASES.filter((entry) => entry.kind === "distractor")) {
      expect(rankIds("hybrid", queryCase)).toEqual([]);
    }
  });

  test("hybrid ranking annotates retrieval provenance on every item", () => {
    for (const queryCase of QUERY_CASES) {
      for (const item of hybridRank(queryCase)) {
        expect(["fts", "hybrid_rrf"]).toContain(item.retrieval_method);
        expect(Number.isFinite(item.hybrid_score)).toBe(true);
        if (item.retrieval_method === "hybrid_rrf") {
          expect(item.vector_score === null || item.vector_score >= 0.2).toBe(true);
        }
      }
    }
    // A paraphrase case fused through the vector leg is tagged hybrid_rrf.
    const paraphrase = hybridRank(QUERY_CASES.find((entry) => entry.id === "q-paraphrase-oom")!);
    expect(paraphrase[0].id).toBe("mem-oom-worker");
    expect(paraphrase[0].retrieval_method).toBe("hybrid_rrf");
    expect(paraphrase[0].vector_score).toBeGreaterThan(0.5);
    expect(paraphrase[0].fts_score).toBeNull();
  });

  test("vector-only mode uses deterministic concept embeddings (no network)", () => {
    const embedding = conceptEmbedding(QUERY_CASES[0].concepts);
    expect(embedding.length).toBe(CONCEPT_VOCABULARY.length);
    const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-9);
    expect(vectorRank(embedding).map((item) => item.id)[0]).toBe(QUERY_CASES[0].expected[0]);
  });

  test("tokenizer mirrors the simple tsvector config (lowercase alphanumeric tokens)", () => {
    expect(tokenize("OOM killer terminated worker process")).toEqual(["oom", "killer", "terminated", "worker", "process"]);
    expect(tokenize("proxy_read_timeout too low; 504s")).toEqual(["proxy", "read", "timeout", "too", "low", "504s"]);
  });
});
