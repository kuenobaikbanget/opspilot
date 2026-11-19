import fs from "node:fs";
import path from "node:path";

export interface ProcEntry {
  pid: number;
  ppid: number | null;
  cwd: string | null;
  cmdline: string[];
}

export type CleanupMatchReason = "cwd" | "cmdline" | "cwd+cmdline";

export interface CleanupCandidate {
  pid: number;
  ppid: number | null;
  cwd: string | null;
  cmdline: string[];
  reason: CleanupMatchReason;
}

export interface WorktreeCleanupArgs {
  help: boolean;
  dryRun: boolean;
  json: boolean;
  targetPath: string;
}

export interface CleanupReport {
  ok: boolean;
  platform: string;
  targetPath: string;
  dryRun: boolean;
  skipped: boolean;
  skipReason?: string;
  matched: Array<{
    pid: number;
    reason: CleanupMatchReason;
    cwd: string | null;
    cmdline: string;
  }>;
  signaled: number[];
  killed: number[];
}

function normalizeAbsolute(rawPath: string): string | null {
  if (!rawPath || !path.isAbsolute(rawPath)) return null;
  const resolved = path.resolve(rawPath);
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

/**
 * Checks whether candidatePath equals or is strictly inside worktreePath using path-segment boundaries.
 * Rejects relative paths and sibling prefixes such as `/repo/wt-2` against `/repo/wt`.
 */
export function isPathInsideWorktree(candidatePath: string, worktreePath: string): boolean {
  const candidate = normalizeAbsolute(candidatePath);
  const target = normalizeAbsolute(worktreePath);
  if (!candidate || !target) return false;
  if (candidate === target) return true;
  const prefix = target === path.sep ? path.sep : `${target}${path.sep}`;
  return candidate.startsWith(prefix);
}

function extractArgTokens(arg: string): string[] {
  const tokens = new Set<string>();
  const addCandidate = (value: string) => {
    if (!value) return;
    tokens.add(value);
    const eqIndex = value.indexOf("=");
    if (eqIndex > 0 && eqIndex + 1 < value.length) {
      tokens.add(value.slice(eqIndex + 1));
    }
  };

  addCandidate(arg);
  for (const part of arg.split(/[\s'"]+/)) {
    addCandidate(part);
  }
  return Array.from(tokens);
}

/** Returns true when any command-line argument token resolves inside worktreePath. */
export function cmdlineReferencesWorktree(args: readonly string[], worktreePath: string): boolean {
  for (const arg of args) {
    for (const token of extractArgTokens(arg)) {
      if (isPathInsideWorktree(token, worktreePath)) return true;
    }
  }
  return false;
}

/** Parses the parent PID (ppid) from a Linux `/proc/<pid>/stat` line. */
export function parseProcStatPpid(statContent: string): number | null {
  const rparen = statContent.lastIndexOf(")");
  if (rparen === -1) return null;
  const rest = statContent.slice(rparen + 1).trim();
  const fields = rest.split(/\s+/);
  // Field 0 after `)` is process state; field 1 is ppid.
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
}

/** Walks parent PIDs from startPid up to PID 1, returning all ancestor PIDs (including startPid). */
export function collectAncestorPids(
  startPid: number,
  readParentPid: (pid: number) => number | null,
): Set<number> {
  const ancestors = new Set<number>();
  let current: number | null = startPid;
  for (let steps = 0; steps < 1024 && current !== null && current > 0; steps++) {
    if (ancestors.has(current)) break;
    ancestors.add(current);
    if (current <= 1) break;
    const parent = readParentPid(current);
    if (parent === null || parent <= 0 || parent === current) break;
    current = parent;
  }
  return ancestors;
}

/** Filters process entries to safe cleanup targets inside targetPath, excluding PID<=1, self, and ancestors. */
export function filterCleanupCandidates(
  processes: readonly ProcEntry[],
  options: {
    targetPath: string;
    alternateTargetPaths?: readonly string[];
    selfPid: number;
    excludedPids: ReadonlySet<number>;
  },
): CleanupCandidate[] {
  const targets = [options.targetPath, ...(options.alternateTargetPaths ?? [])];
  const candidates: CleanupCandidate[] = [];

  for (const proc of processes) {
    if (!Number.isInteger(proc.pid) || proc.pid <= 1) continue;
    if (proc.pid === options.selfPid || options.excludedPids.has(proc.pid)) continue;

    const cwdMatch = proc.cwd !== null && targets.some((target) => isPathInsideWorktree(proc.cwd!, target));
    const cmdlineMatch = targets.some((target) => cmdlineReferencesWorktree(proc.cmdline, target));
    if (!cwdMatch && !cmdlineMatch) continue;

    const reason: CleanupMatchReason =
      cwdMatch && cmdlineMatch ? "cwd+cmdline" : cwdMatch ? "cwd" : "cmdline";

    candidates.push({
      pid: proc.pid,
      ppid: proc.ppid,
      cwd: proc.cwd,
      cmdline: proc.cmdline,
      reason,
    });
  }

  return candidates.sort((a, b) => a.pid - b.pid);
}

/** Parses CLI flags for tools/worktree-cleanup.ts. */
export function parseWorktreeCleanupArgs(
  argv: readonly string[],
  defaultPath = process.cwd(),
): WorktreeCleanupArgs {
  let help = false;
  let dryRun = false;
  let json = false;
  let targetPath = defaultPath;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }

    const eqIndex = arg.indexOf("=");
    const flag = eqIndex >= 0 ? arg.slice(0, eqIndex) : arg;
    const inline = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined;

    if (flag === "--path") {
      const value = inline ?? argv[++i];
      if (!value || (!inline && value.startsWith("-"))) {
        throw new Error("Missing value for --path");
      }
      targetPath = value;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help, dryRun, json, targetPath };
}

function resolveTargetPaths(rawPath: string): { canonical: string; alternate: string[] } {
  const resolved = path.resolve(rawPath);
  try {
    const real = fs.realpathSync(resolved);
    return real === resolved ? { canonical: real, alternate: [] } : { canonical: real, alternate: [resolved] };
  } catch {
    return { canonical: resolved, alternate: [] };
  }
}

function readLinuxProcParentPid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return parseProcStatPpid(stat);
  } catch {
    return null;
  }
}

function readLinuxProcEntries(): { entries: ProcEntry[]; ppidMap: Map<number, number | null> } {
  const entries: ProcEntry[] = [];
  const ppidMap = new Map<number, number | null>();

  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1) continue;

    const ppid = readLinuxProcParentPid(pid);
    ppidMap.set(pid, ppid);

    let cwd: string | null = null;
    try {
      const rawCwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      cwd = rawCwd.endsWith(" (deleted)") ? rawCwd.slice(0, -" (deleted)".length) : rawCwd;
    } catch {
      cwd = null;
    }

    let cmdline: string[] = [];
    try {
      const rawCmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      cmdline = rawCmdline.split("\0").filter((part) => part.length > 0);
    } catch {
      cmdline = [];
    }

    entries.push({ pid, ppid, cwd, cmdline });
  }

  return { entries, ppidMap };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function tryKill(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function terminateMatchedPids(pids: readonly number[], graceMs = 1500): Promise<{ signaled: number[]; killed: number[] }> {
  const signaled: number[] = [];
  for (const pid of pids) {
    if (tryKill(pid, "SIGTERM")) {
      signaled.push(pid);
    }
  }
  if (signaled.length === 0) return { signaled: [], killed: [] };

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && signaled.some((pid) => isProcessAlive(pid))) {
    await Bun.sleep(50);
  }

  const killed: number[] = [];
  for (const pid of signaled) {
    if (isProcessAlive(pid) && tryKill(pid, "SIGKILL")) {
      killed.push(pid);
    }
  }
  return { signaled, killed };
}

function printHelp(): void {
  console.log(`Usage: bun run tools/worktree-cleanup.ts [options]

Find and stop orphaned processes running inside a worktree directory.
Excludes PID <= 1, the current process, and all ancestor processes (such as Orca).

Options:
  --path <dir>   Target worktree directory (default: current working directory)
  --dry-run      Report matching processes without sending signals
  --json         Print machine-readable JSON output
  -h, --help     Show this help message`);
}

function formatReportText(report: CleanupReport): void {
  if (report.skipped) {
    console.log(`worktree-cleanup: skipped (${report.skipReason ?? "unsupported platform"})`);
    return;
  }
  const mode = report.dryRun ? "dry-run" : "cleanup";
  console.log(`worktree-cleanup (${mode}) target=${report.targetPath} matched=${report.matched.length}`);
  for (const item of report.matched) {
    console.log(`  pid=${item.pid} reason=${item.reason} cwd=${item.cwd ?? "-"} cmd=${item.cmdline || "-"}`);
  }
  if (!report.dryRun && report.matched.length > 0) {
    console.log(`  signaled(SIGTERM)=${report.signaled.length} killed(SIGKILL)=${report.killed.length}`);
  }
}

async function runCli(): Promise<void> {
  let args: WorktreeCleanupArgs;
  try {
    args = parseWorktreeCleanupArgs(process.argv.slice(2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`worktree-cleanup error: ${message}`);
    process.exit(1);
  }

  if (args.help) {
    printHelp();
    return;
  }

  const { canonical, alternate } = resolveTargetPaths(args.targetPath);

  if (process.platform !== "linux" || !fs.existsSync("/proc")) {
    const report: CleanupReport = {
      ok: true,
      platform: process.platform,
      targetPath: canonical,
      dryRun: args.dryRun,
      skipped: true,
      skipReason: "/proc inspection is only supported on Linux",
      matched: [],
      signaled: [],
      killed: [],
    };
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else formatReportText(report);
    return;
  }

  const { entries, ppidMap } = readLinuxProcEntries();
  const excludedPids = collectAncestorPids(process.pid, (pid) =>
    ppidMap.has(pid) ? (ppidMap.get(pid) ?? null) : readLinuxProcParentPid(pid),
  );

  const candidates = filterCleanupCandidates(entries, {
    targetPath: canonical,
    alternateTargetPaths: alternate,
    selfPid: process.pid,
    excludedPids,
  });

  const { signaled, killed } = args.dryRun
    ? { signaled: [], killed: [] }
    : await terminateMatchedPids(candidates.map((item) => item.pid));

  const report: CleanupReport = {
    ok: true,
    platform: process.platform,
    targetPath: canonical,
    dryRun: args.dryRun,
    skipped: false,
    matched: candidates.map((item) => ({
      pid: item.pid,
      reason: item.reason,
      cwd: item.cwd,
      cmdline: item.cmdline.join(" "),
    })),
    signaled,
    killed,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    formatReportText(report);
  }
}

if (import.meta.main) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`worktree-cleanup warning: ${message}`);
    process.exit(0);
  });
}
