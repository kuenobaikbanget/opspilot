import type { SQL } from "bun";
import type { MemorySearchResponse, RetrievedMemoryItem } from "@opspilot/contracts";
import { cosineSimilarity, reciprocalRankFusion } from "@opspilot/ai";
import { MAX_EMBEDDING_DIMENSIONS } from "@opspilot/ai/embeddings";
import { fetchMemorySources } from "./memory-dedup";

/**
 * Database-backed hybrid incident-memory retrieval.
 *
 * Always runs bounded PostgreSQL FTS (`to_tsvector('simple', ...) @@
 * plainto_tsquery('simple', ...)` with `ts_rank_cd`). When a query embedding is
 * supplied, vector candidates are fetched with native `<=>` cosine distance when
 * the pgvector column exists, otherwise via an exact bounded cosine-similarity
 * fallback over the persisted `embedding_values` array, and both rankings are
 * fused with Reciprocal Rank Fusion. Only canonical memories
 * (`canonical_memory_id IS NULL`) are ever candidates, so merged duplicates are
 * never returned by FTS or vector/hybrid search; each result additionally carries
 * its dedup provenance (`occurrence_count`, `last_confirmed_at`,
 * `content_fingerprint`, `sources[]`). This module takes the pool as a parameter
 * (never imports the Hub singleton) so the Worker can reuse it safely.
 */

const DEFAULT_LIMIT = 20;
const DEFAULT_CANDIDATE_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_CANDIDATE_LIMIT = 200;
const MAX_QUERY_CHARS = 500;
/** Minimum cosine similarity for a vector candidate to join the fusion. */
const DEFAULT_MIN_VECTOR_SCORE = 0.2;

type RawMemoryRow = {
  id: string;
  incident_id: string;
  summary: string;
  resolution: string;
  created_at: string | Date;
  embedding_model: string | null;
  occurrence_count: number;
  last_confirmed_at: string | Date | null;
  content_fingerprint: string | null;
};

type MemoryRow = Omit<RawMemoryRow, "created_at"> & {
  created_at: string;
};

type RawFtsRow = RawMemoryRow & { fts_score: number | null };
type FtsRow = MemoryRow & { fts_score: number | null };
type StoredVectorRow = RawMemoryRow & { embedding_values: number[] | null; embedding_dimensions: number | null };

function isoString(value: string | Date): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const pgVectorCache = new WeakMap<SQL, Promise<boolean>>();

/**
 * Checks once per pool whether the native `embedding_vector` column exists
 * (i.e. migration 014 found the pgvector extension). The result is cached on
 * the pool object so repeated searches cost one catalog query at most.
 */
export function hasPgVector(db: SQL): Promise<boolean> {
  let cached = pgVectorCache.get(db);
  if (!cached) {
    cached = db<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'incident_memory' AND column_name = 'embedding_vector'
      ) AS exists
    `.then((rows) => rows[0]?.exists === true).catch(() => false);
    pgVectorCache.set(db, cached);
  }
  return cached;
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

function sanitizeQueryVector(queryVector: number[] | null | undefined): number[] | null {
  if (!queryVector || queryVector.length === 0 || queryVector.length > MAX_EMBEDDING_DIMENSIONS) return null;
  return queryVector.every((component) => typeof component === "number" && Number.isFinite(component))
    ? queryVector
    : null;
}

/** pgvector literal for a validated finite vector: safe to inline, never user text. */
function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

async function fetchFtsCandidates(db: SQL, query: string, candidateLimit: number): Promise<FtsRow[]> {
  const rows = !query
    ? await db<RawFtsRow[]>`
      SELECT id, incident_id, summary, resolution, created_at, embedding_model,
             occurrence_count, last_confirmed_at, content_fingerprint,
             NULL::float8 AS fts_score
      FROM incident_memory
      WHERE canonical_memory_id IS NULL
      ORDER BY created_at DESC, id ASC
      LIMIT ${candidateLimit}
    `
    : await db<RawFtsRow[]>`
      SELECT id, incident_id, summary, resolution, created_at, embedding_model,
             occurrence_count, last_confirmed_at, content_fingerprint,
             ts_rank_cd(
               to_tsvector('simple', summary || ' ' || resolution),
               plainto_tsquery('simple', ${query})
             ) AS fts_score
      FROM incident_memory
      WHERE canonical_memory_id IS NULL
        AND to_tsvector('simple', summary || ' ' || resolution) @@ plainto_tsquery('simple', ${query})
      ORDER BY fts_score DESC, created_at DESC, id ASC
      LIMIT ${candidateLimit}
    `;
  return rows.map((row) => ({ ...row, created_at: isoString(row.created_at) }));
}

async function fetchVectorCandidates(
  db: SQL,
  queryVector: number[],
  candidateLimit: number,
  minVectorScore: number,
): Promise<(MemoryRow & { vector_score: number })[]> {
  const dimensions = queryVector.length;
  if (await hasPgVector(db)) {
    const literal = vectorLiteral(queryVector);
    const rows = await db<(RawMemoryRow & { vector_score: number })[]>`
      SELECT id, incident_id, summary, resolution, created_at, embedding_model,
             occurrence_count, last_confirmed_at, content_fingerprint,
             1 - (embedding_vector <=> ${literal}::vector) AS vector_score
      FROM incident_memory
      WHERE canonical_memory_id IS NULL
        AND embedding_vector IS NOT NULL
        AND embedding_dimensions = ${dimensions}
        AND 1 - (embedding_vector <=> ${literal}::vector) >= ${minVectorScore}
      ORDER BY embedding_vector <=> ${literal}::vector ASC, created_at DESC, id ASC
      LIMIT ${candidateLimit}
    `;
    return rows.map((row) => ({ ...row, created_at: isoString(row.created_at) }));
  }
  // Exact bounded cosine-similarity fallback on plain PostgreSQL 16.
  const rows = await db<StoredVectorRow[]>`
    SELECT id, incident_id, summary, resolution, created_at, embedding_model,
           occurrence_count, last_confirmed_at, content_fingerprint,
           embedding_values, embedding_dimensions
    FROM incident_memory
    WHERE canonical_memory_id IS NULL
      AND embedding_values IS NOT NULL AND embedding_dimensions = ${dimensions}
    ORDER BY embedded_at DESC NULLS LAST, id ASC
    LIMIT ${candidateLimit}
  `;
  return rows
    .map((row) => ({
      id: row.id,
      incident_id: row.incident_id,
      summary: row.summary,
      resolution: row.resolution,
      created_at: isoString(row.created_at),
      embedding_model: row.embedding_model,
      occurrence_count: row.occurrence_count,
      last_confirmed_at: row.last_confirmed_at,
      content_fingerprint: row.content_fingerprint,
      vector_score: cosineSimilarity(queryVector, row.embedding_values ?? []),
    }))
    .filter((row) => row.vector_score >= minVectorScore)
    .sort((a, b) =>
      b.vector_score !== a.vector_score ? b.vector_score - a.vector_score
        : b.created_at !== a.created_at ? (b.created_at < a.created_at ? -1 : 1)
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .slice(0, candidateLimit);
}

export type MemorySearchOptions = {
  /** Query embedding (already redacted/embedded upstream); null/undefined = FTS-only. */
  queryVector?: number[] | null;
  /** Maximum returned results (default 20, max 100). */
  limit?: number;
  /** Maximum candidates fetched per retrieval leg (default 50, max 200). */
  candidateLimit?: number;
  /** Minimum cosine similarity for vector candidates (default 0.2). */
  minVectorScore?: number;
};

/**
 * Hybrid incident-memory search. FTS always runs; when `queryVector` is provided
 * the vector leg is fused in via RRF and results are tagged `hybrid_rrf`,
 * otherwise results are pure FTS tagged `fts`.
 */
export async function searchIncidentMemories(
  db: SQL,
  query: string,
  options: MemorySearchOptions = {},
): Promise<MemorySearchResponse> {
  const text = (query ?? "").slice(0, MAX_QUERY_CHARS).trim();
  const limit = boundedLimit(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const candidateLimit = boundedLimit(options.candidateLimit, DEFAULT_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT);
  const minVectorScore = options.minVectorScore !== undefined && Number.isFinite(options.minVectorScore)
    ? Math.min(1, Math.max(0, options.minVectorScore))
    : DEFAULT_MIN_VECTOR_SCORE;
  const queryVector = sanitizeQueryVector(options.queryVector);

  const ftsRows = await fetchFtsCandidates(db, text, candidateLimit);
  const vectorRows = queryVector
    ? await fetchVectorCandidates(db, queryVector, candidateLimit, minVectorScore)
    : [];

  const fused = reciprocalRankFusion<MemoryRow>(
    ftsRows.map((row) => ({ ...row, fts_score: row.fts_score ?? 0 })),
    vectorRows,
    { limit },
  );

  // Hydrate dedup provenance (sources[]) for the fused canonical memories in one query.
  const sourcesById = await fetchMemorySources(db, fused.map((item) => item.id));

  const results: RetrievedMemoryItem[] = fused.map((item) => ({
    id: item.id,
    incident_id: item.incident_id,
    summary: item.summary,
    resolution: item.resolution,
    created_at: item.created_at,
    retrieval_method: item.retrieval_method,
    fts_score: item.fts_score,
    vector_score: item.vector_score,
    hybrid_score: item.hybrid_score,
    embedding_model: item.embedding_model ?? null,
    occurrence_count: item.occurrence_count ?? 1,
    last_confirmed_at: isoOrNull(item.last_confirmed_at),
    content_fingerprint: item.content_fingerprint ?? null,
    sources: sourcesById.get(item.id) ?? [],
  }));

  return {
    mode: vectorRows.length > 0 ? "hybrid_rrf" : "fts",
    pgvector_available: await hasPgVector(db),
    embedding_enabled: queryVector !== null,
    results,
  };
}
