import { describe, expect, test } from "bun:test";
import { readAgentInstallConfig } from "../apps/hub/src/agent-install";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentInstallCommand } from "../apps/web/lib/agent-install";

const settings = { OPSPILOT_PUBLIC_HUB_URL: "https://hub.example:443/", OPSPILOT_AGENT_VERSION: "v1.2.3-rc.1" };

describe("agent installation configuration", () => {
  test("canonicalizes explicit settings and defaults to the public repository", () => {
    expect(readAgentInstallConfig(settings)).toEqual({ hubUrl: "https://hub.example", installerUrl: "https://hub.example/api/agents/install.sh", version: "v1.2.3-rc.1", repository: "kuenobaikbanget/opspilot" });
    expect(readAgentInstallConfig({ ...settings, OPSPILOT_AGENT_REPOSITORY: "my-org/my.repo" })?.repository).toBe("my-org/my.repo");
  });
  test("never infers installation metadata from internal or browser configuration", () => {
    expect(readAgentInstallConfig({})).toBeNull();
    expect(readAgentInstallConfig({ OPSPILOT_AGENT_VERSION: "v1.2.3", HUB_INTERNAL_URL: "http://hub:3001", ALLOWED_ORIGIN: "https://web.example", HOST: "hub.example", FORWARDED: "host=hub.example" })).toBeNull();
    expect(readAgentInstallConfig({ OPSPILOT_PUBLIC_HUB_URL: "https://hub.example" })).toBeNull();
  });
  test("rejects unsafe or non-origin URLs", () => {
    for (const value of ["http://hub.example", "https://user:pass@hub.example", "https://@hub.example", "https://hub.example/path", "https://hub.example/..", "https://hub.example?", "https://hub.example#", "https://hub.example\\evil", " https://hub.example", "https://hub.example/$(touch /tmp/injected)", "https://hub.example:';exit'"]) {
      expect(readAgentInstallConfig({ ...settings, OPSPILOT_PUBLIC_HUB_URL: value })).toBeNull();
    }
  });
  test("requires pinned workflow-compatible SemVer", () => {
    for (const value of ["latest", "1.2.3", "v01.2.3", "v1.2.3+build", "v1.2.3-01", "v1.2.3-rc..1", "v1.2.3;echo injected", `v1.2.3-${"a".repeat(129)}`]) {
      expect(readAgentInstallConfig({ ...settings, OPSPILOT_AGENT_VERSION: value })).toBeNull();
    }
  });
  test("repository is an owner/name, not an arbitrary download endpoint", () => {
    for (const value of ["https://github.com/a/b", "a/b/c", "a/..", "a/.", "-a/b", "a/b;touch injected", "a/b'$(id)", "a/b\n"]) {
      expect(readAgentInstallConfig({ ...settings, OPSPILOT_AGENT_REPOSITORY: value })).toBeNull();
    }
  });
});

describe("generated command preserves literal arguments", () => {
  for (const uid of ["0", "1000"]) {
    test(`downloads completely and executes safely for UID ${uid}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "opspilot-command-"));
      try {
        const marker = join(dir, "injected");
        const malicious = `'; touch ${marker}; # $(touch ${marker})\n`;
        const config = {
          hubUrl: `https://hub.example/${malicious}`,
          installerUrl: `https://hub.example/install.sh?${malicious}`,
          version: `v1.2.3-${malicious}`,
          repository: `owner/repo${malicious}`,
        };
        writeFileSync(join(dir, "id"), `#!/bin/sh\nprintf '%s\\n' '${uid}'\n`, { mode: 0o755 });
        writeFileSync(join(dir, "sudo"), '#!/bin/sh\nprintf used > "$SUDO_USED"\nexec "$@"\n', { mode: 0o755 });
        writeFileSync(join(dir, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
 if [ "$1" = --output ]; then shift; file=$1; fi
 last=$1; shift
done
printf "%s" "$last" > "$URL_CAPTURE"
printf "%s" "$file" > "$FILE_CAPTURE"
cat > "$file" <<'SCRIPT'
#!/bin/bash
printf '%s\\0' "$@" > "$ARGS_CAPTURE"
SCRIPT
`, { mode: 0o755 });
        const env = {
          PATH: `${dir}:/usr/bin:/bin`,
          SUDO_USED: join(dir, "sudo-used"), URL_CAPTURE: join(dir, "url"),
          FILE_CAPTURE: join(dir, "file"), ARGS_CAPTURE: join(dir, "args"),
        };
        const result = Bun.spawnSync([Bun.which("bash")!, "-c", buildAgentInstallCommand(config, malicious)], { env, stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode).toBe(0);
        expect(readFileSync(env.URL_CAPTURE, "utf8")).toBe(config.installerUrl);
        expect(readFileSync(env.ARGS_CAPTURE, "utf8").split("\0").slice(0, -1)).toEqual([
          "--hub-url", config.hubUrl, "--version", config.version, "--repository", config.repository, "--token", malicious,
        ]);
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(readFileSync(env.FILE_CAPTURE, "utf8"))).toBe(false);
        expect(existsSync(env.SUDO_USED)).toBe(uid !== "0");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  test("failed downloads never execute the partial script and remove the temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "opspilot-command-failure-"));
    try {
      writeFileSync(join(dir, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
 if [ "$1" = --output ]; then shift; file=$1; fi
 shift
done
printf "%s" "$file" > "$FILE_CAPTURE"
echo 'touch "$EXECUTED"' > "$file"
exit 22
`, { mode: 0o755 });
      const config = readAgentInstallConfig(settings)!;
      const capture = join(dir, "file");
      const executed = join(dir, "executed");
      const result = Bun.spawnSync([Bun.which("bash")!, "-c", buildAgentInstallCommand(config, "a".repeat(43))], { env: { PATH: `${dir}:/usr/bin:/bin`, FILE_CAPTURE: capture, EXECUTED: executed } });
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(executed)).toBe(false);
      expect(existsSync(readFileSync(capture, "utf8"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
