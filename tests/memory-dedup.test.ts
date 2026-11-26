import { expect, test } from "bun:test";
import {
  deduplicateMemoryCandidates,
  memoryFingerprint,
  memorySimilarity,
  NEAR_DUPLICATE_THRESHOLD,
  normalizeMemoryText,
} from "../apps/hub/src/memory-dedup";
import { parseMergeMemoryRequest } from "../packages/contracts/src/index";

const RESOLUTION_A = "Restart the nginx service and verify it listens on port 443 again";
const RESOLUTION_A_NEAR = "Restart the nginx service and verify it listens on port 443 again now";
const RESOLUTION_DISTINCT = "Extend the backup volume disk quota and prune archives older than 30 days";

test("normalizeMemoryText is deterministic and ignores case, punctuation and spacing", () => {
  const a = normalizeMemoryText("Restart Nginx!", "systemctl  restart   nginx.");
  const b = normalizeMemoryText("restart nginx", "Systemctl restart NGINX");
  expect(a).toBe(b);
  expect(a).toBe("restart nginx systemctl restart nginx");
  expect(normalizeMemoryText("", "")).toBe("");
  // Deterministic across repeated calls.
  expect(normalizeMemoryText(RESOLUTION_A, "Disk full on /var")).toBe(normalizeMemoryText(RESOLUTION_A, "Disk full on /var"));
});

test("memoryFingerprint is a stable 64-char hex digest of normalized text", () => {
  const fp = memoryFingerprint("Restart Nginx!", RESOLUTION_A);
  expect(fp).toMatch(/^[a-f0-9]{64}$/);
  expect(fp).toBe(memoryFingerprint("restart nginx", RESOLUTION_A.toLowerCase()));
  expect(fp).not.toBe(memoryFingerprint("Restart Nginx!", RESOLUTION_DISTINCT));
  expect(memoryFingerprint(RESOLUTION_A, "x")).not.toBe(memoryFingerprint(RESOLUTION_A, "y"));
});

test("memorySimilarity: identical is 1, near-duplicate clears the threshold, distinct does not", () => {
  expect(memorySimilarity({ summary: "Nginx down", resolution: RESOLUTION_A }, { summary: "Nginx down", resolution: RESOLUTION_A })).toBe(1);
  expect(memorySimilarity({ summary: "a", resolution: "" }, { summary: "", resolution: "" })).toBe(0);
  expect(memorySimilarity({ summary: "", resolution: "" }, { summary: "", resolution: "" })).toBe(1);
  const near = memorySimilarity({ summary: "Nginx port 443 listening failure", resolution: RESOLUTION_A }, { summary: "Nginx port 443 listening failure", resolution: RESOLUTION_A_NEAR });
  expect(near).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
  const distinct = memorySimilarity({ summary: "Nginx down", resolution: RESOLUTION_A }, { summary: "Backup disk full", resolution: RESOLUTION_DISTINCT });
  expect(distinct).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
  // Similarity is symmetric.
  expect(memorySimilarity({ summary: "s", resolution: RESOLUTION_A }, { summary: "s", resolution: RESOLUTION_A_NEAR }))
    .toBe(memorySimilarity({ summary: "s", resolution: RESOLUTION_A_NEAR }, { summary: "s", resolution: RESOLUTION_A }));
});

test("deduplicateMemoryCandidates drops exact and near duplicates, keeps order, respects limit", () => {
  const candidates = [
    { id: "1", summary: "Nginx port 443 listening failure", resolution: RESOLUTION_A },
    { id: "2", summary: "NGINX PORT 443 LISTENING FAILURE", resolution: RESOLUTION_A.toUpperCase() }, // exact dup after normalization
    { id: "3", summary: "Nginx port 443 listening failure", resolution: RESOLUTION_A_NEAR }, // near dup
    { id: "4", summary: "Backup disk full", resolution: RESOLUTION_DISTINCT }, // distinct
    { id: "5", summary: "Cache eviction storm", resolution: "Flush the redis cache and restart the cache tier" }, // distinct
  ];
  const deduped = deduplicateMemoryCandidates(candidates, 10);
  expect(deduped.map((c) => c.id)).toEqual(["1", "4", "5"]);
  // Limit caps the output after dedup.
  expect(deduplicateMemoryCandidates(candidates, 2).map((c) => c.id)).toEqual(["1", "4"]);
  // A later exact duplicate of an earlier kept entry is never emitted.
  const withLateDup = deduplicateMemoryCandidates([...candidates, { id: "6", summary: "Backup disk full", resolution: RESOLUTION_DISTINCT }], 10);
  expect(withLateDup.map((c) => c.id)).toEqual(["1", "4", "5"]);
  expect(deduplicateMemoryCandidates([], 5)).toEqual([]);
});

test("parseMergeMemoryRequest accepts two distinct UUIDs", () => {
  const source = "d0000000-0000-4000-8000-000000000001";
  const target = "d0000000-0000-4000-8000-000000000002";
  expect(parseMergeMemoryRequest({ sourceMemoryId: source, targetMemoryId: target })).toEqual({ sourceMemoryId: source, targetMemoryId: target });
  // Uppercase UUIDs are valid too.
  expect(parseMergeMemoryRequest({ sourceMemoryId: source.toUpperCase(), targetMemoryId: target })).toEqual({ sourceMemoryId: source.toUpperCase(), targetMemoryId: target });
});

test("parseMergeMemoryRequest rejects self-merge, bad UUIDs, unknown keys and non-objects", () => {
  const source = "d0000000-0000-4000-8000-000000000001";
  const target = "d0000000-0000-4000-8000-000000000002";
  for (const bad of [
    null,
    undefined,
    [],
    "merge",
    {},
    { sourceMemoryId: source }, // missing target
    { targetMemoryId: target }, // missing source
    { sourceMemoryId: source, targetMemoryId: source }, // self-merge
    { sourceMemoryId: source, targetMemoryId: source.toUpperCase() }, // self-merge ignoring case
    { sourceMemoryId: "not-a-uuid", targetMemoryId: target },
    { sourceMemoryId: source, targetMemoryId: "d0000000-0000-4000-8000-00000000000" }, // too short
    { sourceMemoryId: 123, targetMemoryId: target },
    { sourceMemoryId: source, targetMemoryId: null },
    { sourceMemoryId: source, targetMemoryId: target, extra: true }, // unknown key
    { sourceMemoryId: source, targetMemoryId: target, memoryId: source },
  ]) {
    expect(parseMergeMemoryRequest(bad)).toBeNull();
  }
});
