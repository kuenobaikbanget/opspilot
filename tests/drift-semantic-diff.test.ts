import { describe, expect, test } from "bun:test";

// The Hub drift module imports the db pool, which requires DATABASE_URL at import time.
// No query is ever executed in this unit-test file; the fallback is removed again right
// after the import so it cannot leak into other test files sharing this process.
const hadDatabaseUrl = "DATABASE_URL" in process.env;
process.env.DATABASE_URL ??= "postgres://opspilot:opspilot_dev@127.0.0.1:5433/opspilot_byok_test";

const {
  AGENT_CAPABILITIES,
  MAX_CONFIG_SNAPSHOT_BYTES,
  MAX_CONFIG_SNAPSHOT_CONTENT_BYTES,
  MAX_SEMANTIC_DIFF_CHANGES,
  MAX_SEMANTIC_UNIFIED_DIFF_CHARS,
  negotiateCapabilities,
  parseAgentCapabilities,
  parseConfigSnapshot,
} = await import("../packages/contracts/src/index");
const { computeSemanticDiff, detectConfigFormat } = await import("../apps/hub/src/drift");
if (!hadDatabaseUrl) delete process.env.DATABASE_URL;

const now = Date.now();
const ts = (ms: number) => new Date(ms).toISOString();
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

const validRedacted = (overrides: Record<string, unknown> = {}) => ({
  type: "config_snapshot",
  version: 1,
  observedAt: ts(now),
  filePath: "/etc/app/settings.env",
  checksumSha256: sha("v1"),
  status: "redacted_snapshot",
  format: "dotenv",
  contentRedacted: "WORKERS=4\n",
  truncated: false,
  redactionCount: 0,
  ...overrides,
});

const validHashOnly = (overrides: Record<string, unknown> = {}) => ({
  type: "config_snapshot",
  version: 1,
  observedAt: ts(now),
  filePath: "/etc/app/big.bin",
  checksumSha256: sha("blob"),
  status: "hash_only",
  unavailableReason: "too_large",
  ...overrides,
});

describe("AGENT_CAPABILITIES backwards compatibility", () => {
  test("config_diffs is a known capability and old agents stay valid", () => {
    expect(AGENT_CAPABILITIES).toContain("config_diffs");
    // Legacy agents that never advertise config_diffs negotiate without it.
    expect(negotiateCapabilities(["telemetry", "systemd_status", "diagnostics"])).toEqual([
      "telemetry",
      "systemd_status",
      "diagnostics",
    ]);
    expect(negotiateCapabilities(["telemetry", "config_diffs"])).toEqual(["telemetry", "config_diffs"]);
    expect(parseAgentCapabilities(["telemetry", "systemd_status", "diagnostics", "config_diffs"])).toHaveLength(4);
    expect(parseAgentCapabilities(["shell"])).toBeNull();
  });
});

describe("parseConfigSnapshot", () => {
  test("accepts valid redacted and hash_only frames", () => {
    expect(parseConfigSnapshot(validRedacted(), now)).toEqual(validRedacted());
    expect(parseConfigSnapshot(validHashOnly(), now)).toEqual(validHashOnly());
    // Boundary: content of exactly the cap is accepted.
    const maxContent = "a".repeat(MAX_CONFIG_SNAPSHOT_CONTENT_BYTES);
    const frame = validRedacted({ contentRedacted: maxContent });
    expect(parseConfigSnapshot(frame, now)).toEqual(frame);
    // Timestamp bounds: 119s old and 4s in the future are accepted.
    expect(parseConfigSnapshot(validRedacted({ observedAt: ts(now - 119_000) }), now)).not.toBeNull();
    expect(parseConfigSnapshot(validRedacted({ observedAt: ts(now + 4_000) }), now)).not.toBeNull();
  });

  test("rejects relative paths, bad hashes and path syntax violations", () => {
    for (const bad of [
      validRedacted({ filePath: "etc/app/settings.env" }),
      validRedacted({ filePath: "" }),
      validRedacted({ filePath: "/etc/app/\u0000.env" }),
      validRedacted({ filePath: "/" + "a".repeat(300) }),
      validRedacted({ checksumSha256: "ABC" }),
      validRedacted({ checksumSha256: sha("v1").toUpperCase() }),
      validRedacted({ checksumSha256: "z".repeat(64) }),
      validRedacted({ checksumSha256: sha("v1").slice(0, 63) }),
    ]) {
      expect(parseConfigSnapshot(bad, now)).toBeNull();
    }
  });

  test("rejects oversized content", () => {
    const tooBig = "a".repeat(MAX_CONFIG_SNAPSHOT_CONTENT_BYTES + 1);
    expect(parseConfigSnapshot(validRedacted({ contentRedacted: tooBig }), now)).toBeNull();
    // Multibyte content is measured in bytes, not characters.
    expect(parseConfigSnapshot(validRedacted({ contentRedacted: "é".repeat(MAX_CONFIG_SNAPSHOT_CONTENT_BYTES) }), now)).toBeNull();
  });

  test("rejects unknown keys, missing keys and wrong types per status", () => {
    const invalid = [
      validRedacted({ extra: 1 }),
      validHashOnly({ contentRedacted: "x", format: "text", truncated: false, redactionCount: 0 }),
      validRedacted({ unavailableReason: "disabled" }),
      validHashOnly({ format: "text" }),
      { ...validRedacted(), version: 2 },
      { ...validRedacted(), type: "snapshot" },
      { ...validRedacted(), truncated: "no" },
      { ...validRedacted(), redactionCount: -1 },
      { ...validRedacted(), redactionCount: 1.5 },
      { ...validRedacted(), redactionCount: "3" },
      { ...validRedacted(), redactionCount: 100_001 },
      { ...validRedacted(), format: "xml" },
      { ...validRedacted(), contentRedacted: 42 },
      { ...validHashOnly(), unavailableReason: "symlink" },
      null,
      [],
      "config_snapshot",
      {},
    ];
    for (const bad of invalid) {
      expect(parseConfigSnapshot(bad, now)).toBeNull();
    }
    // Missing one required key rejects even when the rest is valid.
    const missing = validRedacted() as Record<string, unknown>;
    delete missing.truncated;
    expect(parseConfigSnapshot(missing, now)).toBeNull();
    const missingReason = validHashOnly() as Record<string, unknown>;
    delete missingReason.unavailableReason;
    expect(parseConfigSnapshot(missingReason, now)).toBeNull();
  });

  test("rejects bad timestamps", () => {
    for (const bad of [
      validRedacted({ observedAt: "2026-11-26 10:00:00Z" }),
      validRedacted({ observedAt: ts(now).replace("Z", "+00:00") }),
      validRedacted({ observedAt: ts(now - 121_000) }),
      validRedacted({ observedAt: ts(now + 6_000) }),
      validRedacted({ observedAt: "2026-02-30T00:00:00.000Z" }),
      validRedacted({ observedAt: 123 }),
    ]) {
      expect(parseConfigSnapshot(bad, now)).toBeNull();
    }
  });

  test("frame size cap is exported below the WS limit", () => {
    expect(MAX_CONFIG_SNAPSHOT_BYTES).toBe(32 * 1024);
    expect(MAX_CONFIG_SNAPSHOT_BYTES).toBeLessThan(64 * 1024);
    expect(MAX_CONFIG_SNAPSHOT_CONTENT_BYTES).toBe(16 * 1024);
  });
});

describe("detectConfigFormat", () => {
  test("detects by extension and content", () => {
    expect(detectConfigFormat("/etc/app/config.json", "{}")).toBe("json");
    expect(detectConfigFormat("/etc/app/settings.yaml", "a: 1")).toBe("yaml");
    expect(detectConfigFormat("/etc/app/.env", "A=1")).toBe("dotenv");
    expect(detectConfigFormat("/etc/app/prod.env", "A=1")).toBe("dotenv");
    expect(detectConfigFormat("/etc/systemd/system/api.service", "[Service]\nExecStart=/bin/api")).toBe("ini");
    expect(detectConfigFormat("/etc/nginx/nginx.conf", "worker_processes 4;")).toBe("nginx");
    expect(detectConfigFormat("/etc/app/notes.txt", "hello world")).toBe("text");
    expect(detectConfigFormat("/etc/app/data", '{"a":1}')).toBe("json");
    expect(detectConfigFormat("/etc/app/data", "A=1\nB=2")).toBe("dotenv");
    expect(detectConfigFormat("/etc/app/data", "[main]\nx=1")).toBe("ini");
  });
});

describe("computeSemanticDiff", () => {
  test("dotenv: added, removed and modified keys", () => {
    const before = "WORKERS=2\nPASSWORD=hunter2\nTIMEOUT=30\nREMOVED=yes\n";
    const after = "WORKERS=4\nPASSWORD=hunter3\nTIMEOUT=30\nNEW_KEY=1\n";
    const result = computeSemanticDiff("/etc/app/.env", before, after);
    expect(result.format).toBe("dotenv");
    const byKind = (kind: string) => result.changes.filter((c) => c.kind === kind).map((c) => c.key);
    expect(byKind("modified")).toContain("WORKERS");
    expect(byKind("added")).toEqual(["NEW_KEY"]);
    expect(byKind("removed")).toEqual(["REMOVED"]);
    const workers = result.changes.find((c) => c.key === "WORKERS");
    expect(workers).toMatchObject({ kind: "modified", before: "2", after: "4" });
    // Secret values must never leak, even though the key changed.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("hunter3");
    expect(result.summary).toContain("modified");
    expect(result.summary).toContain("WORKERS");
    expect(result.addedLines).toBeGreaterThan(0);
    expect(result.removedLines).toBeGreaterThan(0);
  });

  test("systemd unit / INI: sections are tracked", () => {
    const before = "[Unit]\nDescription=api\n\n[Service]\nExecStart=/usr/bin/api --old\nMemoryMax=512M\n";
    const after = "[Unit]\nDescription=api\n\n[Service]\nExecStart=/usr/bin/api --new\nMemoryMax=1G\nRestart=always\n";
    const result = computeSemanticDiff("/etc/systemd/system/api.service", before, after);
    expect(result.format).toBe("ini");
    const exec = result.changes.find((c) => c.key === "ExecStart");
    expect(exec).toMatchObject({ kind: "modified", section: "Service", before: "/usr/bin/api --old", after: "/usr/bin/api --new" });
    const mem = result.changes.find((c) => c.key === "MemoryMax");
    expect(mem).toMatchObject({ kind: "modified", section: "Service" });
    expect(result.changes.find((c) => c.key === "Restart")).toMatchObject({ kind: "added", section: "Service" });
  });

  test("json: nested dotted paths", () => {
    const before = JSON.stringify({ server: { port: 80, host: "a" }, list: [1, 2] });
    const after = JSON.stringify({ server: { port: 8080, host: "a" }, list: [1, 3], extra: "x" });
    const result = computeSemanticDiff("/etc/app/config.json", before, after);
    expect(result.format).toBe("json");
    expect(result.changes.find((c) => c.key === "server.port")).toMatchObject({ kind: "modified", before: "80", after: "8080" });
    expect(result.changes.find((c) => c.key === "list[1]")).toMatchObject({ kind: "modified", before: "2", after: "3" });
    expect(result.changes.find((c) => c.key === "extra")).toMatchObject({ kind: "added", after: "x" });
  });

  test("yaml: nested keys via indentation", () => {
    const before = "server:\n  port: 80\n  host: example\n";
    const after = "server:\n  port: 8080\n  host: example\n";
    const result = computeSemanticDiff("/etc/app/config.yaml", before, after);
    expect(result.format).toBe("yaml");
    expect(result.changes.find((c) => c.key === "server.port")).toMatchObject({ kind: "modified", before: "80", after: "8080" });
  });

  test("nginx: directives and block sections", () => {
    const before = "worker_processes 4;\nevents {\n  worker_connections 768;\n}\nhttp {\n  server {\n    listen 80;\n    location / {\n      proxy_pass http://127.0.0.1:3000;\n    }\n  }\n}\n";
    const after = "worker_processes 8;\nevents {\n  worker_connections 768;\n}\nhttp {\n  server {\n    listen 443;\n    location / {\n      proxy_pass http://127.0.0.1:3001;\n    }\n  }\n}\n";
    const result = computeSemanticDiff("/etc/nginx/nginx.conf", before, after);
    expect(result.format).toBe("nginx");
    const workers = result.changes.find((c) => c.key === "worker_processes");
    expect(workers).toMatchObject({ kind: "modified", before: "4", after: "8" });
    const listen = result.changes.find((c) => c.key === "listen");
    expect(listen).toMatchObject({ kind: "modified", section: "http > server", before: "80", after: "443" });
    expect(result.changes.find((c) => c.key === "proxy_pass")).toMatchObject({ kind: "modified", section: "http > server > location /" });
  });

  test("plain text falls back to line-level changes", () => {
    const result = computeSemanticDiff("/etc/app/notes.txt", "alpha\nbeta\n", "alpha\ngamma\n");
    expect(result.format).toBe("text");
    expect(result.changes.some((c) => c.kind === "removed" && c.key.includes("beta"))).toBe(true);
    expect(result.changes.some((c) => c.kind === "added" && c.key.includes("gamma"))).toBe(true);
  });

  test("defense-in-depth redaction: no secret leaks into any output", () => {
    const secret = "sk-live-abcdefghijklmnopqrstuvwxyz99";
    const before = `api_key = "${secret}"\npassword=hunter2\n`;
    const after = `api_key = "${secret}"\npassword=hunter3\ndb = "postgres://u:p@host/db"\n`;
    const result = computeSemanticDiff("/etc/app/.env", before, after);
    const serialized = JSON.stringify(result);
    for (const leak of [secret, "hunter2", "hunter3", "postgres://u:p@"]) {
      expect(serialized).not.toContain(leak);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  test("bounds: unified diff and changes are capped", () => {
    const before = Array.from({ length: 900 }, (_, i) => `line-${i}`).join("\n");
    const after = Array.from({ length: 900 }, (_, i) => `line-${i}-changed`).join("\n");
    const result = computeSemanticDiff("/etc/app/big.txt", before, after);
    expect(result.unifiedDiff.length).toBeLessThanOrEqual(MAX_SEMANTIC_UNIFIED_DIFF_CHARS + 64);
    expect(result.truncated).toBe(true);
    expect(result.changes.length).toBeLessThanOrEqual(MAX_SEMANTIC_DIFF_CHANGES);
    // Small diffs are not marked truncated.
    const small = computeSemanticDiff("/etc/app/.env", "A=1\n", "A=2\n");
    expect(small.truncated).toBe(false);
    expect(small.unifiedDiff.length).toBeLessThan(MAX_SEMANTIC_UNIFIED_DIFF_CHARS);
  });

  test("summary matches the documented shape", () => {
    const result = computeSemanticDiff(
      "/etc/nginx/nginx.conf",
      "worker_processes 4;\nhttp {\n  server {\n    proxy_pass http://a;\n  }\n}\n",
      "worker_processes 8;\nhttp {\n  server {\n    proxy_pass http://b;\n    keepalive 16;\n  }\n}\n",
    );
    expect(result.summary).toBe("nginx: 2 keys modified (proxy_pass, worker_processes), 1 added (keepalive)");
  });
});
