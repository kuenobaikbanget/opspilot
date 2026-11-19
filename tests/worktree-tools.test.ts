import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  DEFAULT_RESERVED_PORTS,
  buildHubEnv,
  buildMockEnv,
  buildWebEnv,
  findFreePort,
  isPortAvailable,
  parseDevWorktreeArgs,
  parseEnvFileContent,
  parsePort,
  resolveWorktreePorts,
  validatePort,
} from "../tools/dev-worktree";
import {
  cmdlineReferencesWorktree,
  collectAncestorPids,
  filterCleanupCandidates,
  isPathInsideWorktree,
  parseProcStatPpid,
  parseWorktreeCleanupArgs,
  type ProcEntry,
} from "../tools/worktree-cleanup";

const repoRoot = path.resolve(import.meta.dir, "..");

function listenEphemeral() {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
    },
  });
  return { server, port: server.port };
}

async function runTool(scriptRelativePath: string, args: string[]) {
  const proc = Bun.spawn(
    [process.execPath, "--no-env-file", "run", path.join(repoRoot, scriptRelativePath), ...args],
    {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("dev-worktree port validation and selection", () => {
  test("rejects invalid, out-of-range, and non-numeric ports", () => {
    for (const bad of ["0", "-1", "65536", "NaN", "abc", "3200abc", "3.14", ""]) {
      expect(() => parsePort(bad)).toThrow();
    }
    for (const badNum of [0, -5, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validatePort(badNum)).toThrow();
    }
    expect(parsePort("1")).toBe(1);
    expect(parsePort(" 3200 ")).toBe(3200);
    expect(parsePort("65535")).toBe(65535);
  });

  test("rejects colliding explicit ports and incompatible mode flags", async () => {
    await expect(
      resolveWorktreePorts({ mode: "full", webPort: 3250, hubPort: 3250 }),
    ).rejects.toThrow(/collide/i);

    await expect(
      resolveWorktreePorts({ mode: "mock", webPort: 4250, mockPort: 4250 }),
    ).rejects.toThrow(/collide/i);

    expect(() => parseDevWorktreeArgs(["--mock", "--hub-port", "3201"])).toThrow(/--hub-port/);
    expect(() => parseDevWorktreeArgs(["--mock", "--with-worker"])).toThrow(/--with-worker/);
    expect(() => parseDevWorktreeArgs(["--mock-port", "4202"])).toThrow(/--mock-port/);
    expect(() => parseDevWorktreeArgs(["--mock", "--scenario", "invalid"])).toThrow(/--scenario/);
    expect(() => parseDevWorktreeArgs(["--unknown-flag"])).toThrow(/Unknown argument/);
  });

  test("skips reserved default ports and already-bound ephemeral TCP port", async () => {
    const skipped = await findFreePort(3000, { probe: async () => true });
    expect(DEFAULT_RESERVED_PORTS.has(skipped)).toBe(false);
    expect(skipped).toBe(3002);

    const { server, port: occupiedPort } = listenEphemeral();
    try {
      expect(await isPortAvailable(occupiedPort, "127.0.0.1")).toBe(false);
      const selected = await findFreePort(occupiedPort, { host: "127.0.0.1" });
      expect(selected).not.toBe(occupiedPort);
      expect(selected).toBeGreaterThan(occupiedPort);
      expect(DEFAULT_RESERVED_PORTS.has(selected)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("auto-selected API port never collides with explicit web port", async () => {
    const ports = await resolveWorktreePorts({
      mode: "full",
      webPort: 3201,
      probe: async () => true,
    });
    expect(ports.webPort).toBe(3201);
    expect(ports.apiPort).toBe(3202);
  });

  test("child env construction overrides .env PORT, ALLOWED_ORIGIN, and HUB_INTERNAL_URL", () => {
    const baseEnv = {
      PATH: "/usr/bin",
      PORT: "3001",
      ALLOWED_ORIGIN: "http://localhost:3000",
      HUB_INTERNAL_URL: "http://localhost:3001",
      DATABASE_URL: "postgres://127.0.0.1:5433/opspilot",
    };
    const envFileVars = parseEnvFileContent(
      [
        "# sample env",
        "PORT=3999",
        "ALLOWED_ORIGIN=http://stale.example:3000",
        "HUB_INTERNAL_URL=http://stale.example:3999",
        'export CUSTOM_FLAG="enabled"',
      ].join("\n"),
    );

    const hubEnv = buildHubEnv(baseEnv, { host: "127.0.0.1", hubPort: 3201, webPort: 3200 }, envFileVars);
    expect(hubEnv.PORT).toBe("3201");
    expect(hubEnv.ALLOWED_ORIGIN).toBe("http://127.0.0.1:3200");
    expect(hubEnv.CUSTOM_FLAG).toBe("enabled");

    const webEnv = buildWebEnv(baseEnv, { host: "127.0.0.1", apiPort: 3201 }, envFileVars);
    expect(webEnv.HUB_INTERNAL_URL).toBe("http://127.0.0.1:3201");
    expect(webEnv.PORT).toBeUndefined();
    expect(webEnv.CUSTOM_FLAG).toBe("enabled");

    const mockEnv = buildMockEnv(baseEnv, { port: 4205, scenario: "incidents-error" });
    expect(mockEnv.MOCK_DASHBOARD_PORT).toBe("4205");
    expect(mockEnv.MOCK_DASHBOARD_SCENARIO).toBe("incidents-error");
  });
});

describe("worktree-cleanup path boundary and process filtering", () => {
  test("isPathInsideWorktree enforces strict path boundaries and rejects sibling prefixes", () => {
    const target = "/repo/wt";
    expect(isPathInsideWorktree("/repo/wt", target)).toBe(true);
    expect(isPathInsideWorktree("/repo/wt/", target)).toBe(true);
    expect(isPathInsideWorktree("/repo/wt/apps/web", target)).toBe(true);
    expect(isPathInsideWorktree("/repo/wt/apps/../tools/dev.ts", target)).toBe(true);

    // Negative cases: sibling prefixes, parents, relative paths, empty strings.
    expect(isPathInsideWorktree("/repo/wt-2", target)).toBe(false);
    expect(isPathInsideWorktree("/repo/wt-2/apps/web", target)).toBe(false);
    expect(isPathInsideWorktree("/repo/wt2", target)).toBe(false);
    expect(isPathInsideWorktree("/repo/wt/../wt-2/apps/web", target)).toBe(false);
    expect(isPathInsideWorktree("/repo", target)).toBe(false);
    expect(isPathInsideWorktree("apps/web", target)).toBe(false);
    expect(isPathInsideWorktree("", target)).toBe(false);
    expect(isPathInsideWorktree("/repo/wt", "")).toBe(false);
  });

  test("cmdlineReferencesWorktree matches paths in flags/commands without sibling false positives", () => {
    const target = "/repo/wt";
    expect(cmdlineReferencesWorktree(["bun", "run", "/repo/wt/tools/dev-worktree.ts"], target)).toBe(true);
    expect(cmdlineReferencesWorktree(["node", "--cwd=/repo/wt/apps/web"], target)).toBe(true);
    expect(cmdlineReferencesWorktree(["sh", "-c", "cd /repo/wt && bun dev"], target)).toBe(true);

    expect(cmdlineReferencesWorktree(["bun", "run", "/repo/wt-2/tools/dev-worktree.ts"], target)).toBe(false);
    expect(cmdlineReferencesWorktree(["node", "--cwd=/repo/wt-2/apps/web"], target)).toBe(false);
    expect(cmdlineReferencesWorktree(["bun", "--watch", "src/index.ts"], target)).toBe(false);
  });

  test("collectAncestorPids walks parent chain safely and parses /proc stat ppid", () => {
    expect(parseProcStatPpid("4210 (next-server (v16)) S 3900 4210 3900 0 -1")).toBe(3900);
    expect(parseProcStatPpid("malformed")).toBeNull();

    const parents = new Map<number, number | null>([
      [500, 400],
      [400, 300],
      [300, 1],
      [1, 0],
    ]);
    const ancestors = collectAncestorPids(500, (pid) => parents.get(pid) ?? null);
    expect([...ancestors].sort((a, b) => a - b)).toEqual([1, 300, 400, 500]);
  });

  test("filterCleanupCandidates excludes self, ancestors, PID<=1, and sibling/unrelated processes", () => {
    const target = "/repo/wt";
    const selfPid = 500;
    const excludedPids = new Set([1, 300, 400, 500]);
    const processes: ProcEntry[] = [
      { pid: 1, ppid: 0, cwd: "/repo/wt", cmdline: ["init"] },
      { pid: 300, ppid: 1, cwd: "/repo/wt", cmdline: ["orca-app"] },
      { pid: 400, ppid: 300, cwd: "/repo/wt", cmdline: ["bash"] },
      { pid: 500, ppid: 400, cwd: "/repo/wt", cmdline: ["bun", "run", "tools/worktree-cleanup.ts"] },
      { pid: 601, ppid: 1, cwd: "/repo/wt/apps/hub", cmdline: ["bun", "--watch", "src/index.ts"] },
      { pid: 602, ppid: 1, cwd: "/tmp", cmdline: ["bun", "run", "/repo/wt/tools/mock-dashboard.ts"] },
      { pid: 603, ppid: 1, cwd: "/repo/wt/apps/web", cmdline: ["node", "/repo/wt/apps/web/node_modules/.bin/next"] },
      { pid: 701, ppid: 1, cwd: "/repo/wt-2/apps/hub", cmdline: ["bun", "src/index.ts"] },
      { pid: 702, ppid: 1, cwd: "/tmp", cmdline: ["bun", "run", "/repo/wt-2/tools/mock-dashboard.ts"] },
      { pid: 703, ppid: 1, cwd: "/home/user", cmdline: ["sleep", "60"] },
    ];

    const matched = filterCleanupCandidates(processes, {
      targetPath: target,
      selfPid,
      excludedPids,
    });

    expect(matched.map((item) => ({ pid: item.pid, reason: item.reason }))).toEqual([
      { pid: 601, reason: "cwd" },
      { pid: 602, reason: "cmdline" },
      { pid: 603, reason: "cwd+cmdline" },
    ]);
  });

  test("parseWorktreeCleanupArgs rejects unknown flags and missing --path", () => {
    expect(() => parseWorktreeCleanupArgs(["--path"])).toThrow(/--path/);
    expect(() => parseWorktreeCleanupArgs(["--bad-flag"])).toThrow(/Unknown argument/);
    const parsed = parseWorktreeCleanupArgs(["--dry-run", "--json", "--path", "/tmp/wt"]);
    expect(parsed).toEqual({ help: false, dryRun: true, json: true, targetPath: "/tmp/wt" });
  });
});

describe("CLI --help and --dry-run smoke checks", () => {
  test("dev-worktree supports --help, --dry-run, and rejects invalid arguments", async () => {
    const help = await runTool("tools/dev-worktree.ts", ["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: bun run tools/dev-worktree.ts");

    const fullDry = await runTool("tools/dev-worktree.ts", ["--dry-run"]);
    expect(fullDry.exitCode).toBe(0);
    expect(fullDry.stdout).toContain("Web:");
    expect(fullDry.stdout).toContain("Hub:");
    expect(fullDry.stdout).toContain("Worker: omitted");

    const mockDry = await runTool("tools/dev-worktree.ts", ["--mock", "--dry-run", "--scenario", "empty"]);
    expect(mockDry.exitCode).toBe(0);
    expect(mockDry.stdout).toContain("Web:");
    expect(mockDry.stdout).toContain("Mock API:");
    expect(mockDry.stdout).toContain("scenario: empty");

    const collision = await runTool("tools/dev-worktree.ts", ["--web-port", "3333", "--hub-port", "3333", "--dry-run"]);
    expect(collision.exitCode).not.toBe(0);
    expect(collision.stderr).toContain("collide");

    const invalidPort = await runTool("tools/dev-worktree.ts", ["--web-port", "not-a-number"]);
    expect(invalidPort.exitCode).not.toBe(0);
    expect(invalidPort.stderr).toContain("Invalid --web-port");
  });

  test("worktree-cleanup supports --help, --dry-run --json, and rejects unknown flags", async () => {
    const help = await runTool("tools/worktree-cleanup.ts", ["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: bun run tools/worktree-cleanup.ts");

    const dryJson = await runTool("tools/worktree-cleanup.ts", ["--dry-run", "--json"]);
    expect(dryJson.exitCode).toBe(0);
    const parsed = JSON.parse(dryJson.stdout) as {
      ok: boolean;
      dryRun: boolean;
      targetPath: string;
      matched: Array<{ pid: number }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.targetPath).toBe(repoRoot);
    expect(Array.isArray(parsed.matched)).toBe(true);
    expect(parsed.matched.some((item) => item.pid === process.pid)).toBe(false);

    const invalid = await runTool("tools/worktree-cleanup.ts", ["--nope"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("Unknown argument");
  });
});
