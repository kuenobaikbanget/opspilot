/**
 * Deterministic repeat-incident memory retrieval benchmark harness.
 *
 * Measures Recall@1/@3/@5 and MRR for three retrieval modes over the synthetic
 * corpus in ./corpus.ts:
 *   1. `fts`     — lexical BM25-style ranking with plainto_tsquery AND semantics
 *                  (every query token must occur in the document), mirroring
 *                  `to_tsvector('simple', ...) @@ plainto_tsquery('simple', ...)`
 *                  with a `ts_rank_cd`-style score ordering.
 *   2. `vector`  — cosine similarity over deterministic fixture embeddings
 *                  (multi-hot concept vectors, L2-normalized; NO live API calls).
 *   3. `hybrid`  — Reciprocal Rank Fusion of both rankings (packages/ai).
 *
 * Distractor cases (empty gold) additionally measure the false-top-1 rate:
 * an unrelated query must not surface any memory at rank 1.
 */
import { cosineSimilarity, reciprocalRankFusion, type FusedItem } from "../../packages/ai/src/memory-retrieval";
import { normalizeEmbeddingVector } from "../../packages/ai/src/embeddings";
import { MEMORY_RECORDS, QUERY_CASES, type MemoryRecord, type QueryCase } from "./corpus";

/** Fixed concept vocabulary across the whole corpus (deterministic order). */
export const CONCEPT_VOCABULARY: readonly string[] = [
  ...new Set([...MEMORY_RECORDS, ...QUERY_CASES].flatMap((entry) => entry.concepts)),
].sort();

const conceptIndex = new Map<string, number>(CONCEPT_VOCABULARY.map((concept, index) => [concept, index]));

/** Deterministic fixture embedding: L2-normalized multi-hot concept vector. */
export function conceptEmbedding(concepts: readonly string[]): number[] {
  const vector = new Array<number>(CONCEPT_VOCABULARY.length).fill(0);
  for (const concept of concepts) {
    const index = conceptIndex.get(concept);
    if (index !== undefined) vector[index] = 1;
  }
  return normalizeEmbeddingVector(vector);
}

/** Lowercased alphanumeric tokens, mirroring the `simple` text search config. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

type DocStats = { record: MemoryRecord; tokens: string[]; counts: Map<string, number>; length: number };

function docStats(records: readonly MemoryRecord[]): DocStats[] {
  return records.map((record) => {
    const tokens = tokenize(`${record.summary} ${record.resolution}`);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { record, tokens, counts, length: tokens.length };
  });
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

export type RankedRecord = MemoryRecord & { fts_score: number };
export type VectorRankedRecord = MemoryRecord & { vector_score: number };

/**
 * Lexical FTS ranking: only documents containing EVERY query token are
 * candidates (plainto_tsquery AND semantics); ranked by BM25 over the
 * `summary || ' ' || resolution` document, tie-broken created_at desc, id asc.
 */
export function ftsRank(
  query: string,
  records: readonly MemoryRecord[] = MEMORY_RECORDS,
  candidateLimit = 50,
): RankedRecord[] {
  const docs = docStats(records);
  const queryTokens = [...new Set(tokenize(query))];
  if (!queryTokens.length) return [];
  const df = new Map<string, number>();
  for (const doc of docs) for (const token of doc.counts.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const scored: RankedRecord[] = [];
  for (const doc of docs) {
    if (!queryTokens.every((token) => doc.counts.has(token))) continue;
    let score = 0;
    for (const token of queryTokens) {
      const idf = Math.log(1 + docs.length / (df.get(token) ?? 1));
      const tf = doc.counts.get(token) ?? 0;
      score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgdl))));
    }
    scored.push({ ...doc.record, fts_score: score });
  }
  scored.sort((a, b) =>
    b.fts_score !== a.fts_score ? b.fts_score - a.fts_score
      : b.created_at !== a.created_at ? (b.created_at < a.created_at ? -1 : 1)
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return scored.slice(0, candidateLimit);
}

/** Vector ranking by cosine similarity over fixture embeddings (threshold-filtered). */
export function vectorRank(
  queryVector: readonly number[],
  records: readonly MemoryRecord[] = MEMORY_RECORDS,
  options: { minScore?: number; candidateLimit?: number } = {},
): VectorRankedRecord[] {
  const minScore = options.minScore ?? 0.2;
  const candidateLimit = options.candidateLimit ?? 50;
  const ranked = records
    .map((record) => ({ ...record, vector_score: cosineSimilarity(queryVector, conceptEmbedding(record.concepts)) }))
    .filter((record) => record.vector_score >= minScore);
  ranked.sort((a, b) =>
    b.vector_score !== a.vector_score ? b.vector_score - a.vector_score
      : b.created_at !== a.created_at ? (b.created_at < a.created_at ? -1 : 1)
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return ranked.slice(0, candidateLimit);
}

export type RetrievalModeName = "fts" | "vector" | "hybrid";

export type HybridRankedRecord = FusedItem<MemoryRecord>;

/** Hybrid RRF ranking for one query case (FTS + vector fusion). */
export function hybridRank(queryCase: QueryCase, limit = 20): HybridRankedRecord[] {
  const fts = ftsRank(queryCase.query).map((item) => ({ ...item, fts_score: item.fts_score }));
  const vector = vectorRank(conceptEmbedding(queryCase.concepts));
  return reciprocalRankFusion<MemoryRecord>(fts, vector, { limit });
}

/** Ranked record IDs for one mode. */
export function rankIds(mode: RetrievalModeName, queryCase: QueryCase): string[] {
  if (mode === "fts") return ftsRank(queryCase.query).map((item) => item.id);
  if (mode === "vector") return vectorRank(conceptEmbedding(queryCase.concepts)).map((item) => item.id);
  return hybridRank(queryCase).map((item) => item.id);
}

function recallAtK(rankedIds: readonly string[], expected: readonly string[], k: number): number {
  if (!expected.length) return 0;
  const top = rankedIds.slice(0, k);
  return expected.some((id) => top.includes(id)) ? 1 : 0;
}

function reciprocalRank(rankedIds: readonly string[], expected: readonly string[]): number {
  for (let i = 0; i < rankedIds.length; i++) {
    if (expected.includes(rankedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

export type KindMetrics = {
  count: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
};

export type ModeMetrics = {
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  /** Distractor cases where any memory surfaced at all (must be 0). */
  falseTop1Rate: number;
  byKind: Record<QueryCase["kind"], KindMetrics>;
};

export type CaseResult = {
  queryCase: QueryCase;
  rankedIds: Record<RetrievalModeName, string[]>;
  hybridTop: HybridRankedRecord | null;
};

export type CorpusEvaluation = {
  memoryCount: number;
  queryCount: number;
  cases: CaseResult[];
  modes: Record<RetrievalModeName, ModeMetrics>;
};

function emptyKind(): KindMetrics {
  return { count: 0, recallAt1: 0, recallAt3: 0, recallAt5: 0, mrr: 0 };
}

/** Runs the full benchmark over the corpus and returns per-case and aggregate metrics. */
export function evaluateCorpus(
  records: readonly MemoryRecord[] = MEMORY_RECORDS,
  queryCases: readonly QueryCase[] = QUERY_CASES,
): CorpusEvaluation {
  const cases: CaseResult[] = queryCases.map((queryCase) => {
    const rankedIds: Record<RetrievalModeName, string[]> = {
      fts: rankIds("fts", queryCase),
      vector: rankIds("vector", queryCase),
      hybrid: rankIds("hybrid", queryCase),
    };
    return { queryCase, rankedIds, hybridTop: hybridRank(queryCase)[0] ?? null };
  });

  const modes = {} as Record<RetrievalModeName, ModeMetrics>;
  for (const mode of ["fts", "vector", "hybrid"] as const) {
    const repeatCases = cases.filter((entry) => entry.queryCase.expected.length > 0);
    const distractors = cases.filter((entry) => entry.queryCase.expected.length === 0);
    const byKind = { exact: emptyKind(), paraphrase: emptyKind(), distractor: emptyKind() } as Record<QueryCase["kind"], KindMetrics>;
    for (const entry of repeatCases) {
      const kind = entry.queryCase.kind;
      const bucket = byKind[kind];
      bucket.count++;
      bucket.recallAt1 += recallAtK(entry.rankedIds[mode], entry.queryCase.expected, 1);
      bucket.recallAt3 += recallAtK(entry.rankedIds[mode], entry.queryCase.expected, 3);
      bucket.recallAt5 += recallAtK(entry.rankedIds[mode], entry.queryCase.expected, 5);
      bucket.mrr += reciprocalRank(entry.rankedIds[mode], entry.queryCase.expected);
    }
    for (const kind of ["exact", "paraphrase", "distractor"] as const) {
      const bucket = byKind[kind];
      if (bucket.count) {
        bucket.recallAt1 /= bucket.count;
        bucket.recallAt3 /= bucket.count;
        bucket.recallAt5 /= bucket.count;
        bucket.mrr /= bucket.count;
      }
    }
    modes[mode] = {
      recallAt1: repeatCases.reduce((sum, entry) => sum + recallAtK(entry.rankedIds[mode], entry.queryCase.expected, 1), 0) / Math.max(1, repeatCases.length),
      recallAt3: repeatCases.reduce((sum, entry) => sum + recallAtK(entry.rankedIds[mode], entry.queryCase.expected, 3), 0) / Math.max(1, repeatCases.length),
      recallAt5: repeatCases.reduce((sum, entry) => sum + recallAtK(entry.rankedIds[mode], entry.queryCase.expected, 5), 0) / Math.max(1, repeatCases.length),
      mrr: repeatCases.reduce((sum, entry) => sum + reciprocalRank(entry.rankedIds[mode], entry.queryCase.expected), 0) / Math.max(1, repeatCases.length),
      falseTop1Rate: distractors.length
        ? distractors.reduce((sum, entry) => sum + (entry.rankedIds[mode].length > 0 ? 1 : 0), 0) / distractors.length
        : 0,
      byKind,
    };
  }

  return { memoryCount: records.length, queryCount: queryCases.length, cases, modes };
}
