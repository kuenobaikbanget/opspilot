import { type SQL } from "bun";
import { redact } from "@opspilot/ai";
import {
  MAX_CONFIG_SNAPSHOT_CONTENT_BYTES,
  MAX_SEMANTIC_DIFF_CHANGES,
  MAX_SEMANTIC_KEY_CHARS,
  MAX_SEMANTIC_SECTION_CHARS,
  MAX_SEMANTIC_SUMMARY_CHARS,
  MAX_SEMANTIC_UNIFIED_DIFF_CHARS,
  MAX_SEMANTIC_VALUE_CHARS,
  type ConfigSnapshotFormat,
  type ConfigSnapshotFrame,
  type DriftChangeCounts,
  type DriftDetailResponse,
  type DriftTimelineEntry,
  type DriftTimelineResponse,
  type SemanticDiffChange,
  type SemanticDiffResult,
} from "@opspilot/contracts";
import { audit, db } from "./db";
import { addEvidence } from "./incidents";
import { invalid, j, urlUUID } from "./http";

/**
 * Hub-side drift module. The semantic diff engine is pure and deterministic; storage and
 * routes re-validate and re-redact everything (defense in depth — agent redaction is never
 * trusted). All drift output explicitly treats config changes as correlated, not causal.
 */

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/** Detects the config format from the path first, then sniffs the content. */
export function detectConfigFormat(filePath: string, ...samples: (string | null | undefined)[]): ConfigSnapshotFormat {
  const base = (filePath.split("/").pop() ?? "").toLowerCase();
  if (base.endsWith(".json")) return "json";
  if (base.endsWith(".yaml") || base.endsWith(".yml")) return "yaml";
  if (base === ".env" || base.startsWith(".env.") || base.endsWith(".env")) return "dotenv";
  if ([".ini", ".service", ".socket", ".timer", ".mount", ".path"].some((ext) => base.endsWith(ext))) return "ini";
  const lowerPath = filePath.toLowerCase();
  if (base.includes("nginx") || lowerPath.includes("/nginx/")) return "nginx";
  const sample = samples.find((s) => typeof s === "string" && s.trim().length > 0) ?? "";
  const text = sample.slice(0, 8192);
  const first = text.trimStart()[0];
  if (first === "{" || first === "[") {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      /* fall through to line sniffing */
    }
  }
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith(";"));
  if (lines.length > 0 && lines.every((l) => /^[A-Za-z_][A-Za-z0-9_.-]*\s*=/.test(l))) return "dotenv";
  if (lines.some((l) => /^\[.+\]$/.test(l))) return "ini";
  if (base.endsWith(".conf")) return "nginx";
  return "text";
}

// ---------------------------------------------------------------------------
// Structured parsers (key -> {section, value})
// ---------------------------------------------------------------------------

type Entry = { key: string; section: string | null; value: string };
type EntryMap = Map<string, Entry>;

function parseDotenv(content: string): EntryMap {
  const out: EntryMap = new Map();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out.set(m[1], { key: m[1], section: null, value });
  }
  return out;
}

function parseIni(content: string): EntryMap {
  const out: EntryMap = new Map();
  let section: string | null = null;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    let key: string, value: string;
    const eq = line.indexOf("=");
    const colon = line.indexOf(":");
    if (eq >= 0 && (colon < 0 || eq < colon)) {
      key = line.slice(0, eq).trim();
      value = line.slice(eq + 1).trim();
    } else if (colon >= 0) {
      key = line.slice(0, colon).trim();
      value = line.slice(colon + 1).trim();
    } else {
      continue;
    }
    if (!key) continue;
    out.set(`${section ?? ""}\u0000${key}`, { key, section, value });
  }
  return out;
}

function parseJson(content: string): EntryMap | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  const out: EntryMap = new Map();
  const walk = (prefix: string, value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix ? `${prefix}.${k}` : k, v);
      }
      return;
    }
    out.set(prefix, { key: prefix, section: null, value: typeof value === "string" ? value : JSON.stringify(value) });
  };
  walk("", data);
  return out;
}

/** Minimal YAML subset: nested `key: value` maps flattened to dotted paths; list items joined. */
function parseYaml(content: string): EntryMap {
  const out: EntryMap = new Map();
  const stack: { indent: number; key: string }[] = [];
  for (const raw of content.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const item = /^-(?:\s+(.*))?$/.exec(line);
    if (item) {
      const parent = stack[stack.length - 1];
      if (parent) {
        const k = `${parent.key}[]`;
        const prev = out.get(k);
        const v = (item[1] ?? "").trim();
        out.set(k, { key: k, section: null, value: prev ? `${prev.value}, ${v}` : v });
      }
      continue;
    }
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    let value = m[2].trim();
    const hash = value.indexOf(" #");
    if (hash >= 0) value = value.slice(0, hash).trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const path = parent ? `${parent.key}.${key}` : key;
    if (value === "") {
      stack.push({ indent, key: path });
    } else {
      out.set(path, { key: path, section: null, value });
    }
  }
  return out;
}

/** Nginx-style directives with brace-delimited blocks tracked as sections. */
function parseNginx(content: string): EntryMap {
  const out: EntryMap = new Map();
  const sections: string[] = [];
  const counts = new Map<string, number>();
  for (const raw of content.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    const body = line.replace(/[{}]/g, " ").trim();
    if (body) {
      const parts = body.replace(/;$/, "").trim().split(/\s+/);
      const directive = parts[0] ?? "";
      const args = parts.slice(1).join(" ");
      const section = sections.length ? sections.join(" > ") : null;
      const sig = `${section ?? ""}\u0000${directive}`;
      const n = (counts.get(sig) ?? 0) + 1;
      counts.set(sig, n);
      const key = n === 1 ? directive : `${directive}#${n}`;
      out.set(`${section ?? ""}\u0000${key}`, { key, section, value: args });
      for (let i = 0; i < opens; i++) sections.push(body.replace(/;$/, "").trim());
    }
    for (let i = 0; i < closes; i++) sections.pop();
  }
  return out;
}

function parseByFormat(format: ConfigSnapshotFormat, content: string): EntryMap | null {
  switch (format) {
    case "dotenv": return parseDotenv(content);
    case "ini": return parseIni(content);
    case "json": return parseJson(content);
    case "yaml": return parseYaml(content);
    case "nginx": return parseNginx(content);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

function diffMaps(before: EntryMap, after: EntryMap): SemanticDiffChange[] {
  const changes: SemanticDiffChange[] = [];
  for (const [mapKey, b] of before) {
    const a = after.get(mapKey);
    if (!a) {
      changes.push({ kind: "removed", key: b.key, section: b.section, before: b.value, after: null });
    } else if (a.value !== b.value) {
      changes.push({ kind: "modified", key: b.key, section: b.section, before: b.value, after: a.value });
    }
  }
  for (const [mapKey, a] of after) {
    if (!before.has(mapKey)) {
      changes.push({ kind: "added", key: a.key, section: a.section, before: null, after: a.value });
    }
  }
  changes.sort((x, y) => x.kind.localeCompare(y.kind) || x.key.localeCompare(y.key));
  return changes;
}

function clipLine(line: string): string {
  return line.length > MAX_SEMANTIC_VALUE_CHARS
    ? `${line.slice(0, MAX_SEMANTIC_VALUE_CHARS)}…[line truncated]`
    : line;
}

/** Bounded LCS line diff rendered as `-`/`+` lines with an @@ header. */
function unifiedLineDiff(before: string, after: string): { diff: string; added: number; removed: number; truncated: boolean } {
  const a = before.split("\n");
  const b = after.split("\n");
  let truncated = false;
  let lines: string[];
  if (a.length * b.length > 250_000) {
    // Too large for an exact LCS: coarse whole-file replacement, explicitly truncated.
    truncated = true;
    lines = ["@@ diff too large; showing full replacement @@"];
    lines.push(...a.map((l) => `- ${clipLine(l)}`));
    lines.push(...b.map((l) => `+ ${clipLine(l)}`));
  } else {
    const n = a.length;
    const m = b.length;
    const dp = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = a[i] === b[j]
          ? dp[(i + 1) * (m + 1) + (j + 1)] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
      }
    }
    lines = [`@@ ${n} -> ${m} lines @@`];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        i++;
        j++;
      } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) {
        lines.push(`- ${clipLine(a[i])}`);
        i++;
      } else {
        lines.push(`+ ${clipLine(b[j])}`);
        j++;
      }
    }
    while (i < n) lines.push(`- ${clipLine(a[i++])}`);
    while (j < m) lines.push(`+ ${clipLine(b[j++])}`);
  }
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+ ") && !line.startsWith("+++")) added++;
    else if (line.startsWith("- ") && !line.startsWith("---")) removed++;
  }
  let text = lines.join("\n");
  if (text.length > MAX_SEMANTIC_UNIFIED_DIFF_CHARS) {
    text = `${text.slice(0, MAX_SEMANTIC_UNIFIED_DIFF_CHARS)}\n…[diff truncated]`;
    truncated = true;
  }
  return { diff: text, added, removed, truncated };
}

function textChanges(before: string, after: string): SemanticDiffChange[] {
  const { diff } = unifiedLineDiff(before, after);
  const changes: SemanticDiffChange[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+ ") && !line.startsWith("+++")) {
      changes.push({ kind: "added", key: clipLine(line.slice(2)), section: null, before: null, after: null });
    } else if (line.startsWith("- ") && !line.startsWith("---")) {
      changes.push({ kind: "removed", key: clipLine(line.slice(2)), section: null, before: null, after: null });
    }
  }
  return changes;
}

function summarize(format: ConfigSnapshotFormat, changes: SemanticDiffChange[]): string {
  const counts = { added: 0, removed: 0, modified: 0 };
  for (const c of changes) counts[c.kind]++;
  const names = (kind: SemanticDiffChange["kind"]) =>
    changes.filter((c) => c.kind === kind).map((c) => c.key).slice(0, 5);
  const parts: string[] = [];
  if (counts.modified) {
    const list = names("modified");
    parts.push(`${counts.modified} key${counts.modified === 1 ? "" : "s"} modified${list.length ? ` (${list.join(", ")})` : ""}`);
  }
  if (counts.added) {
    const list = names("added");
    parts.push(`${counts.added} added${list.length ? ` (${list.join(", ")})` : ""}`);
  }
  if (counts.removed) {
    const list = names("removed");
    parts.push(`${counts.removed} removed${list.length ? ` (${list.join(", ")})` : ""}`);
  }
  if (!parts.length) return "No key-level changes detected";
  return `${format}: ${parts.join(", ")}`;
}

/**
 * Pure semantic diff between two (already agent-redacted) snapshots of one file. Every input
 * and output is passed through `redact()` again as defense in depth, and all output is
 * bounded. Never returns raw file content.
 */
export function computeSemanticDiff(filePath: string, beforeContent: string, afterContent: string): SemanticDiffResult {
  const before = redact(beforeContent);
  const after = redact(afterContent);
  let format = detectConfigFormat(filePath, before, after);
  let beforeMap = parseByFormat(format, before);
  let afterMap = parseByFormat(format, after);
  if (format === "json" && (!beforeMap || !afterMap)) {
    // Invalid JSON on either side: fall back to a plain line diff.
    format = "text";
    beforeMap = null;
    afterMap = null;
  }
  let changes: SemanticDiffChange[];
  if (format === "text" || !beforeMap || !afterMap) {
    changes = textChanges(before, after);
  } else {
    changes = diffMaps(beforeMap, afterMap);
  }
  const capped = changes.length > MAX_SEMANTIC_DIFF_CHANGES;
  changes = changes.slice(0, MAX_SEMANTIC_DIFF_CHANGES).map((c) => ({
    kind: c.kind,
    key: redact(c.key).slice(0, MAX_SEMANTIC_KEY_CHARS),
    section: c.section == null ? null : redact(c.section).slice(0, MAX_SEMANTIC_SECTION_CHARS),
    before: c.before == null ? null : redact(c.before).slice(0, MAX_SEMANTIC_VALUE_CHARS),
    after: c.after == null ? null : redact(c.after).slice(0, MAX_SEMANTIC_VALUE_CHARS),
  }));
  const unified = unifiedLineDiff(before, after);
  const summary = redact(summarize(format, changes)).slice(0, MAX_SEMANTIC_SUMMARY_CHARS);
  return {
    format,
    summary,
    changes,
    unifiedDiff: redact(unified.diff),
    addedLines: unified.added,
    removedLines: unified.removed,
    truncated: unified.truncated || capped,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

type SnapshotRow = {
  id: string;
  checksum_sha256: string;
  content_redacted: string | null;
  captured_at: Date;
};

/** Re-redacts and byte-bounds received content; the agent's own redaction is never trusted. */
function boundRedacted(content: string): string {
  const cleaned = redact(content);
  if (new TextEncoder().encode(cleaned).length <= MAX_CONFIG_SNAPSHOT_CONTENT_BYTES) return cleaned;
  return cleaned.slice(0, MAX_CONFIG_SNAPSHOT_CONTENT_BYTES);
}

function changeCountsOf(diff: unknown): DriftChangeCounts {
  const counts: DriftChangeCounts = { added: 0, removed: 0, modified: 0 };
  if (!diff || typeof diff !== "object" || !Array.isArray((diff as { changes?: unknown }).changes)) return counts;
  for (const c of (diff as { changes: unknown[] }).changes) {
    if (c && typeof c === "object" && (c as { kind?: unknown }).kind === "added") counts.added++;
    else if (c && typeof c === "object" && (c as { kind?: unknown }).kind === "removed") counts.removed++;
    else if (c && typeof c === "object" && (c as { kind?: unknown }).kind === "modified") counts.modified++;
  }
  return counts;
}

/** Bun's Postgres driver returns jsonb as a string; accept both shapes. */
function parseSemanticDiffJson(value: unknown): SemanticDiffResult | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as SemanticDiffResult) : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" ? (value as SemanticDiffResult) : null;
}

/**
 * Stores (or enriches) the config_snapshots row for one validated `config_snapshot` frame.
 * Deduplicates against the telemetry-inserted row with the identical latest checksum, links
 * previous_snapshot_id, computes and stores the semantic diff when a prior redacted snapshot
 * exists, and attaches a redacted `config_diff` evidence item to a matching open
 * `config_drift` incident — always noting that correlation is not causation.
 */
export async function storeConfigSnapshot(agentId: string, frame: ConfigSnapshotFrame, executor: SQL = db): Promise<void> {
  const filePath = frame.filePath;
  const isRedacted = frame.status === "redacted_snapshot";
  const content = isRedacted ? boundRedacted(frame.contentRedacted) : null;
  const unavailableReason = isRedacted ? null : frame.unavailableReason;
  const format = isRedacted ? frame.format : null;
  const truncated = isRedacted ? frame.truncated : false;
  const redactionCount = isRedacted ? frame.redactionCount : 0;

  await executor.begin(async (tx) => {
    // Order by captured_at only ties on identical transaction timestamps; scan a few rows and
    // pick by checksum so a tie can never mis-identify the latest transition.
    const rows = await tx<SnapshotRow[]>`
      SELECT id,checksum_sha256,content_redacted,captured_at FROM config_snapshots
      WHERE agent_id=${agentId} AND file_path=${filePath}
      ORDER BY captured_at DESC,id DESC LIMIT 5`;
    // When telemetry already inserted this exact hash, enrich that row instead of duplicating it.
    const sameHash = rows.find((r) => r.checksum_sha256 === frame.checksumSha256) ?? null;
    const latest = rows[0] ?? null;
    const prior = rows.find((r) => r.checksum_sha256 !== frame.checksumSha256) ?? null;

    const enrich = sameHash !== null;
    const previousId = enrich ? (prior?.id ?? null) : (latest?.id ?? null);
    const previousContent = enrich ? (prior?.content_redacted ?? null) : (latest?.content_redacted ?? null);

    let semanticDiff: SemanticDiffResult | null = null;
    if (content !== null && previousContent !== null) {
      semanticDiff = computeSemanticDiff(filePath, previousContent, content);
    }
    const diffStatus = !isRedacted ? "unavailable" : semanticDiff ? "diff_available" : "hash_only";

    let rowId: string;
    if (enrich) {
      rowId = sameHash.id;
      await tx`UPDATE config_snapshots SET
        previous_snapshot_id=${previousId},
        diff_status=${diffStatus},
        unavailable_reason=${unavailableReason},
        content_format=${format},
        content_redacted=${content},
        content_truncated=${truncated},
        redaction_count=${redactionCount},
        semantic_diff_json=${semanticDiff ? JSON.stringify(semanticDiff) : null}::jsonb,
        diff_summary=${semanticDiff ? semanticDiff.summary : null}
        WHERE id=${rowId}`;
    } else {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO config_snapshots(agent_id,file_path,checksum_sha256,previous_snapshot_id,diff_status,
          unavailable_reason,content_format,content_redacted,content_truncated,redaction_count,
          semantic_diff_json,diff_summary)
        VALUES(${agentId},${filePath},${frame.checksumSha256},${previousId},${diffStatus},${unavailableReason},
          ${format},${content},${truncated},${redactionCount},
          ${semanticDiff ? JSON.stringify(semanticDiff) : null}::jsonb,
          ${semanticDiff ? semanticDiff.summary : null})
        RETURNING id`;
      rowId = inserted[0].id;
    }

    // Link the open config_drift incident created for this exact change, if any.
    const incidents = await tx<{ id: string }[]>`
      SELECT id FROM incidents
      WHERE agent_id=${agentId} AND category='config_drift' AND status='open'
        AND title=${`Configuration changed: ${filePath}`}
      ORDER BY created_at DESC LIMIT 1`;
    if (incidents.length) {
      const incidentId = incidents[0].id;
      await tx`UPDATE config_snapshots SET incident_id=${incidentId} WHERE id=${rowId}`;
      if (semanticDiff) {
        await addEvidence(
          incidentId,
          "config_diff",
          `Redacted semantic diff for ${filePath}: ${semanticDiff.summary}. Changes: ${JSON.stringify(semanticDiff.changes).slice(0, 3000)}. Correlation is not causation — this config change is correlated with the incident, not proven causal.`,
          tx,
        );
      }
    }
    await audit("config.snapshot.stored", rowId, { agentId, filePath, status: frame.status, diffStatus, redactionCount }, tx);
  });
}

// ---------------------------------------------------------------------------
// HTTP routes (wired behind isAuthed in index.ts)
// ---------------------------------------------------------------------------

const TIMELINE_COLUMNS = `
  s.id,s.agent_id,a.hostname,s.file_path,s.previous_snapshot_id,
  p.checksum_sha256 AS previous_checksum_sha256,
  s.checksum_sha256,s.diff_status,s.unavailable_reason,s.diff_summary,
  s.redaction_count,s.content_format,s.content_truncated,s.semantic_diff_json,
  s.incident_id,s.captured_at`;

const TIMELINE_FROM = `
  FROM config_snapshots s
  JOIN agents a ON a.id=s.agent_id
  LEFT JOIN config_snapshots p ON p.id=s.previous_snapshot_id`;

type TimelineRow = {
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
  semantic_diff_json: unknown;
  incident_id: string | null;
  captured_at: Date;
};

function toTimelineEntry(row: TimelineRow): DriftTimelineEntry {
  return {
    id: row.id,
    agent_id: row.agent_id,
    hostname: row.hostname,
    file_path: row.file_path,
    previous_snapshot_id: row.previous_snapshot_id,
    previous_checksum_sha256: row.previous_checksum_sha256,
    checksum_sha256: row.checksum_sha256,
    diff_status: row.diff_status,
    unavailable_reason: row.unavailable_reason,
    diff_summary: row.diff_summary,
    redaction_count: Number(row.redaction_count),
    content_format: row.content_format,
    content_truncated: row.content_truncated,
    change_counts: changeCountsOf(parseSemanticDiffJson(row.semantic_diff_json)),
    incident_id: row.incident_id,
    captured_at: row.captured_at.toISOString(),
  };
}

/** `GET /api/drift` and `GET /api/drift/:id`; returns null when the path is not a drift route. */
export async function driftRoutes(req: Request, path: string, method: string): Promise<Response | null> {
  if (path === "/api/drift" && method === "GET") {
    const params = new URL(req.url).searchParams;
    const agentId = params.get("agentId");
    if (agentId !== null && !urlUUID(agentId)) return invalid("Invalid agent id");
    const filePath = params.get("filePath");
    if (filePath !== null && (filePath.length === 0 || filePath.length > 256 || !filePath.startsWith("/"))) {
      return invalid("filePath must be an absolute path of at most 256 characters");
    }
    let limit = 100;
    const limitParam = params.get("limit");
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        return invalid("limit must be an integer between 1 and 100");
      }
      limit = parsed;
    }
    // Filters are strictly validated above; each branch keeps parameters bound.
    const order = `ORDER BY s.captured_at DESC,s.id DESC LIMIT ${limit}`;
    let rows: TimelineRow[];
    if (agentId !== null && filePath !== null) {
      rows = await db<TimelineRow[]>`SELECT ${db.unsafe(TIMELINE_COLUMNS)} ${db.unsafe(TIMELINE_FROM)} WHERE s.agent_id=${agentId} AND s.file_path=${filePath} ${db.unsafe(order)}`;
    } else if (agentId !== null) {
      rows = await db<TimelineRow[]>`SELECT ${db.unsafe(TIMELINE_COLUMNS)} ${db.unsafe(TIMELINE_FROM)} WHERE s.agent_id=${agentId} ${db.unsafe(order)}`;
    } else if (filePath !== null) {
      rows = await db<TimelineRow[]>`SELECT ${db.unsafe(TIMELINE_COLUMNS)} ${db.unsafe(TIMELINE_FROM)} WHERE s.file_path=${filePath} ${db.unsafe(order)}`;
    } else {
      rows = await db<TimelineRow[]>`SELECT ${db.unsafe(TIMELINE_COLUMNS)} ${db.unsafe(TIMELINE_FROM)} ${db.unsafe(order)}`;
    }
    const response: DriftTimelineResponse = {
      entries: rows.map(toTimelineEntry),
      limit,
      observed_at: new Date().toISOString(),
    };
    return j(response);
  }

  const match = path.match(/^\/api\/drift\/([^/]+)$/);
  if (match && method === "GET") {
    if (!urlUUID(match[1])) return invalid("Invalid drift id");
    const rows = await db<(TimelineRow & { content_redacted: string | null })[]>`
      SELECT ${db.unsafe(TIMELINE_COLUMNS)}, s.content_redacted ${db.unsafe(TIMELINE_FROM)}
      WHERE s.id=${match[1]}`;
    if (!rows.length) return invalid("Not found", 404);
    const row = rows[0];
    const detail: DriftDetailResponse = {
      ...toTimelineEntry(row),
      observed_at: row.captured_at.toISOString(),
      content_redacted: row.content_redacted,
      semantic_diff_json: parseSemanticDiffJson(row.semantic_diff_json),
    };
    return j(detail);
  }

  return null;
}
