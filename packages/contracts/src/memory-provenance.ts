/**
 * Memory deduplication and provenance contracts (Phase 3.4).
 *
 * `incident_memory` rows are canonical, human-confirmed resolutions. Repeat incidents
 * with the same root cause merge into one canonical memory (`occurrence_count` grows)
 * while every contributing incident stays traceable through `incident_memory_sources`.
 * When an investigation retrieves prior memories, the bounded attribution snapshot is
 * persisted on the `investigations` row as `retrieved_memories_json`.
 */

/** One contributing incident of a deduplicated memory; never dropped on merge. */
export type MemorySourceProvenance = {
  incident_id: string;
  agent_id: string | null;
  hostname: string | null;
  category: string | null;
  incident_title: string | null;
  resolved_at: string;
};

/** Canonical memory record as returned by `GET /api/memory`. */
export type IncidentMemoryRecord = {
  id: string;
  incident_id: string;
  summary: string;
  resolution: string;
  created_at: string;
  last_confirmed_at: string;
  occurrence_count: number;
  content_fingerprint: string | null;
  sources: MemorySourceProvenance[];
};

/** Which prior memory an investigation actually used, persisted per investigation. */
export type InvestigationMemoryAttribution = {
  memory_id: string;
  summary: string;
  resolution_preview: string;
  occurrence_count: number;
  source_incident_ids: string[];
  retrieval_method: "fts" | "hybrid_rrf";
  score: number | null;
  last_confirmed_at: string | null;
};

/** Body accepted by `POST /api/memory/merge`. */
export type MergeMemoryRequest = {
  sourceMemoryId: string;
  targetMemoryId: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict merge-request parser: exactly the two UUID fields, both valid UUIDs, and
 * never a self-merge. Unknown keys, missing keys, non-strings or equal IDs reject.
 */
export function parseMergeMemoryRequest(value: unknown): MergeMemoryRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.every((key) => key === "sourceMemoryId" || key === "targetMemoryId")) {
    return null;
  }
  const { sourceMemoryId, targetMemoryId } = value as Record<string, unknown>;
  if (typeof sourceMemoryId !== "string" || !UUID_PATTERN.test(sourceMemoryId)) return null;
  if (typeof targetMemoryId !== "string" || !UUID_PATTERN.test(targetMemoryId)) return null;
  if (sourceMemoryId.toLowerCase() === targetMemoryId.toLowerCase()) return null;
  return { sourceMemoryId, targetMemoryId };
}
