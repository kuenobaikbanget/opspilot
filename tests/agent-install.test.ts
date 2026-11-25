import { describe, expect, test } from "bun:test";
import { loadHttpsAgentInstaller, readAgentInstallConfig } from "../apps/hub/src/agent-install";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentInstallCommand } from "../apps/web/lib/agent-install";
import type { AgentInstallConfig } from "@opspilot/contracts";

const repoRoot = new URL("../", import.meta.url).pathname;
const tlsFixture = (name: string) => new URL(`fixtures/provider-tls/${name}`, import.meta.url).pathname;

const loopbackSettings = {
  NODE_ENV: "development",
  OPSPILOT_DEV_LOOPBACK_INSTALL: "true",
  OPSPILOT_PUBLIC_HUB_URL: "http://127.0.0.1:4321/",
  OPSPILOT_AGENT_VERSION: "v0.1.0-rc.2",
};
const loopbackConfig = readAgentInstallConfig(loopbackSettings, 4321)!;

const settings = { OPSPILOT_PUBLIC_HUB_URL: "https://hub.example:443/", OPSPILOT_AGENT_VERSION: "v1.2.3-rc.1" };

describe("agent installation configuration", () => {
  test("canonicalizes explicit settings and defaults to the public repository", () => {
    expect(readAgentInstallConfig(settings)).toEqual({ mode: "https", hubUrl: "https://hub.example", installerUrl: "https://hub.example/api/agents/install.sh", version: "v1.2.3-rc.1", repository: "kuenobaikbanget/opspilot" });
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
    for (const value of ["https://hub.example:0", "https://hub.example%27", "https://hub.example%24", "https://bad_host.example"]) {
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
  test("only enables HTTP with exact opt-in and development environment", () => {
    for (const flag of [undefined, "false", "1", "TRUE", "true "]) {
      expect(readAgentInstallConfig({ ...loopbackSettings, OPSPILOT_DEV_LOOPBACK_INSTALL: flag }, 4321)).toBeNull();
    }
    for (const env of [undefined, "test", "production", "Development", "development "]) {
      expect(readAgentInstallConfig({ ...loopbackSettings, NODE_ENV: env }, 4321)).toBeNull();
    }
    expect(readAgentInstallConfig({ ...loopbackSettings, ...settings }, 4321)).toEqual(readAgentInstallConfig(settings));
    expect(readAgentInstallConfig({ ...loopbackSettings, OPSPILOT_AGENT_VERSION: "latest" }, 4321)).toBeNull();
    expect(readAgentInstallConfig({ ...loopbackSettings, OPSPILOT_AGENT_REPOSITORY: "https://other.example/owner/repo" }, 4321)).toBeNull();
  });
  test("requires the literal IPv4 loopback origin and actual Hub port", () => {
    expect(loopbackConfig).toEqual({
      mode: "loopback-development", hubUrl: "http://127.0.0.1:4321", version: "v0.1.0-rc.2", repository: "kuenobaikbanget/opspilot",
    });
    expect(readAgentInstallConfig(loopbackSettings, 4322)).toBeNull();
    expect(readAgentInstallConfig(loopbackSettings)).toBeNull();
    const defaultPort = { ...loopbackSettings, OPSPILOT_PUBLIC_HUB_URL: "http://127.0.0.1/" };
    expect(readAgentInstallConfig(defaultPort, 4321)).toBeNull();
    expect(readAgentInstallConfig(defaultPort, 80)?.hubUrl).toBe("http://127.0.0.1");
    expect(readAgentInstallConfig({ ...loopbackSettings, OPSPILOT_PUBLIC_HUB_URL: "http://127.0.0.1:65535" }, 65535)?.hubUrl).toBe("http://127.0.0.1:65535");
    for (const raw of [
      "http://localhost:4321", "http://127.1:4321", "http://127.0.0.2:4321",
      "http://2130706433:4321", "http://0177.0.0.1:4321", "http://0x7f000001:4321",
      "http://%31%32%37.0.0.1:4321", "http://127.0.0.1.:4321", "http://[::1]:4321",
      "http://192.168.1.4:4321", "http://100.64.0.1:4321", "http://8.8.8.8:4321",
      "HTTP://127.0.0.1:4321", "http://user@127.0.0.1:4321", "http://127.0.0.1:4321\\a",
      "http://127.0.0.1:4321/.", "http://127.0.0.1:4321//", "http://127.0.0.1:4321?",
      "http://127.0.0.1:4321/#", "http://127.0.0.1:4321\n", "http://127.0.0.1:04321",
      "http://127.0.0.1:+4321", "http://127.0.0.1:4321.0", "http://127.0.0.1:0x10e1",
      "http://127.0.0.1:", "http://127.0.0.1:0", "http://127.0.0.1:65536",
    ]) expect(readAgentInstallConfig({ ...loopbackSettings, OPSPILOT_PUBLIC_HUB_URL: raw }, 4321)).toBeNull();
  });
});

describe("generated command preserves literal arguments", () => {
  test("pipes the configured HTTPS installer to Bash and passes only the literal token", () => {
    const dir = mkdtempSync(join(tmpdir(), "opspilot-command-"));
    try {
      const marker = join(dir, "injected");
      const malicious = `'; touch ${marker}; # $(touch ${marker})\n`;
      const config: AgentInstallConfig = {
        mode: "https",
        hubUrl: `https://hub.example/${malicious}`,
        installerUrl: `https://hub.example/api/agents/install.sh${malicious}`,
        version: `v1.2.3-${malicious}`,
        repository: `owner/repo${malicious}`,
      };
      writeFileSync(join(dir, "sudo"), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      writeFileSync(join(dir, "curl"), `#!/bin/sh
printf '%s\\0' "$@" > "$CURL_ARGS"
cat <<'SCRIPT'
printf '%s\\0' "$@" > "$ARGS_CAPTURE"
SCRIPT
`, { mode: 0o755 });
      const env = { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: dir, CURL_ARGS: join(dir, "curl-args"), ARGS_CAPTURE: join(dir, "args") };
      const result = Bun.spawnSync([Bun.which("bash")!, "-c", buildAgentInstallCommand(config, malicious)], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      const curlArgs = readFileSync(env.CURL_ARGS, "utf8").split("\0").slice(0, -1);
      expect(curlArgs).toEqual(["-q", "-fsSL", "--proto", "=https", "--connect-timeout", "10", "-m", "120", config.installerUrl]);
      expect(readFileSync(env.ARGS_CAPTURE, "utf8").split("\0").slice(0, -1)).toEqual(["--token", malicious]);
      expect(existsSync(marker)).toBe(false);
      const httpsConfig = readAgentInstallConfig(settings)!;
      const command = buildAgentInstallCommand(httpsConfig, "t".repeat(43));
      expect(command).toBe(`curl -q -fsSL --proto '=https' --connect-timeout 10 -m 120 'https://hub.example/api/agents/install.sh' | bash -s -- --token '${"t".repeat(43)}'`);
      expect(command).not.toMatch(/[\r\n]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("real curl refuses partial TLS transfers, HTTP URLs, and TLS downgrades", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opspilot-command-failure-"));
    const runDir = join(dir, "run");
    const bin = join(dir, "bin");
    const executed = join(dir, "executed");
    let body = "";
    let httpRequests = 0;
    let tlsRequests = 0;
    const http = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { httpRequests++; return new Response("unexpected"); },
    });
    const tls = createServer({ key: readFileSync(tlsFixture("server-key.pem")), cert: readFileSync(tlsFixture("server.pem")) }, (req, res) => {
      tlsRequests++;
      if (req.url === "/downgrade") {
        res.writeHead(302, { Location: http.url.href }).end();
      } else {
        res.writeHead(200, { "Content-Length": body.length + 100, Connection: "close" }).end(body);
      }
    });
    try {
      await once(tls.listen(0, "127.0.0.1"), "listening");
      const address = tls.address();
      if (!address || typeof address === "string") throw new Error("TLS fixture did not bind");
      const { port } = address;
      const config = readAgentInstallConfig({ ...settings, OPSPILOT_PUBLIC_HUB_URL: `https://provider.example:${port}` });
      if (config?.mode !== "https") throw new Error("Fixture requires HTTPS installation metadata");
      const configured = await loadHttpsAgentInstaller(config);
      if (!configured) throw new Error("Fixture could not load the configured installer");
      // A truncated stream must fail as a syntax error before any main() step runs.
      const cut = configured.indexOf("main() {") + 400;
      const truncated = configured.slice(0, cut);
      // The final `main "$@"` invocation lies beyond the truncation point, so Bash hits EOF mid-function.
      expect(configured.slice(cut)).toContain('main "$@"');
      body = truncated;
      mkdirSync(runDir);
      mkdirSync(bin);
      writeFileSync(join(dir, ".curlrc"), 'proto-redir = "=http,https"\n');
      writeFileSync(join(bin, "uname"), `#!/bin/sh\ntouch ${JSON.stringify(executed)}\necho Linux\n`, { mode: 0o755 });
      writeFileSync(join(dir, "curl"), `#!/bin/bash
exec ${JSON.stringify(Bun.which("curl"))} "$@" --cacert ${JSON.stringify(tlsFixture("ca.pem"))} \\
  --resolve provider.example:${port}:127.0.0.1
`, { mode: 0o755 });
      for (const [installerUrl, exitCode, errors] of [
        [config.installerUrl, 2, [/curl: \(18\)/, /syntax error|unexpected end of file/]],
        [http.url.href, 1, [/protocol.*http.*disabled/i]],
        [`${config.hubUrl}/downgrade`, 1, [/protocol.*http.*disabled/i]],
      ] as const) {
        const command = buildAgentInstallCommand({ ...config, installerUrl }, "a".repeat(43));
        expect(command).not.toMatch(/[\r\n]/);
        // pipefail keeps curl's refusal visible even though Bash exits before running anything.
        const result = Bun.spawn(["bash", "-c", `set -o pipefail\n${command}`], {
          env: { PATH: `${bin}:${dir}:/usr/bin:/bin`, HOME: dir, TMPDIR: runDir },
          stdout: "pipe", stderr: "pipe", timeout: 5000,
        });
        const stderr = await new Response(result.stderr).text();
        for (const error of errors) expect(stderr).toMatch(error);
        expect(await result.exited).toBe(exitCode);
        expect(existsSync(executed)).toBe(false);
        expect(readdirSync(runDir)).toEqual([]);
      }
      expect(tlsRequests).toBe(2);
      expect(httpRequests).toBe(0);
    } finally {
      tls.close();
      http.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(["HUP", "INT", "TERM"])("stops before executing anything when the stream is interrupted by SIG%s", (signal) => {
    const dir = mkdtempSync(join(tmpdir(), "opspilot-command-signal-"));
    const runDir = join(dir, "run");
    const executed = join(dir, "executed");
    try {
      mkdirSync(runDir);
      writeFileSync(join(dir, "curl"), `#!/bin/sh
kill -${signal} "$PPID" "$$"
`, { mode: 0o755 });
      writeFileSync(join(dir, "uname"), `#!/bin/sh\ntouch ${JSON.stringify(executed)}\necho Linux\n`, { mode: 0o755 });
      const result = Bun.spawnSync(["bash", "-c", `set -o pipefail\n${buildAgentInstallCommand(readAgentInstallConfig(settings)!, "a".repeat(43))}`], {
        env: { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: runDir },
        stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      expect(result.stdout.toString()).toBe("");
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(executed)).toBe(false);
      expect(readdirSync(runDir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generated loopback command", () => {
  test.each(["root", "invalid-origin", "partial-archive", "partial-manifest", "wrong-hash", "duplicate-hash", "amd64", "arm64"])("%s", (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), "opspilot-loopback-command-"));
    const runDir = join(dir, "run");
    const marker = join(dir, "injected");
    const capture = join(dir, "agent-ran");
    const arch = scenario === "arm64" ? "arm64" : "amd64";
    const archive = `opspilot-agent_0.1.0-rc.2_linux_${arch}.tar.gz`;
    const base = "https://github.com/kuenobaikbanget/opspilot/releases/download/v0.1.0-rc.2";
    const literal = `'; touch ${marker}; # $(touch ${marker})\n`;
    const config = scenario === "invalid-origin" ? { ...loopbackConfig, hubUrl: `http://hub.example/${literal}` } : loopbackConfig;
    try {
      const executable = (name: string, command: string) => writeFileSync(join(dir, name), `#!/bin/bash\n${command}\n`, { mode: 0o700 });
      executable("id", `echo ${scenario === "root" ? "0" : "1000"}`);
      executable("uname", `echo Linux ${arch === "arm64" ? "aarch64" : "x86_64"}`);
      executable("opspilot-agent", `
        [ ! -e "\${OPSPILOT_AGENT_STATE_PATH}" ] && [ ! -e "\${0%/*}/extra" ] || exit 8
        printf '%s\\0' "$OPSPILOT_HUB_URL" "$OPSPILOT_ENROLL_TOKEN" "$OPSPILOT_AGENT_STATE_PATH" "$#" "\${OPSPILOT_ENABLE_DOCKER-unset}" > ${JSON.stringify(capture)}
      `);
      writeFileSync(join(dir, "extra"), "not an executable");
      const packed = Bun.spawnSync(["tar", "-czf", archive, "--", "opspilot-agent", "extra"], { cwd: dir });
      expect(packed.exitCode).toBe(0);
      const hash = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, archive))).digest("hex");
      const valid = `${hash}  ${archive}\n`;
      writeFileSync(join(dir, "SHA256SUMS"), scenario === "duplicate-hash" ? `${valid}${hash} *${archive}\n`
        : scenario === "wrong-hash" ? `${"f".repeat(64)}  ${archive}\n` : valid);
      mkdirSync(runDir);
      executable("curl", `
        set -eu
        [[ "$*" == "-q --fail --silent --show-error --location --proto =https --proto-redir =https --noproxy * --connect-timeout 10 --max-time 120 --output "* ]]
        printf '%s\\n' "\${!#}" >> ${JSON.stringify(join(dir, "calls"))}
        case "\${!#}" in
          '${base}/${archive}') file='${archive}' ;;
          '${base}/SHA256SUMS') file=SHA256SUMS ;;
          *) exit 99 ;;
        esac
        ${scenario === "partial-archive" ? `if [ "$file" = '${archive}' ]; then head -c 18 ${JSON.stringify(join(dir, archive))} > "\${@: -2:1}"; exit 18; fi` : ""}
        cp -- ${JSON.stringify(dir)}/"$file" "\${@: -2:1}"
        ${scenario === "partial-manifest" ? 'if [ "$file" = SHA256SUMS ]; then exit 18; fi' : ""}
      `);
      const result = Bun.spawnSync(["bash", "-c", buildAgentInstallCommand(config, literal)], {
        cwd: repoRoot,
        env: { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: runDir, OPSPILOT_ENABLE_DOCKER: "true" },
        stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      const calls = join(dir, "calls");
      if (scenario === "root") {
        expect(result.stderr.toString()).toContain("non-root");
        expect(existsSync(calls)).toBe(false);
      } else if (scenario === "invalid-origin") {
        expect(result.stderr.toString()).toContain("Expected an HTTP origin on 127.0.0.1");
        expect(existsSync(calls)).toBe(false);
      } else {
        expect(readFileSync(calls, "utf8")).toBe(`${base}/${archive}\n${scenario === "partial-archive" ? "" : `${base}/SHA256SUMS\n`}`);
      }
      if (scenario === "amd64" || scenario === "arm64") {
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
        const invocation = readFileSync(capture, "utf8").split("\0");
        expect(invocation).toEqual([config.hubUrl, literal, expect.stringMatching(/\/run\/[^/]+\/identity\.json$/), "0", "unset", ""]);
      } else {
        expect(result.exitCode).not.toBe(0);
        expect(existsSync(capture)).toBe(false);
      }
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(runDir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("real curl refuses a TLS asset redirect to plain HTTP despite .curlrc", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opspilot-loopback-redirect-"));
    let tlsRequests = 0;
    let httpRequests = 0;
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { httpRequests++; return new Response("unexpected"); } });
    const tls = Bun.serve({
      hostname: "127.0.0.1", port: 0, tls: { key: Bun.file(tlsFixture("server-key.pem")), cert: Bun.file(tlsFixture("server.pem")) },
      fetch(req) { tlsRequests++; return Response.redirect(`${http.url.origin}${new URL(req.url).pathname}`); },
    });
    try {
      writeFileSync(join(dir, ".curlrc"), 'proto-redir = "=http,https"\n');
      writeFileSync(join(dir, "id"), "#!/bin/bash\necho 1000\n", { mode: 0o700 });
      // Route only the pinned initial URL to the trusted local TLS fixture; keep curl's real policy flags.
      writeFileSync(join(dir, "curl"), `#!/bin/bash
        case "\${!#}" in https://github.com/kuenobaikbanget/opspilot/releases/download/v0.1.0-rc.2/*) ;; *) exit 99 ;; esac
        exec ${JSON.stringify(Bun.which("curl"))} "\${@:1:1}" --cacert ${JSON.stringify(tlsFixture("ca.pem"))} \\
          --resolve provider.example:${tls.port}:127.0.0.1 "\${@:2:$#-2}" "https://provider.example:${tls.port}/archive"
      `, { mode: 0o700 });
      const result = Bun.spawn(["bash", "-c", buildAgentInstallCommand(loopbackConfig, "unused-token")], {
        cwd: repoRoot,
        env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir },
        stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      expect(await new Response(result.stderr).text()).toMatch(/protocol.*http.*disabled/i);
      expect(await result.exited).not.toBe(0);
      expect(tlsRequests).toBe(1);
      expect(httpRequests).toBe(0);
    } finally {
      tls.stop(true);
      http.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
