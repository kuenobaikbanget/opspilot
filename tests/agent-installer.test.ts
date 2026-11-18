import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../infra/install/agent.sh", import.meta.url).pathname;
const token = "a".repeat(43);
const valid = ["--hub-url", "https://hub.example", "--version", "v1.2.3", "--repository", "owner/repo", "--token", token];
const bash = Bun.which("bash")!;
const fixture = mkdtempSync(join(tmpdir(), "opspilot-installer-negative-"));
writeFileSync(join(fixture, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo unsupported-fixture-architecture ;; esac\n', { mode: 0o755 });
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function reject(args: string[], error: string) {
  // The isolated PATH always blocks a valid invocation at architecture preflight.
  // No test can download or mutate workstation installation paths.
  const result = Bun.spawnSync([bash, script, ...args], { env: { PATH: fixture }, stdout: "pipe", stderr: "pipe" });
  const output = result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(output).toContain(error);
  expect(output).not.toContain(token);
  expect(result.stdout.toString()).toBe("");
}

describe("installer refuses invalid input before mutation", () => {
  test("requires every explicit argument", () => {
    reject([], "Usage:");
    reject(valid.slice(0, -1), "Missing argument value");
    reject(["--hub-url", "--version"], "Missing argument value");
  });
  test("rejects unknown and duplicate arguments", () => {
    reject([...valid, "--force", "yes"], "Unknown argument");
    for (const flag of ["--hub-url", "--version", "--repository", "--token"]) reject([...valid, flag, "duplicate"], `Duplicate ${flag}`);
  });
  test("requires an HTTPS origin without userinfo or URL suffixes", () => {
    for (const url of ["http://hub.example", "https://user:pass@hub.example", "https://hub.example/path", "https://hub.example?query", "https://hub.example#fragment", "https://hub.example/$(id)", "https://hub.example:'bad'", "https://hub.example\n"]) reject(["--hub-url", url, ...valid.slice(2)], "Hub URL must be an HTTPS origin");
    reject(["--hub-url", "https://hub.example:99999", ...valid.slice(2)], "Hub URL has an invalid port");
  });
  test("requires a pinned workflow-compatible release", () => {
    for (const version of ["latest", "v01.2.3", "v1.2.3+build", "v1.2.3;id", "v1.2.3-rc..1"]) reject([...valid.slice(0, 3), version, ...valid.slice(4)], "Version must be a pinned");
    reject([...valid.slice(0, 3), "v1.2.3-01", ...valid.slice(4)], "leading zeroes");
  });
  test("repository and token cannot contain shell syntax", () => {
    for (const repository of ["https://github.com/a/b", "a/b/c", "a/..", "a/b'$(id)", "a/b;id"]) reject([...valid.slice(0, 5), repository, ...valid.slice(6)], "Repository must be a GitHub");
    for (const value of ["short", "x".repeat(44), "x".repeat(42) + ";", "'$(id)'"]) reject([...valid.slice(0, 7), value], "Token must be a 43-character");
  });
  test("unsupported architecture cannot progress even with valid inputs", () => reject(valid, "Unsupported architecture"));
});
