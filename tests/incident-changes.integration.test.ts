import { expect, test } from "bun:test";
import type { SQL } from "bun";
import type {
  ChangeEvent,
  IncidentTimelineEntry,
  IncidentTimelineResponse,
} from "../packages/contracts/src/index";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";
import { csrfFromLogin, withCsrf } from "./helpers/csrf";

const integration = providerTestDatabaseAvailable ? test : test.skip;
const origin = "http://localhost:3100";
const password = "opspilot-change-timeline-integration-password";
const root = new URL("../", import.meta.url).pathname;
const secret = "sk-live-integrationsecretvalue123456";

type RequestOptions = { authenticated?: boolean; origin?: string | null };
type Hub = {
  request(path: string, method?: string, data?: unknown, overrides?: RequestOptions): Promise<Response>;
  stop(): Promise<void>;
};

function childEnv(databaseUrl: string, port: number): Record<string, string> {
  return {
    NODE_ENV: "development",
    DATABASE_URL: databaseUrl,
    PORT: String(port),
    ADMIN_PASSWORD: password,
    SESSION_SECRET: "opspilot-disposable-change-timeline-session-secret",
    COOKIE_SECURE: "false",
    ALLOWED_ORIGIN: origin,
  };
}

async function bounded<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  const timer = setTimeout(() => { throw new Error(`Timed out waiting for ${label}`); }, milliseconds);
  try { return await work; } finally { clearTimeout(timer); }
}

async function eventually<T>(read: () => Promise<T | undefined>, label: string, milliseconds = 15_000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(30);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function spawn(script: string, env: Record<string, string>) {
  return Bun.spawn([process.execPath, "--no-env-file", script], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
}

async function migrate(databaseUrl: string): Promise<void> {
  const child = spawn("tools/migrate.ts", childEnv(databaseUrl, 0));
  const code = await bounded(child.exited, 20_000, "migration");
  const output = `${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`;
  if (code !== 0) throw new Error(`Migration failed (${code}): ${output}`);
  expect(output).toContain("013_change_events_and_incident_links.sql");
}

async function startHub(databaseUrl: string): Promise<Hub> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const child = spawn("apps/hub/src/index.ts", childEnv(databaseUrl, port));
  const baseUrl = `http://127.0.0.1:${port}`;
  let cookie = "";
  let csrf = "";
  async function request(path: string, method = "GET", data?: unknown, overrides: RequestOptions = {}): Promise<Response> {
    const headers = new Headers();
    if (overrides.authenticated !== false && cookie) headers.set("cookie", cookie);
    if (method !== "GET" && overrides.origin !== null) headers.set("origin", overrides.origin ?? origin);
    withCsrf(headers, method, csrf);
    headers.set("content-type", "application/json");
    return fetch(`${baseUrl}${path}`, {
      method, headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(5_000),
    });
  }
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    try { await bounded(child.exited, 3_000, "hub shutdown"); } catch { child.kill("SIGKILL"); await child.exited; }
    await new Response(child.stdout).text();
    await new Response(child.stderr).text();
  };
  try {
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error("Hub exited before startup");
      try { return (await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).ok ? true : undefined; }
      catch { return undefined; }
    }, "Hub readiness");
    const login = await request("/api/auth/login", "POST", { password });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    csrf = csrfFromLogin(login);
    return { request, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}

type Seed = { hostA: string; hostB: string; incidentId: string; incidentCreatedAt: string };

async function seed(db: SQL): Promise<Seed> {
  const [a] = await db<{ id: string }[]>`INSERT INTO agents(hostname,token_hash) VALUES('host-a','fixture-a') RETURNING id`;
  const [b] = await db<{ id: string }[]>`INSERT INTO agents(hostname,token_hash) VALUES('host-b','fixture-b') RETURNING id`;
  const [incident] = await db<{ id: string; created_at: Date }[]>`
    INSERT INTO incidents(agent_id,title,category,status) VALUES(${a.id},'Latency spike on host-a','manual','open')
    RETURNING id,created_at`;
  await db`INSERT INTO evidence(incident_id,source,content) VALUES(${incident.id},'fixture:recent_logs',${`log line with ${"x".repeat(300)} end`})`;
  await db`INSERT INTO investigations(incident_id,provider_name,provider_protocol,provider_model,status)
    VALUES(${incident.id},'OpenAI','openai-compatible','fixture-model','completed')`;
  return { hostA: a.id, hostB: b.id, incidentId: incident.id, incidentCreatedAt: incident.created_at.toISOString() };
}

const changeEntry = (entries: IncidentTimelineEntry[], id: string) =>
  entries.find((e) => e.type === "change_event" && e.id === id) as Extract<IncidentTimelineEntry, { type: "change_event" }> | undefined;
const snapshotEntry = (entries: IncidentTimelineEntry[], id: string) =>
  entries.find((e) => e.type === "config_snapshot" && e.id === id) as Extract<IncidentTimelineEntry, { type: "config_snapshot" }> | undefined;

integration("change routes require admin auth and exact ALLOWED_ORIGIN on mutations", async () => {
  await withProviderTestDb(async (db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      const { hostA, incidentId } = await seed(db);
      const getTimeline = `/api/incidents/${incidentId}/timeline`;
      const linkRoute = `/api/incidents/${incidentId}/changes`;
      const deleteRoute = `/api/incidents/${incidentId}/changes/${crypto.randomUUID()}`;
      const routes: [string, string, unknown?][] = [
        ["/api/changes", "GET"],
        ["/api/changes", "POST", { agentId: hostA, kind: "deployment", title: "Deploy api" }],
        [getTimeline, "GET"],
        [linkRoute, "POST", { targetType: "change_event", targetId: crypto.randomUUID(), action: "link" }],
        [deleteRoute, "DELETE"],
      ];
      for (const [path, method, body] of routes) {
        expect((await hub.request(path, method, body, { authenticated: false })).status).toBe(401);
      }
      for (const [path, method, body] of routes.filter(([, m]) => m !== "GET")) {
        for (const badOrigin of [null, "http://attacker.invalid", `${origin}/`]) {
          const response = await hub.request(path, method, body, { origin: badOrigin });
          expect(response.status).toBe(403);
          expect((await response.json() as { code: string }).code).toBe("forbidden_origin");
        }
      }
      // Invalid ids and params are 400, unknown resources 404.
      expect((await hub.request("/api/incidents/not-a-uuid/timeline")).status).toBe(400);
      expect((await hub.request(`/api/incidents/${crypto.randomUUID()}/timeline`)).status).toBe(404);
      expect((await hub.request("/api/changes?agentId=nope")).status).toBe(400);
      expect((await hub.request("/api/changes?kind=reboot")).status).toBe(400);
      expect((await hub.request("/api/changes?limit=101")).status).toBe(400);
      expect((await hub.request("/api/changes", "POST", { agentId: crypto.randomUUID(), kind: "deployment", title: "Deploy api" })).status).toBe(404);
      expect((await hub.request("/api/changes", "POST", { agentId: hostA, kind: "reboot", title: "Deploy api" })).status).toBe(400);
      expect((await hub.request("/api/changes", "POST", { agentId: hostA, kind: "deployment", title: "ab" })).status).toBe(400);
      expect((await hub.request(linkRoute, "POST", { targetType: "change_event", targetId: "nope", action: "link" })).status).toBe(400);
      expect((await hub.request(linkRoute, "POST", { targetType: "change_event", targetId: crypto.randomUUID(), action: "link" })).status).toBe(404);
      expect((await hub.request(`/api/incidents/${crypto.randomUUID()}/changes`, "POST", { targetType: "change_event", targetId: crypto.randomUUID(), action: "link" })).status).toBe(404);
      expect((await hub.request(deleteRoute, "DELETE")).status).toBe(404);
    } finally {
      await hub.stop();
    }
  });
}, 120_000);

integration("incident timeline links same-host changes without claiming causation, isolates hosts, redacts secrets and audits", async () => {
  await withProviderTestDb(async (db, databaseUrl) => {
    await migrate(databaseUrl);
    const hub = await startHub(databaseUrl);
    try {
      const { hostA, hostB, incidentId, incidentCreatedAt } = await seed(db);
      const createdMs = Date.parse(incidentCreatedAt);

      // Record changes on host A around the incident time (incident created "now").
      const postChange = async (fields: Record<string, unknown>) =>
        json<{ change: ChangeEvent }>(await hub.request("/api/changes", "POST", { agentId: hostA, ...fields }), 201);
      const near = await postChange({ kind: "deployment", title: "Deploy api 2.0", version: "2.0.0", serviceName: "api.service", summary: "canary rollout", occurredAt: new Date(createdMs - 10 * 60_000).toISOString() });
      const earlier = await postChange({ kind: "service_restart", title: "Restart nginx", serviceName: "nginx.service", occurredAt: new Date(createdMs - 70 * 60_000).toISOString() });
      const outside = await postChange({ kind: "maintenance", title: "Old maintenance window", occurredAt: new Date(createdMs - 200 * 60_000).toISOString() });
      // Secret in the summary must be redacted before storage.
      const withSecret = await postChange({ kind: "config_change", title: "Rotate settings", summary: `deploy used api_key=${secret}`, occurredAt: new Date(createdMs + 5 * 60_000).toISOString() });
      // Host B change must never leak into host A's incident timeline.
      const otherHost = await json<{ change: ChangeEvent }>(await hub.request("/api/changes", "POST", { agentId: hostB, kind: "deployment", title: "Deploy on host B", occurredAt: new Date(createdMs - 10 * 60_000).toISOString() }), 201);

      // Config snapshots on host A: initial, changed, unchanged, and one outside the window.
      const hash = (c: string) => c.repeat(64);
      const [s0] = await db<{ id: string }[]>`INSERT INTO config_snapshots(agent_id,file_path,checksum_sha256,captured_at) VALUES(${hostA},'/etc/app/main.conf',${hash("a")},${new Date(createdMs - 60 * 60_000)}) RETURNING id`;
      const [s1] = await db<{ id: string }[]>`INSERT INTO config_snapshots(agent_id,file_path,checksum_sha256,captured_at) VALUES(${hostA},'/etc/app/main.conf',${hash("b")},${new Date(createdMs - 15 * 60_000)}) RETURNING id`;
      const [s2] = await db<{ id: string }[]>`INSERT INTO config_snapshots(agent_id,file_path,checksum_sha256,captured_at) VALUES(${hostA},'/etc/app/main.conf',${hash("b")},${new Date(createdMs - 5 * 60_000)}) RETURNING id`;
      const [sOut] = await db<{ id: string }[]>`INSERT INTO config_snapshots(agent_id,file_path,checksum_sha256,captured_at) VALUES(${hostA},'/etc/app/other.conf',${hash("c")},${new Date(createdMs - 200 * 60_000)}) RETURNING id`;
      const [sB] = await db<{ id: string }[]>`INSERT INTO config_snapshots(agent_id,file_path,checksum_sha256,captured_at) VALUES(${hostB},'/etc/app/main.conf',${hash("d")},${new Date(createdMs - 15 * 60_000)}) RETURNING id`;

      // GET /api/changes list filters and joins hostname.
      const list = await json<{ changes: ChangeEvent[]; limit: number }>(await hub.request(`/api/changes?agentId=${hostA}&kind=deployment&limit=10`));
      expect(list.changes.length).toBe(1);
      expect(list.changes[0]).toMatchObject({ id: near.change.id, hostname: "host-a", kind: "deployment" });
      const all = await json<{ changes: ChangeEvent[] }>(await hub.request("/api/changes"));
      expect(all.changes.length).toBe(5);
      // Stored summary is redacted.
      const stored = await db<{ summary: string }[]>`SELECT summary FROM change_events WHERE id=${withSecret.change.id}`;
      expect(stored[0].summary).not.toContain(secret);
      expect(stored[0].summary).toContain("[REDACTED]");

      const timelinePath = `/api/incidents/${incidentId}/timeline`;
      let timeline = await json<IncidentTimelineResponse>(await hub.request(timelinePath));
      expect(timeline.incident_id).toBe(incidentId);
      expect(timeline.agent_id).toBe(hostA);
      expect(timeline.window_before_minutes).toBe(120);
      expect(timeline.window_after_minutes).toBe(30);
      expect(timeline.causation_notice).toContain("Correlation does not establish root cause");
      // Newest first ordering.
      const times = timeline.entries.map((e) => Date.parse(e.occurred_at));
      for (let i = 1; i < times.length; i++) expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);

      const ids = new Set(timeline.entries.map((e) => e.id));
      expect(ids.has(incidentId)).toBe(true); // incident_opened
      expect(timeline.entries.some((e) => e.type === "evidence" && e.preview.length <= 240)).toBe(true);
      expect(timeline.entries.some((e) => e.type === "investigation" && e.provider_name === "OpenAI")).toBe(true);

      // In-window same-host changes appear as observed nearby; every change entry is non-causal.
      const nearEntry = changeEntry(timeline.entries, near.change.id);
      expect(nearEntry).toBeDefined();
      expect(nearEntry!.relation).toBe("observed_nearby");
      expect(nearEntry!.causation_claimed).toBe(false);
      expect(Math.abs(nearEntry!.offset_seconds - -600)).toBeLessThanOrEqual(5);
      expect(changeEntry(timeline.entries, earlier.change.id)).toBeDefined();
      // Outside-window and other-host changes do not appear.
      expect(changeEntry(timeline.entries, outside.change.id)).toBeUndefined();
      expect(changeEntry(timeline.entries, otherHost.change.id)).toBeUndefined();
      expect(timeline.entries.some((e) => e.type === "config_snapshot" && e.id === sB.id)).toBe(false);
      // Changed snapshot in window appears with previous checksum; unchanged does not.
      const s1Entry = snapshotEntry(timeline.entries, s1.id);
      expect(s1Entry).toBeDefined();
      expect(s1Entry!.causation_claimed).toBe(false);
      expect(s1Entry!.previous_checksum_sha256).toBe(hash("a"));
      expect(snapshotEntry(timeline.entries, s2.id)).toBeUndefined();
      expect(snapshotEntry(timeline.entries, sOut.id)).toBeUndefined();
      for (const entry of timeline.entries) {
        if (entry.type === "change_event" || entry.type === "config_snapshot") {
          expect(entry.causation_claimed).toBe(false);
          expect(["observed_nearby", "operator_linked"]).toContain(entry.relation);
        }
      }

      // Cross-host linking is rejected.
      const crossEvent = await hub.request(`/api/incidents/${incidentId}/changes`, "POST", { targetType: "change_event", targetId: otherHost.change.id, action: "link" });
      expect(crossEvent.status).toBe(409);
      expect((await crossEvent.json() as { code: string }).code).toBe("cross_host");
      const crossSnapshot = await hub.request(`/api/incidents/${incidentId}/changes`, "POST", { targetType: "config_snapshot", targetId: sB.id, action: "link" });
      expect(crossSnapshot.status).toBe(409);

      // Manual link of an outside-window change makes it appear as operator_linked.
      const linkOutside = await json<{ link: { id: string; status: string } }>(
        await hub.request(`/api/incidents/${incidentId}/changes`, "POST", { targetType: "change_event", targetId: outside.change.id, action: "link", note: "seen in deploy log" }), 201);
      timeline = await json<IncidentTimelineResponse>(await hub.request(timelinePath));
      const outsideEntry = changeEntry(timeline.entries, outside.change.id);
      expect(outsideEntry).toBeDefined();
      expect(outsideEntry!.relation).toBe("operator_linked");
      expect(outsideEntry!.causation_claimed).toBe(false);
      expect(outsideEntry!.link_id).toBe(linkOutside.link.id);
      expect(outsideEntry!.note).toBe("seen in deploy log");
      expect(outsideEntry!.offset_seconds).toBeLessThan(-120 * 60);

      // Link the outside-window snapshot too, then dismiss the in-window deployment.
      const linkSnapshot = await json<{ link: { id: string } }>(
        await hub.request(`/api/incidents/${incidentId}/changes`, "POST", { targetType: "config_snapshot", targetId: sOut.id, action: "link" }), 201);
      const dismiss = await json<{ link: { id: string; status: string } }>(
        await hub.request(`/api/incidents/${incidentId}/changes`, "POST", { targetType: "change_event", targetId: near.change.id, action: "dismiss", note: "unrelated noise" }), 201);
      timeline = await json<IncidentTimelineResponse>(await hub.request(timelinePath));
      expect(changeEntry(timeline.entries, near.change.id)).toBeUndefined(); // dismissed hides it
      expect(timeline.dismissed_count).toBe(1);
      expect(snapshotEntry(timeline.entries, sOut.id)!.relation).toBe("operator_linked");

      // Re-linking the dismissed change (upsert) restores it as operator_linked; 200 on update.
      const relink = await json<{ link: { id: string; status: string } }>(
        await hub.request(`/api/incidents/${incidentId}/changes`, "POST", { targetType: "change_event", targetId: near.change.id, action: "link" }), 200);
      expect(relink.link.id).toBe(dismiss.link.id);
      timeline = await json<IncidentTimelineResponse>(await hub.request(timelinePath));
      expect(changeEntry(timeline.entries, near.change.id)!.relation).toBe("operator_linked");
      expect(timeline.dismissed_count).toBe(0);

      // DELETE removes the manual link; the nearby change becomes visible again as observed.
      const deleted = await hub.request(`/api/incidents/${incidentId}/changes/${relink.link.id}`, "DELETE");
      expect(deleted.status).toBe(200);
      timeline = await json<IncidentTimelineResponse>(await hub.request(timelinePath));
      const restored = changeEntry(timeline.entries, near.change.id);
      expect(restored).toBeDefined();
      expect(restored!.relation).toBe("observed_nearby");
      expect(restored!.link_id).toBeNull();
      expect((await hub.request(`/api/incidents/${incidentId}/changes/${relink.link.id}`, "DELETE")).status).toBe(404);

      // Custom window params are honored and bounded.
      timeline = await json<IncidentTimelineResponse>(await hub.request(`${timelinePath}?beforeMinutes=210&afterMinutes=0`));
      expect(timeline.window_before_minutes).toBe(210);
      expect(timeline.window_after_minutes).toBe(0);
      // The outside-window change is still manually linked, so it appears as operator_linked.
      expect(changeEntry(timeline.entries, outside.change.id)!.relation).toBe("operator_linked");
      expect((await hub.request(`${timelinePath}?beforeMinutes=4`)).status).toBe(400);
      expect((await hub.request(`${timelinePath}?afterMinutes=721`)).status).toBe(400);

      // Audit events exist for every mutation and never contain the secret.
      const audits = await db<{ action: string; target_id: string | null; data: unknown }[]>`
        SELECT action,target_id,data FROM audit_events WHERE action IN ('change.recorded','incident.change_linked','incident.change_dismissed','incident.change_unlinked') ORDER BY id`;
      const actions = new Set(audits.map((a) => a.action));
      expect(actions).toEqual(new Set(["change.recorded", "incident.change_linked", "incident.change_dismissed", "incident.change_unlinked"]));
      const serialized = JSON.stringify(audits);
      expect(serialized).not.toContain(secret);
      const recorded = audits.filter((a) => a.action === "change.recorded");
      expect(recorded.length).toBe(5);
      for (const row of recorded) {
        const data = row.data as Record<string, unknown>;
        expect(Object.keys(data).sort()).toEqual(["agentId", "kind", "serviceName", "source", "version"]);
      }
    } finally {
      await hub.stop();
    }
  });
}, 120_000);
