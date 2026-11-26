/**
 * Incident-memory retrieval contracts shared by Hub, Worker and Web.
 *
 * Hybrid retrieval = bounded PostgreSQL full-text search fused with vector
 * similarity (Reciprocal Rank Fusion). Vector search is optional: plain
 * PostgreSQL 16 without the pgvector extension still works through the
 * exact cosine-similarity fallback over `embedding_values`.
 */

import type { MemorySourceProvenance } from "./memory-provenance";

/** How a retrieved memory item was ranked. */
export type MemoryRetrievalMode = "fts" | "hybrid_rrf";

/** Embedding state of a memory row / provider. */
export type MemoryEmbeddingStatus = "none" | "ready" | "unsupported" | "failed";

/** One retrieved canonical incident-memory record with retrieval + dedup provenance. */
export type RetrievedMemoryItem = {
  id: string;
  incident_id: string;
  summary: string;
  resolution: string;
  created_at: string;
  retrieval_method: MemoryRetrievalMode;
  /** Lexical (ts_rank_cd) score; null when the item was not an FTS candidate. */
  fts_score: number | null;
  /** Cosine similarity in [0,1]; null when the item was not a vector candidate. */
  vector_score: number | null;
  /** Reciprocal-rank-fusion score (equals fts_score in pure FTS mode). */
  hybrid_score: number;
  /** Model that produced the stored embedding, if any. */
  embedding_model: string | null;
  /** How often this canonical memory was human-confirmed (merged duplicates count). */
  occurrence_count: number;
  /** ISO timestamp of the latest confirmation; null for legacy rows. */
  last_confirmed_at: string | null;
  /** SHA-256 fingerprint of the normalized summary+resolution; null for legacy rows. */
  content_fingerprint: string | null;
  /** Contributing incidents from `incident_memory_sources`; never dropped on merge. */
  sources: MemorySourceProvenance[];
};

/** Response metadata of a memory search. */
export type MemorySearchResponse = {
  mode: MemoryRetrievalMode;
  /** True when the native pgvector column exists on this database. */
  pgvector_available: boolean;
  /** True when a query embedding was available and fused into the ranking. */
  embedding_enabled: boolean;
  results: RetrievedMemoryItem[];
};
