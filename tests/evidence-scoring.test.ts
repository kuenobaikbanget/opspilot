import { describe, expect, test } from "bun:test";
import { scoreEvidenceRelevance, sortScoredEvidence, type EvidenceLike } from "../packages/ai/src/evidence-scoring";

const incident = { title: "Disk full on web-01", category: "disk" };

const evidence: EvidenceLike[] = [
  { id: "ev-error", source: "recent_logs", content: "EXT4-fs error: disk full, write failed, 100% usage", created_at: "2025-01-01T10:05:00.000Z" },
  { id: "ev-disk", source: "disk_usage", content: "/dev/sda1 100% full (disk) for web-01", created_at: "2025-01-01T10:04:00.000Z" },
  { id: "ev-noise", source: "listening_ports", content: "ports 22 and 443 listening normally", created_at: "2025-01-01T10:03:00.000Z" },
];

describe("scoreEvidenceRelevance", () => {
  test("is fully deterministic: identical inputs produce identical scores, tags and order", () => {
    const cited = ["ev-error"];
    const first = scoreEvidenceRelevance(incident, evidence, cited);
    const second = scoreEvidenceRelevance(incident, evidence, cited);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // Shuffled input evidence must not change per-item scores either.
    const shuffled = scoreEvidenceRelevance(incident, [...evidence].reverse(), cited);
    const byId = new Map(shuffled.map((item) => [item.id, item]));
    for (const item of first) expect(byId.get(item.id)).toEqual(item);
  });

  test("returns an empty array for empty evidence", () => {
    expect(scoreEvidenceRelevance(incident, [])).toEqual([]);
    expect(scoreEvidenceRelevance(incident, [], ["anything"])).toEqual([]);
  });

  test("high-signal error evidence outranks unrelated noisy evidence", () => {
    const scored = scoreEvidenceRelevance(incident, evidence);
    const byId = new Map(scored.map((item) => [item.id, item]));
    expect(byId.get("ev-error")!.relevance.score).toBeGreaterThan(byId.get("ev-noise")!.relevance.score);
    expect(byId.get("ev-error")!.relevance.matchedSignals).toContain("error_signal");
    expect(byId.get("ev-noise")!.relevance.matchedSignals).not.toContain("error_signal");
    // Disk incident: disk_usage is a category match even without error keywords.
    expect(byId.get("ev-disk")!.relevance.matchedSignals).toContain("category_match");
  });

  test("cited evidence is marked cited and unknown citation IDs never create phantom evidence", () => {
    const scored = scoreEvidenceRelevance(incident, evidence, ["ev-disk", "hallucinated-id", ""]);
    expect(scored).toHaveLength(evidence.length);
    const byId = new Map(scored.map((item) => [item.id, item]));
    expect(byId.get("ev-disk")!.relevance.cited).toBe(true);
    expect(byId.get("ev-disk")!.relevance.matchedSignals).toContain("cited_by_hypothesis");
    expect(byId.get("ev-error")!.relevance.cited).toBe(false);
    expect(byId.has("hallucinated-id")).toBe(false);
    // Cited boost applies while uncited high-signal evidence stays scored on its own merits.
    expect(byId.get("ev-error")!.relevance.score).toBeGreaterThan(0);
  });

  test("scores are always integers clamped to [0, 100]", () => {
    const maximal: EvidenceLike = {
      id: "ev-max",
      source: "recent_logs",
      content: "disk full error fail refused timeout oom killed 502 503 100% exited inactive drift for web-01 disk full",
      created_at: "2025-01-01T10:06:00.000Z",
    };
    const scored = scoreEvidenceRelevance(incident, [...evidence, maximal], ["ev-max", "ev-error"]);
    for (const item of scored) {
      expect(Number.isInteger(item.relevance.score)).toBe(true);
      expect(item.relevance.score).toBeGreaterThanOrEqual(0);
      expect(item.relevance.score).toBeLessThanOrEqual(100);
    }
    // Maximal evidence is the top score but the sum of bounded weights never exceeds 100.
    const maxScore = Math.max(...scored.map((item) => item.relevance.score));
    expect(scored.find((item) => item.id === "ev-max")!.relevance.score).toBe(maxScore);
    expect(maxScore).toBeLessThanOrEqual(100);
    expect(scoreEvidenceRelevance(incident, [{ id: "ev-plain", source: "x", content: "nothing notable" }])[0].relevance.score).toBe(0);
  });
});

describe("sortScoredEvidence", () => {
  test("sorts cited first (when enabled), then score DESC, created_at DESC, id ASC — reproducibly", () => {
    const scored = scoreEvidenceRelevance(incident, evidence, ["ev-noise"]);
    const sorted = sortScoredEvidence(scored, { citedFirst: true });
    expect(sorted.map((item) => item.id)).toEqual(["ev-noise", "ev-disk", "ev-error"]);
    // Identical inputs always produce identical order.
    expect(sortScoredEvidence(scored, { citedFirst: true }).map((item) => item.id)).toEqual(sorted.map((item) => item.id));
    // Without citedFirst, pure score DESC ordering with deterministic tie-breaks.
    const plain = sortScoredEvidence(scored);
    expect(plain.map((item) => item.id)).toEqual(["ev-disk", "ev-error", "ev-noise"]);
    // Input array is not mutated.
    expect(scored.map((item) => item.id)).toEqual(["ev-error", "ev-disk", "ev-noise"]);
  });

  test("tie-breaks on created_at DESC then id ASC", () => {
    const items = scoreEvidenceRelevance(incident, [
      { id: "b-same", source: "other", content: "unrelated", created_at: "2025-01-01T10:00:00.000Z" },
      { id: "a-same", source: "other", content: "unrelated", created_at: "2025-01-01T10:00:00.000Z" },
      { id: "c-newer", source: "other", content: "unrelated", created_at: "2025-01-01T11:00:00.000Z" },
    ]);
    expect(sortScoredEvidence(items).map((item) => item.id)).toEqual(["c-newer", "a-same", "b-same"]);
  });
});
