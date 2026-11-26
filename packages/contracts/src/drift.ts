/**
 * Drift timeline & semantic diff wire contracts.
 *
 * Agents may — strictly opt-in (`OPSPILOT_CONFIG_DIFFS=true`) and only for paths already
 * listed in their local `OPSPILOT_CONFIG_FILES` allowlist — send bounded, agent-redacted
 * `config_snapshot` frames. The Hub re-validates and re-redacts everything it receives;
 * it never requests arbitrary file paths and never executes shell commands to read files.
 */

/** Maximum bytes of one whole `config_snapshot` WebSocket frame (well below MAX_WS_MESSAGE_BYTES). */
export const MAX_CONFIG_SNAPSHOT_BYTES = 32 * 1024;
/** Maximum UTF-8 bytes of redacted content carried inside one snapshot frame. */
export const MAX_CONFIG_SNAPSHOT_CONTENT_BYTES = 16 * 1024;
/** Maximum length of a snapshot file path (absolute paths only). */
export const MAX_CONFIG_SNAPSHOT_PATH_LENGTH = 256;
/** Maximum accepted redaction count in one frame (defends against absurd counters). */
export const MAX_CONFIG_SNAPSHOT_REDACTIONS = 100_000;
/** Oldest accepted `observedAt` (mirrors telemetry age bounds). */
export const MAX_CONFIG_SNAPSHOT_AGE_MS = 120_000;
/** Maximum future clock skew accepted on agent timestamps. */
export const MAX_CONFIG_SNAPSHOT_SKEW_MS = 5_000;

/** Bounded set of content formats the semantic diff engine understands. */
export type ConfigSnapshotFormat = "dotenv" | "ini" | "json" | "yaml" | "nginx" | "text";

/** Why a snapshot could not carry redacted content (frame stays hash-only). */
export type ConfigSnapshotUnavailableReason =
  | "disabled" // OPSPILOT_CONFIG_DIFFS=false or capability not negotiated
  | "not_allowlisted" // path is not in the agent-local allowlist
  | "not_regular_file" // symlink, directory, device or FIFO
  | "too_large" // > 64 KiB (hash-only tracking up to 1 MiB continues unchanged)
  | "binary_or_unreadable" // NUL bytes or invalid UTF-8
  | "unreadable"; // open/read error

/** Agent-to-hub bounded snapshot of one allowlisted config file. */
export type ConfigSnapshotFrame = {
  type: "config_snapshot";
  version: 1;
  observedAt: string;
  filePath: string;
  checksumSha256: string;
} & (
  | {
      status: "redacted_snapshot";
      format: ConfigSnapshotFormat;
      contentRedacted: string;
      truncated: boolean;
      redactionCount: number;
    }
  | { status: "hash_only"; unavailableReason: ConfigSnapshotUnavailableReason }
);

const CONFIG_SNAPSHOT_FORMATS: readonly string[] = ["dotenv", "ini", "json", "yaml", "nginx", "text"];
const CONFIG_SNAPSHOT_REASONS: readonly string[] = [
  "disabled",
  "not_allowlisted",
  "not_regular_file",
  "too_large",
  "binary_or_unreadable",
  "unreadable",
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SNAPSHOT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Strict validator for `config_snapshot` frames: exact key sets per status, absolute path
 * syntax, SHA-256 format, canonical bounded timestamp, byte caps on content and on the
 * whole serialized frame, and bounded non-negative redaction counts. Returns null on any
 * deviation — unknown keys are rejected, never ignored.
 */
export function parseConfigSnapshot(value: unknown, now = Date.now()): ConfigSnapshotFrame | null {
  if (!isRecord(value) || value.type !== "config_snapshot" || value.version !== 1) return null;
  if (typeof value.observedAt !== "string" || !SNAPSHOT_TIMESTAMP_PATTERN.test(value.observedAt)) return null;
  const time = Date.parse(value.observedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value.observedAt) return null;
  if (time < now - MAX_CONFIG_SNAPSHOT_AGE_MS || time > now + MAX_CONFIG_SNAPSHOT_SKEW_MS) return null;

  const filePath = value.filePath;
  if (
    typeof filePath !== "string" ||
    !filePath.startsWith("/") ||
    filePath.length > MAX_CONFIG_SNAPSHOT_PATH_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(filePath)
  ) {
    return null;
  }
  if (typeof value.checksumSha256 !== "string" || !SHA256_PATTERN.test(value.checksumSha256)) return null;

  if (byteLength(JSON.stringify(value)) > MAX_CONFIG_SNAPSHOT_BYTES) return null;

  const base = {
    type: "config_snapshot" as const,
    version: 1 as const,
    observedAt: value.observedAt,
    filePath,
    checksumSha256: value.checksumSha256,
  };

  if (value.status === "redacted_snapshot") {
    const keys = Object.keys(value);
    if (
      keys.length !== 10 ||
      !["type", "version", "observedAt", "filePath", "checksumSha256", "status", "format", "contentRedacted", "truncated", "redactionCount"]
        .every((key) => Object.hasOwn(value, key))
    ) {
      return null;
    }
    if (typeof value.format !== "string" || !CONFIG_SNAPSHOT_FORMATS.includes(value.format)) return null;
    if (typeof value.contentRedacted !== "string" || byteLength(value.contentRedacted) > MAX_CONFIG_SNAPSHOT_CONTENT_BYTES) return null;
    if (typeof value.truncated !== "boolean") return null;
    if (
      typeof value.redactionCount !== "number" ||
      !Number.isSafeInteger(value.redactionCount) ||
      value.redactionCount < 0 ||
      value.redactionCount > MAX_CONFIG_SNAPSHOT_REDACTIONS
    ) {
      return null;
    }
    return {
      ...base,
      status: "redacted_snapshot",
      format: value.format as ConfigSnapshotFormat,
      contentRedacted: value.contentRedacted,
      truncated: value.truncated,
      redactionCount: value.redactionCount,
    };
  }

  if (value.status === "hash_only") {
    const keys = Object.keys(value);
    if (
      keys.length !== 7 ||
      !["type", "version", "observedAt", "filePath", "checksumSha256", "status", "unavailableReason"]
        .every((key) => Object.hasOwn(value, key))
    ) {
      return null;
    }
    if (typeof value.unavailableReason !== "string" || !CONFIG_SNAPSHOT_REASONS.includes(value.unavailableReason)) return null;
    return {
      ...base,
      status: "hash_only",
      unavailableReason: value.unavailableReason as ConfigSnapshotUnavailableReason,
    };
  }

  return null;
}

/** One structured key/directive change inside a semantic diff. */
export type SemanticDiffChange = {
  kind: "added" | "removed" | "modified";
  key: string;
  section?: string | null;
  before?: string | null;
  after?: string | null;
};

/** Redacted, bounded semantic diff between two snapshots of one file. */
export type SemanticDiffResult = {
  format: ConfigSnapshotFormat;
  summary: string;
  changes: SemanticDiffChange[];
  unifiedDiff: string;
  addedLines: number;
  removedLines: number;
  truncated: boolean;
};

/** Maximum structured changes kept in one semantic diff. */
export const MAX_SEMANTIC_DIFF_CHANGES = 200;
/** Maximum characters of the redacted unified line diff. */
export const MAX_SEMANTIC_UNIFIED_DIFF_CHARS = 6000;
/** Maximum characters kept per before/after value. */
export const MAX_SEMANTIC_VALUE_CHARS = 500;
/** Maximum characters kept per change key / section / summary. */
export const MAX_SEMANTIC_KEY_CHARS = 200;
export const MAX_SEMANTIC_SECTION_CHARS = 100;
export const MAX_SEMANTIC_SUMMARY_CHARS = 400;

/** Structured change counts attached to timeline entries. */
export type DriftChangeCounts = { added: number; removed: number; modified: number };

/** One snapshot transition on the drift timeline. All content is redacted; never raw file bytes. */
export type DriftTimelineEntry = {
  id: string;
  agent_id: string;
  hostname: string;
  file_path: string;
  previous_snapshot_id: string | null;
  previous_checksum_sha256: string | null;
  checksum_sha256: string;
  diff_status: "hash_only" | "diff_available" | "unavailable";
  unavailable_reason: string | null;
  diff_summary: string | null;
  redaction_count: number;
  content_format: ConfigSnapshotFormat | null;
  content_truncated: boolean;
  change_counts: DriftChangeCounts;
  incident_id: string | null;
  captured_at: string;
};

/** `GET /api/drift` response: chronological (newest first) fleet drift timeline. */
export type DriftTimelineResponse = {
  entries: DriftTimelineEntry[];
  limit: number;
  observed_at: string;
};

/** `GET /api/drift/:id` response: one drift transition with its redacted semantic diff. */
export type DriftDetailResponse = DriftTimelineEntry & {
  observed_at: string;
  content_redacted: string | null;
  semantic_diff_json: SemanticDiffResult | null;
};
