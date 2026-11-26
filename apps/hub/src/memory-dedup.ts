import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { redact } from "@opspilot/ai";
import type { IncidentMemoryRecord, MemorySourceProvenance } from "@opspilot/contracts";

/**
 * Deterministic memory deduplication and provenance (Phase 3.4).
 *
 * Pure text helpers (normalize/fingerprint/similarity/dedupe) are deterministic and
 * side-effect free; the persistence helpers take a transaction or pool so callers own
 * the transaction boundary. This module intentionally does not import `./db` so unit
 * tests can load it without `DATABASE_URL`.
 */

/** Token-Jaccard similarity at or above which two memories count as near-duplicates. */
export const NEAR_DUPLICATE_THRESHOLD = 0.85;
/** How many recent canonical memories are scanned for near-duplicates on resolve. */
export const MEMORY_CANDIDATE_SCAN_LIMIT = 100;
/** Default page size for `GET /api/memory`. */
export const MEMORY_LIST_LIMIT = 20;
/** Default bound on memories handed to an investigation. */
export const MEMORY_RETRIEVAL_LIMIT = 5;

export type MemoryText = { summary: string; resolution: string };

/** Incident fields needed to record memory provenance for a resolved incident. */
export type ResolvedIncident = {
  id: string;
  agent_id: string;
  title: string;
  category: string;
  resolved_at: Date | string | null;
};

export type RecordMemoryResult = {
  memoryId: string;
  deduplicated: boolean;
  occurrenceCount: number;
};

/** Error carrying an HTTP status/code for the merge route to translate into a response. */
export class MemoryMergeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "MemoryMergeError";
  }
}

/**
 * Deterministic normalization for dedup fingerprints and similarity: lowercase,
 * strip everything that is not a letter/number (punctuation, symbols), collapse
 * whitespace. Case, punctuation and spacing differences never change the result.
 */
export function normalizeMemoryText(summary: string, resolution: string): string {
  return `${summary}\n${resolution}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** SHA-256 hex digest of the normalized summary + resolution; stable across runs. */
export function memoryFingerprint(summary: string, resolution: string): string {
  return createHash("sha256").update(normalizeMemoryText(summary, resolution), "utf8").digest("hex");
}

/**
 * Normalized token Jaccard similarity between two memories, in [0, 1]. The confirmed
 * resolution (the fix) drives near-duplicate detection: repeat incidents legitimately
 * carry different titles/summaries for the same root cause and fix. When a resolution
 * is empty the summary is used instead.
 */
export function memorySimilarity(a: MemoryText, b: MemoryText): number {
  const textA = a.resolution.trim() ? a.resolution : `${a.summary}\n${a.resolution}`;
  const textB = b.resolution.trim() ? b.resolution : `${b.summary}\n${b.resolution}`;
  const tokensA = new Set(normalizeMemoryText(textA, "").split(" ").filter(Boolean));
  const tokensB = new Set(normalizeMemoryText(textB, "").split(" ").filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  return intersection / (tokensA.size + tokensB.size - intersection);
}

/**
 * Guarantees a candidate list never contains exact (same fingerprint) or near-duplicate
 * (similarity >= NEAR_DUPLICATE_THRESHOLD) entries: the first (most relevant) occurrence
 * wins, later duplicates are dropped, and at most `limit` records are returned.
 */
export function deduplicateMemoryCandidates<T extends MemoryText & { id: string }>(
  candidates: readonly T[],
  limit = MEMORY_RETRIEVAL_LIMIT,
): T[] {
  const kept: T[] = [];
  const keptFingerprints: string[] = [];
  for (const candidate of candidates) {
    if (kept.length >= limit) break;
    const fingerprint = memoryFingerprint(candidate.summary, candidate.resolution);
    if (keptFingerprints.includes(fingerprint)) continue;
    if (kept.some((other) => memorySimilarity(other, candidate) >= NEAR_DUPLICATE_THRESHOLD)) continue;
    kept.push(candidate);
    keptFingerprints.push(fingerprint);
  }
  return kept;
}

/** Non-secret audit event; target/data must never contain credentials or raw input. */
async function auditMemory(executor: SQL, action: string, targetId: string | null, data: object): Promise<void> {
  await executor`INSERT INTO audit_events(action,target_id,data) VALUES(${action},${targetId},${data}::jsonb)`;
}

type MemoryRow = {
  id: string;
  incident_id: string;
  summary: string;
  resolution: string;
  created_at: Date;
  last_confirmed_at: Date;
  occurrence_count: number;
  content_fingerprint: string | null;
};

type SourceRow = {
  memory_id: string;
  incident_id: string;
  agent_id: string | null;
  hostname: string | null;
  category: string | null;
  incident_title: string | null;
  resolved_at: Date;
};

function toRecord(row: MemoryRow, sources: MemorySourceProvenance[]): IncidentMemoryRecord {
  return {
    id: row.id,
    incident_id: row.incident_id,
    summary: row.summary,
    resolution: row.resolution,
    created_at: row.created_at.toISOString(),
    last_confirmed_at: row.last_confirmed_at.toISOString(),
    occurrence_count: row.occurrence_count,
    content_fingerprint: row.content_fingerprint,
    sources,
  };
}

function toProvenance(row: SourceRow): MemorySourceProvenance {
  return {
    incident_id: row.incident_id,
    agent_id: row.agent_id,
    hostname: row.hostname,
    category: row.category,
    incident_title: row.incident_title,
    resolved_at: row.resolved_at.toISOString(),
  };
}

/** Hydrates `sources[]` for the given memory ids (UUIDs are server-validated) in one query. */
async function fetchSources(executor: SQL, memoryIds: readonly string[]): Promise<Map<string, MemorySourceProvenance[]>> {
  const grouped = new Map<string, MemorySourceProvenance[]>();
  if (!memoryIds.length) return grouped;
  const rows = await executor<SourceRow[]>`SELECT memory_id,incident_id,agent_id,hostname,category,incident_title,resolved_at
    FROM incident_memory_sources
    WHERE memory_id = ANY(${`{${memoryIds.join(",")}}`}::uuid[])
    ORDER BY resolved_at DESC`;
  for (const row of rows) {
    const list = grouped.get(row.memory_id) ?? [];
    list.push(toProvenance(row));
    grouped.set(row.memory_id, list);
  }
  return grouped;
}

/** Loads one canonical memory with its sources; null when missing or merged away. */
export async function getCanonicalMemory(executor: SQL, memoryId: string): Promise<IncidentMemoryRecord | null> {
  const rows = await executor<MemoryRow[]>`SELECT id,incident_id,summary,resolution,created_at,last_confirmed_at,occurrence_count,content_fingerprint
    FROM incident_memory WHERE id=${memoryId} AND canonical_memory_id IS NULL`;
  if (!rows.length) return null;
  const sources = await fetchSources(executor, [rows[0].id]);
  return toRecord(rows[0], sources.get(rows[0].id) ?? []);
}

/**
 * Records a human-confirmed resolution as incident memory inside the caller's
 * transaction. Text is redacted before fingerprinting/storing. An exact fingerprint
 * match or a near-duplicate (similarity >= threshold) among recent canonical memories
 * increments `occurrence_count`, refreshes `last_confirmed_at`, and appends the
 * incident to `incident_memory_sources` (never dropped). Otherwise a new canonical
 * memory is created. Audits `memory.deduplicated` / `memory.created` with non-secret IDs.
 */
export async function recordResolvedIncidentMemory(
  tx: SQL,
  incident: ResolvedIncident,
  resolution: string,
): Promise<RecordMemoryResult> {
  const summary = redact(incident.title).slice(0, 500);
  const resolutionClean = redact(resolution).slice(0, 3000);
  const fingerprint = memoryFingerprint(summary, resolutionClean);
  const resolvedAt = incident.resolved_at instanceof Date ? incident.resolved_at : new Date();
  const [host] = await tx<{ hostname: string }[]>`SELECT hostname FROM agents WHERE id=${incident.agent_id}`;
  const hostname = host?.hostname ?? null;

  // Defensive: incident_memory.incident_id is unique, so a pre-existing row for this
  // incident (legacy data) is treated as the canonical match instead of a new insert.
  let match: MemoryRow | null =
    (await tx<MemoryRow[]>`SELECT id,incident_id,summary,resolution,created_at,last_confirmed_at,occurrence_count,content_fingerprint
      FROM incident_memory WHERE incident_id=${incident.id} AND canonical_memory_id IS NULL`)[0] ?? null;

  if (!match) {
    const candidates = await tx<MemoryRow[]>`SELECT id,incident_id,summary,resolution,created_at,last_confirmed_at,occurrence_count,content_fingerprint
      FROM incident_memory
      WHERE canonical_memory_id IS NULL
      ORDER BY last_confirmed_at DESC
      LIMIT ${MEMORY_CANDIDATE_SCAN_LIMIT}`;
    const incoming = { summary, resolution: resolutionClean };
    let best: { row: MemoryRow; similarity: number } | null = null;
    for (const candidate of candidates) {
      const candidateFingerprint = candidate.content_fingerprint ?? memoryFingerprint(candidate.summary, candidate.resolution);
      if (candidateFingerprint === fingerprint) {
        match = candidate;
        break;
      }
      const similarity = memorySimilarity(incoming, candidate);
      if (similarity >= NEAR_DUPLICATE_THRESHOLD && (!best || similarity > best.similarity)) {
        best = { row: candidate, similarity };
      }
    }
    match = match ?? best?.row ?? null;
  }

  if (match) {
    const [updated] = await tx<{ occurrence_count: number }[]>`UPDATE incident_memory
      SET occurrence_count=occurrence_count+1, last_confirmed_at=NOW()
      WHERE id=${match.id} AND canonical_memory_id IS NULL
      RETURNING occurrence_count`;
    const occurrenceCount = updated?.occurrence_count ?? match.occurrence_count + 1;
    await tx`INSERT INTO incident_memory_sources(memory_id,incident_id,agent_id,hostname,category,incident_title,resolved_at)
      VALUES(${match.id},${incident.id},${incident.agent_id},${hostname},${incident.category},${summary},${resolvedAt})
      ON CONFLICT DO NOTHING`;
    await auditMemory(tx, "memory.deduplicated", match.id, {
      memoryId: match.id,
      incidentId: incident.id,
      occurrenceCount,
    });
    return { memoryId: match.id, deduplicated: true, occurrenceCount };
  }

  const [created] = await tx<{ id: string }[]>`INSERT INTO incident_memory(incident_id,summary,resolution,content_fingerprint,occurrence_count,last_confirmed_at)
    VALUES(${incident.id},${summary},${resolutionClean},${fingerprint},1,NOW())
    RETURNING id`;
  const memoryId = created.id;
  await tx`INSERT INTO incident_memory_sources(memory_id,incident_id,agent_id,hostname,category,incident_title,resolved_at)
    VALUES(${memoryId},${incident.id},${incident.agent_id},${hostname},${incident.category},${summary},${resolvedAt})
    ON CONFLICT DO NOTHING`;
  await auditMemory(tx, "memory.created", memoryId, { memoryId, incidentId: incident.id });
  return { memoryId, deduplicated: false, occurrenceCount: 1 };
}

/**
 * Lists canonical memories (`canonical_memory_id IS NULL`), optionally filtered by
 * full-text search, deduplicated, each hydrated with its `sources[]` ordered by
 * `resolved_at DESC` so originating incidents/hosts remain visible.
 */
export async function listCanonicalMemories(
  executor: SQL,
  query: string,
  limit = MEMORY_LIST_LIMIT,
): Promise<IncidentMemoryRecord[]> {
  const trimmed = query.trim().slice(0, 100);
  const rows = trimmed
    ? await executor<MemoryRow[]>`SELECT id,incident_id,summary,resolution,created_at,last_confirmed_at,occurrence_count,content_fingerprint
        FROM incident_memory
        WHERE canonical_memory_id IS NULL
          AND to_tsvector('simple',summary || ' ' || resolution) @@ plainto_tsquery('simple',${trimmed})
        ORDER BY last_confirmed_at DESC
        LIMIT ${limit}`
    : await executor<MemoryRow[]>`SELECT id,incident_id,summary,resolution,created_at,last_confirmed_at,occurrence_count,content_fingerprint
        FROM incident_memory
        WHERE canonical_memory_id IS NULL
        ORDER BY last_confirmed_at DESC
        LIMIT ${limit}`;
  const deduplicated = deduplicateMemoryCandidates(rows, limit);
  const sources = await fetchSources(executor, deduplicated.map((row) => row.id));
  return deduplicated.map((row) => toRecord(row, sources.get(row.id) ?? []));
}

/**
 * Transactionally merges `sourceMemoryId` into canonical `targetMemoryId`: all source
 * provenance rows move over (conflicts keep the target's), the source row is marked
 * non-canonical, and the target's `occurrence_count`/`last_confirmed_at` are
 * recomputed from its distinct sources. Audits `memory.merged` with non-secret IDs and
 * returns the updated canonical target record.
 */
export async function mergeMemories(
  executor: SQL,
  sourceMemoryId: string,
  targetMemoryId: string,
): Promise<IncidentMemoryRecord> {
  if (sourceMemoryId.toLowerCase() === targetMemoryId.toLowerCase()) {
    throw new MemoryMergeError("Cannot merge a memory into itself", 400, "invalid_request");
  }
  return await executor.begin(async (tx) => {
    const [source] = await tx<{ id: string; canonical_memory_id: string | null }[]>`
      SELECT id,canonical_memory_id FROM incident_memory WHERE id=${sourceMemoryId} FOR UPDATE`;
    const [target] = await tx<{ id: string; canonical_memory_id: string | null }[]>`
      SELECT id,canonical_memory_id FROM incident_memory WHERE id=${targetMemoryId} FOR UPDATE`;
    if (!source || !target) {
      throw new MemoryMergeError("Memory not found", 404, "not_found");
    }
    if (source.canonical_memory_id !== null || target.canonical_memory_id !== null) {
      throw new MemoryMergeError("Only canonical memories can be merged", 409, "not_canonical");
    }

    await tx`INSERT INTO incident_memory_sources(memory_id,incident_id,agent_id,hostname,category,incident_title,resolved_at)
      SELECT ${targetMemoryId},incident_id,agent_id,hostname,category,incident_title,resolved_at
      FROM incident_memory_sources WHERE memory_id=${sourceMemoryId}
      ON CONFLICT DO NOTHING`;
    await tx`DELETE FROM incident_memory_sources WHERE memory_id=${sourceMemoryId}`;
    await tx`UPDATE incident_memory SET canonical_memory_id=${targetMemoryId} WHERE id=${sourceMemoryId}`;
    const [updated] = await tx<MemoryRow[]>`UPDATE incident_memory SET
        occurrence_count=(SELECT COUNT(DISTINCT incident_id) FROM incident_memory_sources WHERE memory_id=${targetMemoryId}),
        last_confirmed_at=GREATEST(last_confirmed_at,(SELECT MAX(resolved_at) FROM incident_memory_sources WHERE memory_id=${targetMemoryId}))
      WHERE id=${targetMemoryId}
      RETURNING id,incident_id,summary,resolution,created_at,last_confirmed_at,occurrence_count,content_fingerprint`;
    await auditMemory(tx, "memory.merged", targetMemoryId, {
      sourceMemoryId,
      targetMemoryId,
      occurrenceCount: updated.occurrence_count,
    });
    const sources = await fetchSources(tx, [targetMemoryId]);
    return toRecord(updated, sources.get(targetMemoryId) ?? []);
  });
}
