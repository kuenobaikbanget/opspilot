import type {
  EvidenceRelevance,
  EvidenceRelevanceSignal,
  ScoredEvidenceItem,
} from "@opspilot/contracts";

/** Deterministic evidence-relevance scoring: pure, bounded, and auditable — zero LLM calls, zero randomness. */

export type EvidenceLike = {
  id: string;
  source: string;
  content: string;
  created_at?: string | null;
};

export type IncidentLike = {
  title: string;
  category: string;
};

export type SortOptions = {
  /** Place cited evidence first while keeping score as the primary key? */
  citedFirst?: boolean;
};

/**
 * Diagnostic indicators that mark evidence as high-signal for triage.
 * Deliberately transparent so operators can audit why a score was assigned.
 */
const ERROR_INDICATORS = [
  "error",
  "fail",
  "refused",
  "timeout",
  "timed out",
  "oom",
  "killed",
  "502",
  "503",
  "full",
  "100%",
  "exited",
  "inactive",
  "drift",
] as const;

/** Sources whose tool output is generally most diagnostic, ranked first. */
const PRIORITY_SOURCES = new Set(["recent_logs", "service_status"]);

/** Evidence sources whose subject area should match the incident category. */
const CATEGORY_SOURCES: Record<string, string[]> = {
  disk: ["disk_usage", "disk", "disk_space", "df"],
  config_drift: ["config_hash", "config", "drift"],
  service: ["service_status", "recent_logs", "listening_ports", "docker_status"],
  cpu: ["service_status", "recent_logs", "listening_ports", "docker_status"],
  memory: ["service_status", "recent_logs", "listening_ports", "docker_status"],
  manual: ["service_status", "recent_logs", "listening_ports", "disk_usage"],
};

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from",
  "has", "have", "in", "is", "it", "its", "of", "on", "or", "that", "the",
  "this", "to", "was", "were", "will", "with", "not", "no", "after", "over",
]);

const WEIGHTS = {
  cited: 30,
  categoryMatch: 15,
  sourcePriority: 10,
  keywordOverlapPerToken: 5,
  keywordOverlapMax: 20,
  errorSignalPerIndicator: 8,
  errorSignalMax: 24,
} as const;

/** Lowercased alphanumeric tokens with stopwords and single characters removed. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 1 && !STOPWORDS.has(token)) ?? [];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Scores each evidence item for relevance to the incident on a deterministic 0-100 scale.
 * `citedIds` marks evidence referenced by the latest AI hypothesis; unknown IDs are ignored.
 * Identical inputs always produce identical scores, tags and ordering.
 */
export function scoreEvidenceRelevance(
  incident: IncidentLike,
  evidenceList: readonly EvidenceLike[],
  citedIds: readonly string[] = [],
): ScoredEvidenceItem[] {
  const cited = new Set(citedIds.filter((id): id is string => typeof id === "string"));
  const incidentTokens = unique([...tokenize(incident.title), ...tokenize(incident.category)]);
  const categorySources: readonly string[] = CATEGORY_SOURCES[incident.category] ?? [];

  return evidenceList.map((item): ScoredEvidenceItem => {
    const signals: EvidenceRelevanceSignal[] = [];
    let score = 0;

    const isCited = item.id !== "" && cited.has(item.id);
    if (isCited) {
      signals.push("cited_by_hypothesis");
      score += WEIGHTS.cited;
    }

    // Keyword overlap between incident tokens and evidence content/source.
    const evidenceTokens = unique([...tokenize(item.content), ...tokenize(item.source)]);
    const overlap = incidentTokens.filter((token) => evidenceTokens.includes(token));
    if (overlap.length > 0) {
      signals.push("keyword_overlap");
      score += Math.min(WEIGHTS.keywordOverlapMax, overlap.length * WEIGHTS.keywordOverlapPerToken);
    }

    // Diagnostic signal density from bounded error indicators.
    const haystack = `${item.content} ${item.source}`.toLowerCase();
    const indicators = ERROR_INDICATORS.filter((indicator) => haystack.includes(indicator));
    if (indicators.length > 0) {
      signals.push("error_signal");
      score += Math.min(WEIGHTS.errorSignalMax, indicators.length * WEIGHTS.errorSignalPerIndicator);
    }

    // Source relevance to the incident category.
    if (categorySources.some((source) => item.source.toLowerCase().includes(source))) {
      signals.push("category_match");
      score += WEIGHTS.categoryMatch;
    }

    // Generally diagnostic sources, ranked first regardless of category.
    if (PRIORITY_SOURCES.has(item.source.toLowerCase())) {
      signals.push("source_priority");
      score += WEIGHTS.sourcePriority;
    }

    return {
      id: item.id,
      source: item.source,
      content: item.content,
      created_at: item.created_at ?? null,
      relevance: {
        score: clampScore(score),
        cited: isCited,
        matchedSignals: signals,
      },
    };
  });
}

/**
 * Deterministic sort: (cited first, when enabled), score DESC, created_at DESC, then id ASC
 * so the resulting order is 100% reproducible. Returns a new array and never mutates input.
 */
export function sortScoredEvidence(
  items: readonly ScoredEvidenceItem[],
  options: SortOptions = {},
): ScoredEvidenceItem[] {
  return [...items].sort((a, b) => {
    if (options.citedFirst) {
      const citedDelta = Number(b.relevance.cited) - Number(a.relevance.cited);
      if (citedDelta !== 0) return citedDelta;
    }
    if (b.relevance.score !== a.relevance.score) {
      return b.relevance.score - a.relevance.score;
    }
    const aAt = a.created_at ?? "";
    const bAt = b.created_at ?? "";
    if (aAt !== bAt) return aAt < bAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
