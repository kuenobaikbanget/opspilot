import { expect, test } from "bun:test";
import { providerTestDatabaseAvailable, withProviderTestDb } from "./helpers/provider-test-db";

const integration = providerTestDatabaseAvailable ? test : test.skip;
const root = new URL("../", import.meta.url).pathname;
const password = "disposable-drift-integration";

type Identity = { agentId: string; agentSecret: string };

async function eventually<T>(read: () => Promise<T>, accept: (result: T) => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  do {
    const result = await read();
    if (accept(result)) return result;
    await Bun.sleep(35);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

async function openConnection(url: string, id: Identity) {
  const socket = new WebSocket(url, { headers: {
    "x-opspilot-agent-id": id.agentId, authorization: `Bearer ${id.agentSecret}`,
  } });
  const signal = AbortSignal.timeout(5000);
  try {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    socket.addEventListener("open", () => resolve(), { once: true, signal });
    socket.addEventListener("error", () => reject(new Error("Agent socket upgrade failed")), { once: true, signal });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    await promise;
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

function readMessage(socket: WebSocket, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS message")), timeoutMs);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
    }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS error while reading")); }, { once: true });
  });
}

integration("config_snapshot WS ingestion produces a redacted drift timeline, semantic diffs and linked incident evidence", async () => {
  await withProviderTestDb(async (db, databaseUrl) => {
    const migration = Bun.spawnSync([process.execPath, "--no-env-file", "tools/migrate.ts"], {
      cwd: root, env: { DATABASE_URL: databaseUrl }, timeout: 15_000,
    });
    if (!migration.success) throw new Error(`Migration failed: ${migration.stderr.toString()}`);

    const hub = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      const serve = Bun.serve;
      Bun.serve = options => serve({...options, hostname: "127.0.0.1"});
      await import("./apps/hub/src/index.ts");
    `], {
      cwd: root, stdout: "pipe", stderr: "inherit",
      env: { DATABASE_URL: databaseUrl, PORT: "0", NODE_ENV: "development", ADMIN_PASSWORD: password,
        SESSION_SECRET: "disposable-drift-integration-cookie", COOKIE_SECURE: "false" },
    });
    try {
      const stdout = hub.stdout.getReader();
      const startup = await stdout.read();
      await stdout.cancel();
      const port = new TextDecoder().decode(startup.value).match(/localhost:(\d+)/)?.[1];
      if (!port) throw new Error("Hub did not announce its test port");
      const base = `http://127.0.0.1:${port}`;
      const socketUrl = `ws://127.0.0.1:${port}/api/agents/connect`;
      let cookie = "";
      const api = (path: string, method = "GET", body?: unknown, auth = true) => fetch(base + path, {
        signal: AbortSignal.timeout(3000),
        headers: { "content-type": "application/json", ...(auth && cookie ? { cookie } : {}) },
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const login = await api("/api/auth/login", "POST", { password });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")!.split(";")[0];

      // --- Migration 012 applied; legacy hash-only rows keep working with safe defaults ---
      const applied = await db<{ name: string }[]>`SELECT name FROM schema_migrations WHERE name='012_config_drift_diffs.sql'`;
      expect(applied).toHaveLength(1);

      const tokenResponse = await api("/api/agents/enrollment-token", "POST", {});
      expect(tokenResponse.status).toBe(201);
      const enrollResponse = await api("/api/agents/enroll", "POST", {
        token: (await tokenResponse.json()).token, hostname: "drift-test-host", version: "test",
      }, false);
      expect(enrollResponse.status).toBe(201);
      const identity = (await enrollResponse.json()) as Identity;
      const agentId = identity.agentId;

      // A pre-012 style row (only the original columns) must remain valid with defaults.
      await db`INSERT INTO config_snapshots(agent_id,file_path,checksum_sha256) VALUES(${agentId},'/etc/legacy.conf',${sha("legacy")})`;
      const legacy = await db<{ diff_status: string; redaction_count: number; content_redacted: string | null; incident_id: string | null }[]>`
        SELECT diff_status,redaction_count,content_redacted,incident_id FROM config_snapshots WHERE agent_id=${agentId} AND file_path='/etc/legacy.conf'`;
      expect(legacy[0]).toMatchObject({ diff_status: "hash_only", redaction_count: 0, content_redacted: null, incident_id: null });

      // --- Auth negative tests on the drift routes ---
      expect((await api("/api/drift", "GET", undefined, false)).status).toBe(401);
      expect((await api(`/api/drift/${crypto.randomUUID()}`, "GET", undefined, false)).status).toBe(401);
      expect((await api("/api/drift/not-a-uuid")).status).toBe(400);
      expect((await api(`/api/drift/${crypto.randomUUID()}`)).status).toBe(404);
      expect((await api("/api/drift?agentId=not-a-uuid")).status).toBe(400);
      expect((await api("/api/drift?limit=0")).status).toBe(400);
      expect((await api("/api/drift?limit=101")).status).toBe(400);
      expect((await api("/api/drift?filePath=relative/path")).status).toBe(400);

      // --- WS: hello negotiates config_diffs; telemetry + config_snapshot drive the timeline ---
      const socket = await openConnection(socketUrl, identity);
      try {
        socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, agentVersion: "drift-test", capabilities: ["telemetry", "config_diffs"] }));
        const ack = await readMessage(socket);
        expect(ack.type).toBe("hello_ack");
        expect(ack.capabilities).toContain("config_diffs");

        const path = "/etc/app/settings.env";
        const v1 = "WORKERS=2\nPASSWORD=hunter2\n"; // raw secret on purpose: Hub must re-redact
        const v2 = "WORKERS=4\nPASSWORD=hunter3\nNEW_KEY=1\n";
        const hash1 = sha(v1);
        const hash2 = sha(v2);
        const telemetry = (checksum: string) => JSON.stringify({
          type: "telemetry", timestamp: new Date().toISOString(),
          cpuPercent: 10, memoryPercent: 20, diskPercent: 30,
          networkRxBytes: 0, networkTxBytes: 0, uptimeSeconds: 5,
          configHashes: { [path]: checksum },
        });
        const snapshot = (checksum: string, content: string) => JSON.stringify({
          type: "config_snapshot", version: 1, observedAt: new Date().toISOString(),
          filePath: path, checksumSha256: checksum, status: "redacted_snapshot",
          format: "dotenv", contentRedacted: content, truncated: false, redactionCount: 1,
        });

        socket.send(telemetry(hash1));
        await eventually(async () => {
          const rows = await db`SELECT id,checksum_sha256,diff_status,content_redacted FROM config_snapshots WHERE agent_id=${agentId} AND file_path=${path}`;
          return rows;
        }, (rows) => rows.length === 1 && rows[0].checksum_sha256 === hash1, "first hash-only snapshot row");

        socket.send(snapshot(hash1, v1));
        await eventually(async () => {
          const rows = await db<{ content_redacted: string | null; redaction_count: number; diff_status: string }[]>`
            SELECT content_redacted,redaction_count,diff_status FROM config_snapshots WHERE agent_id=${agentId} AND file_path=${path}`;
          return rows[0] ?? null;
        }, (row) => row !== null && row.content_redacted !== null && row.redaction_count >= 1, "enriched baseline snapshot");
        {
          const rows = await db<{ content_redacted: string | null }[]>`SELECT content_redacted FROM config_snapshots WHERE agent_id=${agentId} AND file_path=${path}`;
          expect(rows).toHaveLength(1); // no duplicate row for the identical checksum
          expect(rows[0].content_redacted).toContain("[REDACTED]");
          expect(rows[0].content_redacted).not.toContain("hunter2");
        }

        socket.send(telemetry(hash2));
        await eventually(async () => {
          const rows = await db`SELECT id,checksum_sha256,incident_id FROM config_snapshots WHERE agent_id=${agentId} AND file_path=${path} ORDER BY captured_at DESC`;
          return rows;
        }, (rows) => rows.length === 2 && rows[0].checksum_sha256 === hash2, "second snapshot row");
        const incident = await eventually(async () => {
          const rows = await db<{ id: string; title: string; category: string; status: string }[]>`
            SELECT id,title,category,status FROM incidents WHERE agent_id=${agentId} AND category='config_drift'`;
          return rows[0] ?? null;
        }, (row) => row !== null, "config_drift incident");
        expect(incident.title).toBe(`Configuration changed: ${path}`);

        socket.send(snapshot(hash2, v2));
        const diffed = await eventually(async () => {
          const rows = await db<{ id: string; diff_status: string; semantic_diff_json: unknown; diff_summary: string | null; incident_id: string | null; redaction_count: number }[]>`
            SELECT id,diff_status,semantic_diff_json,diff_summary,incident_id,redaction_count FROM config_snapshots
            WHERE agent_id=${agentId} AND file_path=${path} AND checksum_sha256=${hash2}`;
          return rows[0] ?? null;
        }, (row) => row !== null && row.diff_status === "diff_available", "semantic diff persisted");
        expect(diffed.incident_id).toBe(incident.id);
        expect(diffed.redaction_count).toBeGreaterThanOrEqual(1);
        // Bun's driver returns jsonb as a string; parse before asserting.
        const rawDiff = typeof diffed.semantic_diff_json === "string"
          ? JSON.parse(diffed.semantic_diff_json)
          : diffed.semantic_diff_json;
        const diff = rawDiff as { changes: { kind: string; key: string }[]; summary: string; unifiedDiff: string };
        expect(diff.changes.some((c) => c.kind === "modified" && c.key === "WORKERS")).toBe(true);
        expect(diff.changes.some((c) => c.kind === "added" && c.key === "NEW_KEY")).toBe(true);
        expect(JSON.stringify(diff)).not.toContain("hunter3");
        expect(diff.summary).toContain("modified");

        // --- Negative WS frames are ignored (no new rows) ---
        const before = await db`SELECT COUNT(*)::int AS n FROM config_snapshots WHERE agent_id=${agentId} AND file_path=${path}`;
        for (const raw of [
          JSON.stringify({ type: "config_snapshot", version: 1, observedAt: new Date().toISOString(), filePath: "relative/path", checksumSha256: hash1, status: "hash_only", unavailableReason: "disabled" }),
          JSON.stringify({ type: "config_snapshot", version: 1, observedAt: new Date().toISOString(), filePath: path, checksumSha256: "BAD", status: "hash_only", unavailableReason: "disabled" }),
          JSON.stringify({ type: "config_snapshot", version: 1, observedAt: new Date().toISOString(), filePath: path, checksumSha256: hash2, status: "redacted_snapshot", format: "dotenv", contentRedacted: "x".repeat(17 * 1024), truncated: false, redactionCount: 0 }),
          JSON.stringify({ type: "config_snapshot", version: 1, observedAt: new Date().toISOString(), filePath: path, checksumSha256: hash2, status: "redacted_snapshot", format: "dotenv", contentRedacted: "A=1\n", truncated: false, redactionCount: 0, extra: true }),
          JSON.stringify({ type: "config_snapshot", version: 1, observedAt: "2020-01-01T00:00:00.000Z", filePath: path, checksumSha256: hash2, status: "hash_only", unavailableReason: "disabled" }),
        ]) socket.send(raw);
        await Bun.sleep(300);
        const after = await db`SELECT COUNT(*)::int AS n FROM config_snapshots WHERE agent_id=${agentId} AND file_path=${path}`;
        expect(after[0].n).toBe(before[0].n);

        // --- HTTP timeline + detail ---
        const listResponse = await api(`/api/drift?filePath=${encodeURIComponent(path)}`);
        expect(listResponse.status).toBe(200);
        const list = await listResponse.json() as { entries: Record<string, unknown>[]; limit: number };
        expect(list.entries).toHaveLength(2);
        const [latest, first] = list.entries;
        expect(latest.diff_status).toBe("diff_available");
        expect(latest.previous_checksum_sha256).toBe(hash1);
        expect(latest.checksum_sha256).toBe(hash2);
        expect(latest.hostname).toBe("drift-test-host");
        expect(latest.incident_id).toBe(incident.id);
        expect(latest.redaction_count).toBeGreaterThanOrEqual(1);
        const counts = latest.change_counts as { added: number; removed: number; modified: number };
        expect(Number.isInteger(counts.modified) && counts.modified >= 1).toBe(true);
        expect(Number.isInteger(counts.added) && counts.added >= 1).toBe(true);
        expect(Number.isInteger(counts.removed)).toBe(true);
        expect(first.diff_status).toBe("hash_only");
        expect(JSON.stringify(list)).not.toContain("hunter2");
        expect(JSON.stringify(list)).not.toContain("hunter3");

        const hostFiltered = await api(`/api/drift?agentId=${agentId}`);
        expect((await hostFiltered.json() as { entries: unknown[] }).entries.length).toBe(3); // includes the legacy row

        const detailResponse = await api(`/api/drift/${latest.id}`);
        expect(detailResponse.status).toBe(200);
        const detail = await detailResponse.json() as {
          semantic_diff_json: { changes: { kind: string; key: string; before: string | null; after: string | null }[]; unifiedDiff: string; summary: string };
          content_redacted: string | null;
          redaction_count: number;
          content_truncated: boolean;
          incident_id: string | null;
          previous_checksum_sha256: string | null;
        };
        expect(detail.semantic_diff_json.changes.length).toBeGreaterThanOrEqual(2);
        expect(detail.semantic_diff_json.unifiedDiff.length).toBeGreaterThan(0);
        expect(detail.previous_checksum_sha256).toBe(hash1);
        expect(detail.incident_id).toBe(incident.id);
        const detailJson = JSON.stringify(detail);
        expect(detailJson).not.toContain("hunter2");
        expect(detailJson).not.toContain("hunter3");
        expect(detail.content_redacted).toContain("[REDACTED]");

        // --- Evidence attached to the config_drift incident, redacted, no causation claim ---
        const incidentResponse = await api(`/api/incidents/${incident.id}`);
        expect(incidentResponse.status).toBe(200);
        const incidentDetail = await incidentResponse.json() as { evidence: { source: string; content: string }[] };
        const configDiffEvidence = incidentDetail.evidence.filter((e) => e.source === "config_diff");
        expect(configDiffEvidence.length).toBeGreaterThanOrEqual(1);
        expect(configDiffEvidence[0].content).toContain("orrelation is not causation");
        expect(JSON.stringify(configDiffEvidence)).not.toContain("hunter3");
      } finally {
        socket.close();
      }
    } finally {
      hub.kill();
      await hub.exited;
    }
  });
}, 120_000);
