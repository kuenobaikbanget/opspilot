import { expect, test } from "bun:test";
import {
  CHANGE_EVENT_KINDS,
  TIMELINE_CAUSATION_NOTICE,
  buildIncidentTimeline,
  parseCreateChangeEvent,
  parseLinkIncidentChange,
  type ChangeEventKind,
  type IncidentTimelineEntry,
  type TimelineChangeEventRow,
  type TimelineLinkRow,
  type TimelineSnapshotRow,
} from "../packages/contracts/src/index";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const INCIDENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const validCreate = {
  agentId: AGENT_A,
  kind: "deployment",
  title: "Deploy api 1.2.3",
};

test("change event kinds are the fixed non-causal set", () => {
  expect(CHANGE_EVENT_KINDS).toEqual(["deployment", "config_change", "service_restart", "maintenance"]);
});

test("parseCreateChangeEvent accepts valid input, trims and defaults", () => {
  const parsed = parseCreateChangeEvent({ ...validCreate, title: "  Deploy api 1.2.3  ", summary: " rollout ", serviceName: "api.service", version: " v1.2.3 ", source: "ci" }, NOW);
  expect(parsed).toEqual({
    agentId: AGENT_A,
    kind: "deployment",
    title: "Deploy api 1.2.3",
    serviceName: "api.service",
    version: "v1.2.3",
    summary: "rollout",
    source: "ci",
    occurredAt: null,
  });
  // Minimal body: source defaults to operator, occurredAt null (server NOW()).
  expect(parseCreateChangeEvent(validCreate, NOW)).toEqual({
    agentId: AGENT_A,
    kind: "deployment",
    title: "Deploy api 1.2.3",
    serviceName: null,
    version: null,
    summary: null,
    source: "operator",
    occurredAt: null,
  });
  // Explicit nulls on optional fields are normalized to null.
  expect(parseCreateChangeEvent({ ...validCreate, serviceName: null, version: null, summary: null, occurredAt: null }, NOW)?.summary).toBeNull();
  // occurredAt within bounds is canonicalized.
  const occurredAt = iso(NOW - 60_000);
  expect(parseCreateChangeEvent({ ...validCreate, occurredAt }, NOW)?.occurredAt).toBe(occurredAt);
  expect(parseCreateChangeEvent({ ...validCreate, occurredAt: iso(NOW + 5 * 60_000) }, NOW)?.occurredAt).toBe(iso(NOW + 5 * 60_000));
  expect(parseCreateChangeEvent({ ...validCreate, occurredAt: iso(NOW - 365 * 86_400_000) }, NOW)?.occurredAt).toBe(iso(NOW - 365 * 86_400_000));
});

test("parseCreateChangeEvent rejects unknown keys, bad UUID, invalid kind, oversized strings and bad timestamps", () => {
  for (const bad of [
    null, [], "x", {},
    { ...validCreate, agentId: "not-a-uuid" },
    { ...validCreate, agentId: null },
    { ...validCreate, kind: "reboot" },
    { ...validCreate, kind: 1 },
    { ...validCreate, title: "ab" },
    { ...validCreate, title: "a".repeat(161) },
    { ...validCreate, title: 5 },
    { ...validCreate, title: "   " },
    { ...validCreate, serviceName: "bad name with spaces!" },
    { ...validCreate, serviceName: "a".repeat(81) },
    { ...validCreate, version: "a".repeat(81) },
    { ...validCreate, summary: "a".repeat(1001) },
    { ...validCreate, source: "a".repeat(61) },
    { ...validCreate, occurredAt: "yesterday" },
    { ...validCreate, occurredAt: "2026-06-01 12:00:00Z" },
    { ...validCreate, occurredAt: 123 },
    { ...validCreate, occurredAt: iso(NOW + 5 * 60_000 + 1) }, // beyond future skew
    { ...validCreate, occurredAt: iso(NOW - 365 * 86_400_000 - 1) }, // beyond past bound
    { ...validCreate, unknown: true },
    { ...validCreate, agent_id: AGENT_A }, // snake_case rejected
  ]) {
    expect(parseCreateChangeEvent(bad, NOW)).toBeNull();
  }
  for (const kind of CHANGE_EVENT_KINDS) {
    expect(parseCreateChangeEvent({ ...validCreate, kind }, NOW)?.kind).toBe(kind as ChangeEventKind);
  }
});

test("parseLinkIncidentChange accepts valid link/dismiss and rejects malformed input", () => {
  const targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  expect(parseLinkIncidentChange({ targetType: "change_event", targetId, action: "link" })).toEqual({
    targetType: "change_event", targetId, action: "link", note: null,
  });
  expect(parseLinkIncidentChange({ targetType: "config_snapshot", targetId, action: "dismiss", note: "  noise  " })).toEqual({
    targetType: "config_snapshot", targetId, action: "dismiss", note: "noise",
  });
  for (const bad of [
    null, [], {},
    { targetType: "change_event", targetId, action: "link", extra: 1 },
    { targetType: "incident", targetId, action: "link" },
    { targetType: "change_event", targetId: "nope", action: "link" },
    { targetType: "change_event", targetId, action: "delete" },
    { targetType: "change_event", targetId, action: "link", note: "" },
    { targetType: "change_event", targetId, action: "link", note: "a".repeat(301) },
    { targetType: "change_event", targetId, action: "link", note: 7 },
    { targetId, action: "link" },
    { targetType: "change_event", action: "link" },
  ]) {
    expect(parseLinkIncidentChange(bad)).toBeNull();
  }
});

const incident = {
  id: INCIDENT_ID,
  agent_id: AGENT_A,
  title: "Disk pressure on web-1",
  status: "open",
  created_at: iso(NOW),
  resolved_at: null,
  resolution: null,
};
const windowStart = iso(NOW - 120 * 60_000);
const windowEnd = iso(NOW + 30 * 60_000);

const changeEvent = (overrides: Partial<TimelineChangeEventRow> = {}): TimelineChangeEventRow => ({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  agent_id: AGENT_A,
  kind: "deployment",
  title: "Deploy api",
  service_name: "api.service",
  version: "1.2.3",
  summary: "rollout",
  source: "operator",
  occurred_at: iso(NOW - 12 * 60_000),
  created_at: iso(NOW - 12 * 60_000),
  ...overrides,
});

const snapshot = (overrides: Partial<TimelineSnapshotRow> = {}): TimelineSnapshotRow => ({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  agent_id: AGENT_A,
  file_path: "/etc/nginx/nginx.conf",
  checksum_sha256: "b".repeat(64),
  previous_checksum_sha256: "a".repeat(64),
  captured_at: iso(NOW - 4 * 60_000),
  ...overrides,
});

const link = (overrides: Partial<TimelineLinkRow> = {}): TimelineLinkRow => ({
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  change_event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  config_snapshot_id: null,
  status: "linked",
  note: null,
  ...overrides,
});

test("timeline merges lifecycle, evidence, investigations and changes newest-first with offsets", () => {
  const { entries, dismissed_count } = buildIncidentTimeline({
    incident,
    evidence: [{ id: "e1", source: "disk_usage", content: "x".repeat(500), created_at: iso(NOW - 60_000) }],
    investigations: [{ id: "i1", status: "completed", provider_name: "OpenAI", provider_model: "gpt-x", created_at: iso(NOW - 30_000) }],
    snapshots: [snapshot()],
    changeEvents: [changeEvent()],
    links: [],
    windowStart,
    windowEnd,
    redact: (text) => text.replace(/secret=\S+/g, "secret=[REDACTED]"),
  });
  expect(dismissed_count).toBe(0);
  const types = entries.map((e) => e.type);
  // Newest first: opened at NOW, investigation at -30s, evidence at -60s, snapshot at -4m, change at -12m.
  expect(types).toEqual(["incident_opened", "investigation", "evidence", "config_snapshot", "change_event"]);
  const opened = entries.find((e) => e.type === "incident_opened");
  expect(opened).toMatchObject({ id: INCIDENT_ID, occurred_at: incident.created_at, title: incident.title });
  const evidenceEntry = entries.find((e) => e.type === "evidence");
  expect(evidenceEntry).toMatchObject({ source: "disk_usage", preview: "x".repeat(240) });
  const changeEntry = entries.find((e) => e.type === "change_event") as Extract<IncidentTimelineEntry, { type: "change_event" }>;
  expect(changeEntry.offset_seconds).toBe(-720); // 12 minutes before incident
  expect(changeEntry.relation).toBe("observed_nearby");
  expect(changeEntry.link_id).toBeNull();
  expect(changeEntry.causation_claimed).toBe(false);
  const snapshotEntry = entries.find((e) => e.type === "config_snapshot") as Extract<IncidentTimelineEntry, { type: "config_snapshot" }>;
  expect(snapshotEntry.offset_seconds).toBe(-240); // 4 minutes before
  expect(snapshotEntry.causation_claimed).toBe(false);
  expect(snapshotEntry.previous_checksum_sha256).toBe("a".repeat(64));
});

test("timeline records resolution lifecycle entry with redacted detail", () => {
  const { entries } = buildIncidentTimeline({
    incident: { ...incident, status: "resolved", resolved_at: iso(NOW + 10_000), resolution: "restarted nginx password=hunter2" },
    windowStart,
    windowEnd,
    redact: (text) => text.replace(/password=\S+/g, "password=[REDACTED]"),
  });
  const resolved = entries.find((e) => e.type === "incident_resolved");
  expect(resolved).toMatchObject({ occurred_at: iso(NOW + 10_000), detail: "restarted nginx password=[REDACTED]" });
  expect(entries[0].type).toBe("incident_resolved"); // newest first
});

test("every change entry in every scenario carries causation_claimed false and a non-causal relation", () => {
  // Window is [-120m, +30m] around the incident. The maintenance event at +120m and
  // the linked initial snapshot at +60s are both linked explicitly.
  const { entries } = buildIncidentTimeline({
    incident,
    snapshots: [snapshot(), snapshot({ id: "dddddddd-dddd-4ddd-8ddd-ddddddddddde", previous_checksum_sha256: null, captured_at: iso(NOW + 60_000) })],
    changeEvents: [changeEvent(), changeEvent({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccd", kind: "maintenance", occurred_at: iso(NOW + 120 * 60_000) })],
    links: [
      link(),
      link({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeef1", change_event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccd", status: "linked", note: "operator note" }),
      link({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeef2", change_event_id: null, config_snapshot_id: "dddddddd-dddd-4ddd-8ddd-ddddddddddde", status: "linked" }),
    ],
    windowStart,
    windowEnd,
  });
  const changeEntries = entries.filter((e) => e.type === "change_event" || e.type === "config_snapshot");
  expect(changeEntries.length).toBe(4);
  for (const entry of changeEntries) {
    expect(entry.causation_claimed).toBe(false);
    expect(["observed_nearby", "operator_linked"]).toContain(entry.relation);
  }
  const linked = changeEntries.filter((e) => e.relation === "operator_linked");
  expect(linked.length).toBe(3); // two change events + one snapshot, all operator-linked
  expect(linked.every((e) => e.link_id !== null)).toBe(true);
  // operator_linked entries may sit outside the window (afterMinutes = 30) and still appear.
  const outside = changeEntries.filter((e) => e.relation === "operator_linked" && (e.offset_seconds < -120 * 60 || e.offset_seconds > 30 * 60));
  expect(outside.length).toBe(1);
  expect(outside[0].id).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccd");
});

test("dismissal hides a nearby change, counts dismissals, and window filtering excludes out-of-window events", () => {
  const event = changeEvent();
  const { entries, dismissed_count } = buildIncidentTimeline({
    incident,
    changeEvents: [event, changeEvent({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccd", occurred_at: iso(NOW - 200 * 60_000) })],
    links: [link({ status: "dismissed" })],
    windowStart,
    windowEnd,
  });
  expect(dismissed_count).toBe(1);
  const changeEntries = entries.filter((e) => e.type === "change_event");
  // dismissed one hidden; the -200m one is outside the 120m-before window and not linked.
  expect(changeEntries.length).toBe(0);
});

test("linked-outside-window change appears as operator_linked while unlinked outside-window change does not", () => {
  const outside = changeEvent({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccd", occurred_at: iso(NOW - 200 * 60_000) });
  const { entries } = buildIncidentTimeline({
    incident,
    changeEvents: [outside],
    links: [link({ change_event_id: outside.id, status: "linked", note: "seen in deploy log" })],
    windowStart,
    windowEnd,
  });
  const entry = entries.find((e) => e.type === "change_event") as Extract<IncidentTimelineEntry, { type: "change_event" }>;
  expect(entry.relation).toBe("operator_linked");
  expect(entry.offset_seconds).toBe(-12_000);
  expect(entry.note).toBe("seen in deploy log");
  expect(entry.causation_claimed).toBe(false);
});

test("window config snapshots only appear when the checksum changed or it is the initial observation", () => {
  const changed = snapshot({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddd01" });
  const unchanged = snapshot({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddd02", checksum_sha256: "a".repeat(64) });
  const initial = snapshot({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddd03", previous_checksum_sha256: null });
  const { entries } = buildIncidentTimeline({
    incident,
    snapshots: [changed, unchanged, initial],
    windowStart,
    windowEnd,
  });
  const ids = entries.filter((e) => e.type === "config_snapshot").map((e) => e.id).sort();
  expect(ids).toEqual([changed.id, initial.id].sort());
});

test("host isolation: rows belonging to another agent never enter the timeline", () => {
  const { entries } = buildIncidentTimeline({
    incident,
    changeEvents: [changeEvent({ agent_id: AGENT_B })],
    snapshots: [snapshot({ agent_id: AGENT_B })],
    links: [link({ change_event_id: null, config_snapshot_id: snapshot({ agent_id: AGENT_B }).id, status: "linked" })],
    windowStart,
    windowEnd,
  });
  expect(entries.filter((e) => e.type === "change_event" || e.type === "config_snapshot").length).toBe(0);
  // dismissed_count still counts the dismissal/link rows for this incident.
  expect(entries.length).toBe(1); // only incident_opened
});

test("causation notice is the fixed non-causal sentence", () => {
  expect(TIMELINE_CAUSATION_NOTICE).toBe(
    "Nearby deployments and configuration changes are temporal context only. Correlation does not establish root cause.",
  );
});
