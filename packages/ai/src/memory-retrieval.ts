/**
 * Pure hybrid-retrieval math shared by the Hub/Worker SQL layer and the
 * recall benchmark: cosine similarity and Reciprocal Rank Fusion (RRF).
 * Everything here is deterministic and free of I/O.
 */

/**
 * Cosine similarity of two vectors. Returns 0 on length mismatch or when either
 * vector has zero norm (never NaN).
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Clamp float drift so callers can rely on [-1, 1].
  return Math.min(1, Math.max(-1, similarity));
}

/** An FTS-ranked candidate: 1-based rank is its position in the array. */
export type FtsRankedItem<T> = T & { id: string; created_at: string; fts_score: number };
/** A vector-ranked candidate: 1-based rank is its position in the array. */
export type VectorRankedItem<T> = T & { id: string; created_at: string; vector_score: number };

export type RrfOptions = {
  /** RRF constant; dampens the impact of top ranks. Default 60. */
  k?: number;
  /** Weight of the FTS ranking. Default 1. */
  ftsWeight?: number;
  /** Weight of the vector ranking. Default 1. */
  vectorWeight?: number;
  /** Maximum fused results. Default 20. */
  limit?: number;
};

export type FusedItem<T> = T & {
  id: string;
  created_at: string;
  retrieval_method: "fts" | "hybrid_rrf";
  fts_score: number | null;
  vector_score: number | null;
  hybrid_score: number;
};

const DEFAULT_K = 60;
const DEFAULT_LIMIT = 20;

/**
 * Deterministic Reciprocal Rank Fusion over two ranked candidate lists.
 *
 * score(id) = ftsWeight / (k + rank_fts(id)) + vectorWeight / (k + rank_vector(id))
 * where a candidate missing from a list contributes nothing from that list.
 * Ties break by hybrid_score desc, then created_at desc, then id asc.
 *
 * When `vectorRanked` is empty the FTS ranking is returned unchanged, tagged
 * `retrieval_method: "fts"` with `hybrid_score` equal to `fts_score`.
 */
export function reciprocalRankFusion<T extends { id: string; created_at: string }>(
  ftsRanked: readonly FtsRankedItem<T>[],
  vectorRanked: readonly VectorRankedItem<T>[],
  options: RrfOptions = {},
): FusedItem<T>[] {
  const k = options.k !== undefined && Number.isFinite(options.k) && options.k >= 0 ? options.k : DEFAULT_K;
  const ftsWeight = options.ftsWeight !== undefined && Number.isFinite(options.ftsWeight) ? options.ftsWeight : 1;
  const vectorWeight = options.vectorWeight !== undefined && Number.isFinite(options.vectorWeight) ? options.vectorWeight : 1;
  const limit = options.limit !== undefined && Number.isSafeInteger(options.limit) && options.limit >= 0
    ? options.limit
    : DEFAULT_LIMIT;

  const normalizeTimestamp = (value: string | Date): string =>
    value instanceof Date ? (Number.isNaN(value.getTime()) ? "" : value.toISOString()) : value;

  const byId = new Map<string, FusedItem<T>>();
  const ensure = (id: string, created_at: string | Date, base: T): FusedItem<T> => {
    let item = byId.get(id);
    if (!item) {
      item = { ...base, id, created_at: normalizeTimestamp(created_at), retrieval_method: "hybrid_rrf", fts_score: null, vector_score: null, hybrid_score: 0 };
      byId.set(id, item);
    }
    return item;
  };

  ftsRanked.forEach((candidate, index) => {
    const item = ensure(candidate.id, candidate.created_at, candidate as T);
    item.fts_score = candidate.fts_score;
    item.hybrid_score += ftsWeight / (k + index + 1);
  });
  vectorRanked.forEach((candidate, index) => {
    const item = ensure(candidate.id, candidate.created_at, candidate as T);
    item.vector_score = candidate.vector_score;
    item.hybrid_score += vectorWeight / (k + index + 1);
  });

  const fused = [...byId.values()];
  if (vectorRanked.length === 0) {
    // Pure FTS mode: keep the FTS order and scores, tagged as FTS retrieval.
    for (const item of fused) {
      item.retrieval_method = "fts";
      item.hybrid_score = item.fts_score ?? 0;
    }
  }
  fused.sort((a, b) => {
    if (b.hybrid_score !== a.hybrid_score) return b.hybrid_score - a.hybrid_score;
    if (b.created_at !== a.created_at) return b.created_at < a.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return fused.slice(0, limit);
}
