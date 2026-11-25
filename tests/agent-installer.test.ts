import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHttpsAgentInstaller, readAgentInstallConfig } from "../apps/hub/src/agent-install";

const template = new URL("../infra/install/agent.sh", import.meta.url).pathname;
const token = "a".repeat(43);
const valid = ["--token", token];
const bash = Bun.which("bash")!;
const fixture = mkdtempSync(join(tmpdir(), "opspilot-installer-negative-"));
const script = join(fixture, "agent.sh");
const config = readAgentInstallConfig({ OPSPILOT_PUBLIC_HUB_URL: "https://hub.example", OPSPILOT_AGENT_VERSION: "v1.2.3" });
if (config?.mode !== "https") throw new Error("Fixture requires HTTPS installation metadata");
const configured = await loadHttpsAgentInstaller(config);
if (!configured) throw new Error("Fixture could not load the configured installer");
writeFileSync(script, configured);
writeFileSync(join(fixture, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo unsupported-fixture-architecture ;; esac\n', { mode: 0o755 });
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function reject(args: string[], error: string, file = script) {
  // The isolated PATH always blocks a valid invocation at architecture preflight.
  // No test can download or mutate workstation installation paths.
  const result = Bun.spawnSync([bash, file, ...args], { env: { PATH: fixture }, stdout: "pipe", stderr: "pipe" });
  const output = result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(output).toContain(error);
  expect(output).not.toContain(token);
  expect(result.stdout.toString()).toBe("");
}

describe("installer refuses invalid input before mutation", () => {
  test("the unconfigured template cannot install", () => {
    reject(valid, "Download the configured installer from your HTTPS Hub", template);
  });
  test("accepts only the token argument, not deployment overrides", () => {
    for (const args of [[], ["--token"], [...valid, "--force", "yes"], [...valid, ...valid],
      [...valid, "--hub-url", "https://other.example"], [...valid, "--version", "v2.0.0"], [...valid, "--repository", "other/repo"]]) {
      reject(args, "Usage:");
    }
  });
  test("rejects malformed tokens", () => {
    for (const value of ["", "short", "x".repeat(44), "x".repeat(42) + ";", "'$(id)'"]) {
      reject(["--token", value], "Token must be a 43-character");
    }
  });
  test("unsupported architecture cannot progress even with a valid token", () => reject(valid, "Unsupported architecture"));

  test.each(["x86_64", "amd64", "aarch64", "arm64"])("accepts target Linux %s before system preflight", (arch) => {
    const path = join(fixture, arch);
    mkdirSync(path);
    writeFileSync(join(path, "uname"), `#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo ${arch} ;; esac\n`, { mode: 0o755 });
    const result = Bun.spawnSync([bash, script, ...valid], { env: { PATH: path }, stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(process.geteuid?.() === 0 ? "Missing dependency: bash" : "sudo is required");
  });
});

test.skipIf(process.geteuid?.() !== 0)("root uses the delivered installer without sudo", () => {
  const path = join(fixture, "root");
  mkdirSync(path);
  writeFileSync(join(path, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n', { mode: 0o755 });
  writeFileSync(join(path, "sudo"), '#!/bin/sh\necho "unexpected sudo" >&2\nexit 99\n', { mode: 0o755 });
  const result = Bun.spawnSync([bash, script, ...valid], { env: { PATH: path }, stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Missing dependency: bash");
  expect(result.stderr.toString()).not.toContain("unexpected sudo");
});

describe.skipIf(process.geteuid?.() === 0)("delivered installer privilege handoff", () => {
  test.each(["denied", "not-root"])("stops when sudo is %s, without leaking or leaving the token", (scenario) => {
    const path = mkdtempSync(join(fixture, "sudo case '"));
    const localScript = join(path, "installer ' copy.sh");
    const scratch = join(path, "tmp");
    const recorded = join(path, "sudo calls");
    mkdirSync(scratch);
    writeFileSync(localScript, configured!, { mode: 0o600 });
    writeFileSync(join(path, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n', { mode: 0o755 });
    for (const tool of ["bash", "mktemp", "rm", "stat"]) symlinkSync(Bun.which(tool)!, join(path, tool));
    // Simulate denial, or run the exact sudo payload without elevating.
    writeFileSync(join(path, "sudo"), `#!${bash}
set -eu
printf '%s\\0' "$@" >> "$SUDO_CALLS"
[[ "$1 $2 $3" == '-u root --' ]] || exit 95
[[ "\${@: -2:1}" == "$LOCAL_SCRIPT" ]] || exit 96
handoff=\${!#}
[[ "$handoff" == "$TMPDIR/"* && "$(stat -c %a "$handoff")" == 600 ]] || exit 97
[[ $(<"$handoff") == "$EXPECTED_TOKEN" ]] || exit 98
if IFS= read -r line; then exit 99; fi
if [[ "$CASE" == denied ]]; then
  printf 'sudo: permission denied\\n' >&2
  exit 1
fi
shift 3
exec "$@"
`, { mode: 0o755 });
    const result = Bun.spawnSync([bash, localScript, ...valid], {
      env: { PATH: path, TMPDIR: scratch, SUDO_CALLS: recorded, LOCAL_SCRIPT: localScript, EXPECTED_TOKEN: token, CASE: scenario },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    expect(result.exitCode).toBe(1);
    const error = result.stderr.toString();
    expect(error).toContain(scenario === "denied" ? "sudo: permission denied" : "sudo did not grant root privileges");
    const calls = readFileSync(recorded, "utf8").split("\0");
    expect(calls.filter(arg => arg === localScript)).toHaveLength(1);
    expect(calls.join(" ")).not.toContain(token);
    expect(error).not.toContain(token);
    expect(result.stdout.toString()).toBe("");
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe("piped stdin execution (curl | bash -s -- --token ...)", () => {
  test("a truncated piped script fails as a syntax error and executes nothing", () => {
    const path = mkdtempSync(join(fixture, "pipe-truncated-"));
    const scratch = join(path, "tmp");
    const executed = join(path, "executed");
    mkdirSync(scratch);
    symlinkSync(bash, join(path, "bash"));
    writeFileSync(join(path, "uname"), `#!/bin/sh\ntouch ${JSON.stringify(executed)}\necho Linux\n`, { mode: 0o755 });
    const truncatedFile = join(path, "truncated.sh");
    const cut = configured!.indexOf("main() {") + 400;
    const truncated = configured!.slice(0, cut);
    // The final `main "$@"` invocation lies beyond the truncation point, so Bash hits EOF mid-function.
    expect(configured!.slice(cut)).toContain('main "$@"');
    writeFileSync(truncatedFile, truncated);
    // $0 of a piped `bash -s` is the shell name, not a readable script file.
    const result = Bun.spawnSync([bash, "-c", 'exec bash -s -- --token "$0" < "$1"', token, truncatedFile], {
      cwd: scratch, env: { PATH: path, TMPDIR: scratch }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(/syntax error|unexpected end of file/);
    expect(result.stderr.toString()).not.toContain(token);
    expect(result.stdout.toString()).toBe("");
    expect(existsSync(executed)).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe.skipIf(process.geteuid?.() === 0)("piped stdin privilege handoff", () => {
  test.each(["denied", "not-root"])("serializes the piped script to private 0600 handoffs without leaking the token when sudo is %s", (scenario) => {
    const path = mkdtempSync(join(fixture, "pipe-sudo-"));
    const scratch = join(path, "tmp");
    const recorded = join(path, "sudo calls");
    const stdinCapture = join(path, "sudo stdin");
    const piped = join(path, "piped.sh");
    mkdirSync(scratch);
    writeFileSync(piped, configured!, { mode: 0o600 });
    writeFileSync(join(path, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n', { mode: 0o755 });
    for (const tool of ["bash", "cat", "mktemp", "rm", "stat", "tail", "grep"]) symlinkSync(Bun.which(tool)!, join(path, tool));
    writeFileSync(join(path, "sudo"), `#!${bash}
set -eu
printf '%s\\0' "$@" >> "$SUDO_CALLS"
cat > "$STDIN_CAPTURE"
[[ "$1 $2 $3" == '-u root --' ]] || exit 95
script=\${@: -2:1}
handoff=\${!#}
[[ "$script" == "$TMPDIR/"* && "$(stat -c %a "$script")" == 600 ]] || exit 97
[[ "$handoff" == "$TMPDIR/"* && "$(stat -c %a "$handoff")" == 600 ]] || exit 98
[[ $(<"$handoff") == "$EXPECTED_TOKEN" ]] || exit 99
grep -q '^hub_url=https://hub.example version=v1.2.3 repository=kuenobaikbanget/opspilot$' "$script" || exit 101
grep -q -- '-euo pipefail' "$script" || exit 102
[[ "$(tail -n 1 "$script")" == 'main "$@"' ]] || exit 103
if [[ "$CASE" == denied ]]; then
  printf 'sudo: permission denied\\n' >&2
  exit 1
fi
shift 3
exec "$@"
`, { mode: 0o755 });
    const result = Bun.spawnSync([bash, "-c", 'exec bash -s -- --token "$0" < "$1"', token, piped], {
      cwd: scratch,
      env: { PATH: path, TMPDIR: scratch, SUDO_CALLS: recorded, STDIN_CAPTURE: stdinCapture, EXPECTED_TOKEN: token, CASE: scenario },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    expect(result.exitCode).toBe(1);
    const error = result.stderr.toString();
    expect(error).toContain(scenario === "denied" ? "sudo: permission denied" : "sudo did not grant root privileges");
    const calls = readFileSync(recorded, "utf8").split("\0");
    expect(calls).not.toContain(piped);
    expect(calls.join(" ")).not.toContain(token);
    expect(readFileSync(stdinCapture, "utf8")).not.toContain(token);
    expect(error).not.toContain(token);
    expect(result.stdout.toString()).toBe("");
    expect(readdirSync(scratch)).toEqual([]);
  });

  test.each(["absolute-bash", "cwd-bash-file"])("still serializes when $0 resolves to a readable file (%s)", (mode) => {
    const path = mkdtempSync(join(fixture, `pipe-sudo-${mode}-`));
    const scratch = join(path, "tmp");
    const workDir = join(path, "work");
    const recorded = join(path, "sudo calls");
    const piped = join(path, "piped.sh");
    const decoyBash = join(workDir, "bash");
    mkdirSync(scratch);
    mkdirSync(workDir);
    writeFileSync(piped, configured!, { mode: 0o600 });
    if (mode === "cwd-bash-file") {
      writeFileSync(decoyBash, "#!/bin/sh\necho decoy-executed >&2\nexit 88\n", { mode: 0o644 });
    }
    writeFileSync(join(path, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n', { mode: 0o755 });
    for (const tool of ["bash", "mktemp", "rm", "stat", "tail", "grep"]) symlinkSync(Bun.which(tool)!, join(path, tool));
    writeFileSync(join(path, "sudo"), `#!${bash}
set -eu
printf '%s\\0' "$@" >> "$SUDO_CALLS"
[[ "$1 $2 $3" == '-u root --' ]] || exit 95
script=\${@: -2:1}
handoff=\${!#}
[[ "$script" == "$TMPDIR/"* && "$(stat -c %a "$script")" == 600 ]] || exit 97
[[ "$handoff" == "$TMPDIR/"* && "$(stat -c %a "$handoff")" == 600 ]] || exit 98
[[ $(<"$handoff") == "$EXPECTED_TOKEN" ]] || exit 99
grep -q '^hub_url=https://hub.example version=v1.2.3 repository=kuenobaikbanget/opspilot$' "$script" || exit 101
[[ "$(tail -n 1 "$script")" == 'main "$@"' ]] || exit 103
printf 'sudo: permission denied\\n' >&2
exit 1
`, { mode: 0o755 });
    const shellCmd = mode === "absolute-bash"
      ? `exec ${JSON.stringify(bash)} -s -- --token "$0" < "$1"`
      : 'exec bash -s -- --token "$0" < "$1"';
    const result = Bun.spawnSync([bash, "-c", shellCmd, token, piped], {
      cwd: workDir,
      env: { PATH: path, TMPDIR: scratch, SUDO_CALLS: recorded, EXPECTED_TOKEN: token },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    expect(result.exitCode).toBe(1);
    const error = result.stderr.toString();
    expect(error).toContain("sudo: permission denied");
    expect(error).not.toContain("decoy-executed");
    expect(error).not.toContain(token);
    const calls = readFileSync(recorded, "utf8").split("\0");
    expect(calls).not.toContain(bash);
    expect(calls).not.toContain(decoyBash);
    expect(calls).not.toContain(piped);
    expect(calls.join(" ")).not.toContain(token);
    expect(result.stdout.toString()).toBe("");
    expect(readdirSync(scratch)).toEqual([]);
  });
});
