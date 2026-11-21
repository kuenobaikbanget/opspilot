import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDevLoopbackInstallEnabled } from "../apps/hub/src/agent-install";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_WEB_PORT_START = 3200;
export const DEFAULT_HUB_PORT_START = 3201;
export const DEFAULT_MOCK_PORT_START = 4202;
export const DEFAULT_RESERVED_PORTS: ReadonlySet<number> = new Set([3000, 3001, 3100, 4102]);
export const MOCK_SCENARIOS = ["populated", "empty", "incidents-error"] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];
export type PortProbe = (port: number, host: string) => Promise<boolean>;

export interface DevWorktreeArgs {
  help: boolean;
  dryRun: boolean;
  mock: boolean;
  withWorker: boolean;
  host: string;
  webPort?: number;
  hubPort?: number;
  mockPort?: number;
  envFile?: string;
  scenario: MockScenario;
}

export interface ResolvedWorktreePorts {
  webPort: number;
  apiPort: number;
}

/** Validates that a numeric port is an integer within TCP port bounds (1..65535). */
export function validatePort(port: number, label = "port"): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} "${port}": must be an integer between 1 and 65535`);
  }
  return port;
}

/** Parses a CLI port string strictly as an integer between 1 and 65535. */
export function parsePort(raw: string, label = "port"): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${label} "${raw}": must be an integer between 1 and 65535`);
  }
  return validatePort(Number(trimmed), label);
}

/** Formats an HTTP origin from a host and port, bracketing bare IPv6 literals. */
export function formatHttpOrigin(host: string, port: number): string {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

/** Validates a bind/connect host name or IP literal without scheme or path separators. */
export function validateHost(raw: string): string {
  const host = raw.trim();
  if (!host || /[\s/?#]/.test(host) || host.includes("://")) {
    throw new Error(`Invalid --host "${raw}": expected a hostname or IP literal without scheme or spaces`);
  }
  return host;
}

/** Parses simple KEY=VALUE lines from an env file without executing shell syntax. */
export function parseEnvFileContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/** Probes whether a TCP port can be bound exclusively on the given loopback/host address. */
export async function isPortAvailable(port: number, host = DEFAULT_HOST): Promise<boolean> {
  validatePort(port);
  try {
    const server = Bun.listen({
      hostname: host,
      port,
      socket: {
        data() {},
      },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Finds the first available TCP port at or above startPort, skipping reserved and occupied ports. */
export async function findFreePort(
  startPort: number,
  options: {
    host?: string;
    exclude?: ReadonlySet<number>;
    maxAttempts?: number;
    probe?: PortProbe;
  } = {},
): Promise<number> {
  let candidate = validatePort(startPort, "startPort");
  const host = options.host ?? DEFAULT_HOST;
  const exclude = options.exclude ?? DEFAULT_RESERVED_PORTS;
  const maxAttempts = options.maxAttempts ?? 200;
  const probe = options.probe ?? isPortAvailable;

  for (let attempt = 0; attempt < maxAttempts && candidate <= 65535; attempt++, candidate++) {
    if (exclude.has(candidate)) continue;
    if (await probe(candidate, host)) return candidate;
  }
  throw new Error(`Could not find an available TCP port starting from ${startPort} on ${host}`);
}

/** Resolves non-colliding Web and API (Hub or Mock) ports for the current worktree runner mode. */
export async function resolveWorktreePorts(options: {
  mode: "full" | "mock";
  webPort?: number;
  hubPort?: number;
  mockPort?: number;
  host?: string;
  probe?: PortProbe;
}): Promise<ResolvedWorktreePorts> {
  const probeHost = DEFAULT_HOST;
  const explicitApiPort = options.mode === "mock" ? options.mockPort : options.hubPort;
  const apiFlag = options.mode === "mock" ? "--mock-port" : "--hub-port";
  const apiDefaultStart = options.mode === "mock" ? DEFAULT_MOCK_PORT_START : DEFAULT_HUB_PORT_START;

  if (options.webPort !== undefined) validatePort(options.webPort, "--web-port");
  if (explicitApiPort !== undefined) validatePort(explicitApiPort, apiFlag);

  if (options.webPort !== undefined && explicitApiPort !== undefined && options.webPort === explicitApiPort) {
    throw new Error(`Explicit ports cannot collide: --web-port and ${apiFlag} are both ${options.webPort}`);
  }

  const webExclude = new Set(DEFAULT_RESERVED_PORTS);
  if (explicitApiPort !== undefined) webExclude.add(explicitApiPort);

  const webPort =
    options.webPort ??
    (await findFreePort(DEFAULT_WEB_PORT_START, {
      host: probeHost,
      exclude: webExclude,
      probe: options.probe,
    }));

  const apiExclude = new Set(DEFAULT_RESERVED_PORTS);
  apiExclude.add(webPort);

  const apiPort =
    explicitApiPort ??
    (await findFreePort(apiDefaultStart, {
      host: probeHost,
      exclude: apiExclude,
      probe: options.probe,
    }));

  return { webPort, apiPort };
}

function mergeCleanEnv(
  baseEnv: Record<string, string | undefined>,
  envFileVars?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) merged[key] = value;
  }
  if (envFileVars) {
    for (const [key, value] of Object.entries(envFileVars)) {
      merged[key] = value;
    }
  }
  return merged;
}

/** Builds the child environment for @opspilot/hub with worktree PORT and ALLOWED_ORIGIN overrides. */
export function buildHubEnv(
  baseEnv: Record<string, string | undefined>,
  options: { host: string; hubPort: number; webPort: number },
  envFileVars?: Record<string, string>,
): Record<string, string> {
  const env = mergeCleanEnv(baseEnv, envFileVars);
  env.PORT = String(options.hubPort);
  env.ALLOWED_ORIGIN = formatHttpOrigin(options.host, options.webPort);
  return env;
}

/** Builds the child environment for @opspilot/web with HUB_INTERNAL_URL overriding any .env value. */
export function buildWebEnv(
  baseEnv: Record<string, string | undefined>,
  options: { host: string; apiPort: number },
  envFileVars?: Record<string, string>,
): Record<string, string> {
  const env = mergeCleanEnv(baseEnv, envFileVars);
  delete env.PORT;
  env.HUB_INTERNAL_URL = formatHttpOrigin(options.host, options.apiPort);
  return env;
}

/** Builds the child environment for @opspilot/worker, merging optional --env-file variables. */
export function buildWorkerEnv(
  baseEnv: Record<string, string | undefined>,
  envFileVars?: Record<string, string>,
): Record<string, string> {
  return mergeCleanEnv(baseEnv, envFileVars);
}

/** Builds the child environment for tools/mock-dashboard.ts with explicit port and scenario. */
export function buildMockEnv(
  baseEnv: Record<string, string | undefined>,
  options: { port: number; scenario: MockScenario },
): Record<string, string> {
  const env = mergeCleanEnv(baseEnv);
  env.MOCK_DASHBOARD_PORT = String(options.port);
  env.MOCK_DASHBOARD_SCENARIO = options.scenario;
  return env;
}

/** Parses CLI flags for tools/dev-worktree.ts and rejects invalid or conflicting options. */
export function parseDevWorktreeArgs(argv: readonly string[]): DevWorktreeArgs {
  let help = false;
  let dryRun = false;
  let mock = false;
  let withWorker = false;
  let host = DEFAULT_HOST;
  let webPort: number | undefined;
  let hubPort: number | undefined;
  let mockPort: number | undefined;
  let envFile: string | undefined;
  let scenario: MockScenario | undefined;

  const readValue = (index: number, flag: string, inline?: string): { value: string; nextIndex: number } => {
    if (inline !== undefined) return { value: inline, nextIndex: index };
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return { value: next, nextIndex: index + 1 };
  };

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
    if (arg === "--mock") {
      mock = true;
      continue;
    }
    if (arg === "--with-worker") {
      withWorker = true;
      continue;
    }

    const eqIndex = arg.indexOf("=");
    const flag = eqIndex >= 0 ? arg.slice(0, eqIndex) : arg;
    const inline = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined;

    switch (flag) {
      case "--web-port": {
        const res = readValue(i, flag, inline);
        webPort = parsePort(res.value, "--web-port");
        i = res.nextIndex;
        break;
      }
      case "--hub-port": {
        const res = readValue(i, flag, inline);
        hubPort = parsePort(res.value, "--hub-port");
        i = res.nextIndex;
        break;
      }
      case "--mock-port": {
        const res = readValue(i, flag, inline);
        mockPort = parsePort(res.value, "--mock-port");
        i = res.nextIndex;
        break;
      }
      case "--host": {
        const res = readValue(i, flag, inline);
        host = validateHost(res.value);
        i = res.nextIndex;
        break;
      }
      case "--env-file": {
        const res = readValue(i, flag, inline);
        if (!res.value.trim()) throw new Error("Invalid --env-file: path cannot be empty");
        envFile = res.value;
        i = res.nextIndex;
        break;
      }
      case "--scenario": {
        const res = readValue(i, flag, inline);
        if (!MOCK_SCENARIOS.includes(res.value as MockScenario)) {
          throw new Error(`Invalid --scenario "${res.value}": must be one of ${MOCK_SCENARIOS.join(", ")}`);
        }
        scenario = res.value as MockScenario;
        i = res.nextIndex;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!help) {
    if (mock) {
      if (hubPort !== undefined) throw new Error("--hub-port cannot be used with --mock; use --mock-port");
      if (withWorker) throw new Error("--with-worker cannot be used with --mock");
      if (envFile !== undefined) throw new Error("--env-file cannot be used with --mock");
    } else {
      if (mockPort !== undefined) throw new Error("--mock-port requires --mock");
      if (scenario !== undefined) throw new Error("--scenario requires --mock");
    }
  }

  return {
    help,
    dryRun,
    mock,
    withWorker,
    host,
    webPort,
    hubPort,
    mockPort,
    envFile,
    scenario: scenario ?? "populated",
  };
}

function printHelp(): void {
  console.log(`Usage: bun run tools/dev-worktree.ts [options]

Start OpsPilot services on isolated TCP ports for the current git/Orca worktree.

Options:
  --mock                       Run Web against tools/mock-dashboard.ts (no DB/.env required)
  --web-port <port>            Web port (auto-probed from ${DEFAULT_WEB_PORT_START} on 127.0.0.1)
  --hub-port <port>            Hub API port in full-stack mode (auto-probed from ${DEFAULT_HUB_PORT_START})
  --mock-port <port>           Mock API port in --mock mode (auto-probed from ${DEFAULT_MOCK_PORT_START})
  --host <host>                Bind/URL host (default: ${DEFAULT_HOST})
  --with-worker                Also start @opspilot/worker in full-stack mode (omitted by default)
  --env-file <path>            Load additional env vars from file (explicit ports/URLs still override)
  --scenario <name>            Mock scenario: ${MOCK_SCENARIOS.join("|")} (default: populated)
  --dry-run                    Resolve ports and print startup plan without spawning processes
  -h, --help                   Show this help message`);
}

function signalProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall back to direct child signaling if the process group already exited or is unavailable.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Ignore ESRCH when child already exited.
  }
}

function isAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

async function terminateChildren(children: readonly { name: string; proc: ChildProcess }[], graceMs = 2000): Promise<void> {
  const alive = children.filter((item) => isAlive(item.proc));
  if (alive.length === 0) return;

  for (const item of alive) {
    signalProcessGroup(item.proc, "SIGTERM");
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && alive.some((item) => isAlive(item.proc))) {
    await Bun.sleep(50);
  }

  const remaining = alive.filter((item) => isAlive(item.proc));
  if (remaining.length > 0) {
    for (const item of remaining) {
      signalProcessGroup(item.proc, "SIGKILL");
    }
    const killDeadline = Date.now() + 500;
    while (Date.now() < killDeadline && remaining.some((item) => isAlive(item.proc))) {
      await Bun.sleep(25);
    }
  }
}

async function runCli(): Promise<void> {
  const args = parseDevWorktreeArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(import.meta.dir, "..");
  let envFileVars: Record<string, string> | undefined;
  if (!args.mock && args.envFile) {
    const resolvedEnvPath = path.resolve(process.cwd(), args.envFile);
    if (!fs.existsSync(resolvedEnvPath)) {
      throw new Error(`Env file not found: ${resolvedEnvPath}`);
    }
    envFileVars = parseEnvFileContent(fs.readFileSync(resolvedEnvPath, "utf8"));
  }
  if (!args.mock && isDevLoopbackInstallEnabled(mergeCleanEnv(process.env, envFileVars)) && args.host !== DEFAULT_HOST) {
    throw new Error("Loopback agent installation requires --host 127.0.0.1 for the Web proxy");
  }

  const { webPort, apiPort } = await resolveWorktreePorts({
    mode: args.mock ? "mock" : "full",
    webPort: args.webPort,
    hubPort: args.hubPort,
    mockPort: args.mockPort,
    host: args.host,
  });

  const webUrl = formatHttpOrigin(args.host, webPort);
  const apiUrl = formatHttpOrigin(args.host, apiPort);
  const nextBin = path.join(repoRoot, "apps/web/node_modules/.bin/next");
  const webDir = path.join(repoRoot, "apps/web");

  if (args.mock) {
    console.log("OpsPilot worktree dev runner (mock UI)");
    console.log(`  Web:      ${webUrl}`);
    console.log(`  Mock API: ${apiUrl} (scenario: ${args.scenario})`);
  } else {
    console.log("OpsPilot worktree dev runner (full-stack)");
    console.log(`  Web:    ${webUrl}`);
    console.log(`  Hub:    ${apiUrl}`);
    console.log(
      args.withWorker
        ? "  Worker: enabled (@opspilot/worker)"
        : "  Worker: omitted (pass --with-worker to run @opspilot/worker; omitted by default to avoid competing on DATABASE_URL SKIP LOCKED)",
    );
  }

  if (args.dryRun) {
    console.log("Dry run: no processes started.");
    return;
  }

  if (!fs.existsSync(nextBin)) {
    throw new Error(`Next.js binary not found at ${nextBin}. Run "bun install --frozen-lockfile" first.`);
  }

  const children: Array<{ name: string; proc: ChildProcess }> = [];
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nShutting down worktree services (${reason})...`);
    await terminateChildren(children);
    process.exit(exitCode);
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      void shutdown(sig, 0);
    });
  }

  const launch = (
    name: string,
    command: string,
    cmdArgs: string[],
    cwd: string,
    env: Record<string, string>,
  ) => {
    const proc = spawn(command, cmdArgs, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    }) as ChildProcess & {
      on(event: "error", listener: (err: Error) => void): unknown;
      on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    };
    children.push({ name, proc });
    proc.on("error", (err: Error) => {
      void shutdown(`${name} failed to start: ${err.message}`, 1);
    });
    proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (shuttingDown) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      void shutdown(`${name} exited unexpectedly (${detail})`, code && code !== 0 ? code : 1);
    });
  };

  if (args.mock) {
    launch(
      "mock-dashboard",
      process.execPath,
      ["--no-env-file", "run", path.join(repoRoot, "tools/mock-dashboard.ts")],
      repoRoot,
      buildMockEnv(process.env, { port: apiPort, scenario: args.scenario }),
    );
    launch(
      "web",
      nextBin,
      ["dev", "--hostname", args.host, "--port", String(webPort)],
      webDir,
      buildWebEnv(process.env, { host: args.host, apiPort }),
    );
  } else {
    launch(
      "hub",
      process.execPath,
      ["--no-env-file", "--watch", "src/index.ts"],
      path.join(repoRoot, "apps/hub"),
      buildHubEnv(process.env, { host: args.host, hubPort: apiPort, webPort }, envFileVars),
    );
    if (args.withWorker) {
      launch(
        "worker",
        process.execPath,
        ["--no-env-file", "--watch", "src/index.ts"],
        path.join(repoRoot, "apps/worker"),
        buildWorkerEnv(process.env, envFileVars),
      );
    }
    launch(
      "web",
      nextBin,
      ["dev", "--hostname", args.host, "--port", String(webPort)],
      webDir,
      buildWebEnv(process.env, { host: args.host, apiPort }, envFileVars),
    );
  }

  // Keep the supervisor alive until a child exits unexpectedly or a termination signal arrives.
  await new Promise(() => {});
}

if (import.meta.main) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`dev-worktree error: ${message}`);
    process.exit(1);
  });
}
