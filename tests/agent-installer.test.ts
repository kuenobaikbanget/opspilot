import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(result.stderr.toString()).toMatch(/Run this installer as root|Missing dependency: bash/);
  });
});
