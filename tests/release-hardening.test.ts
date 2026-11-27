import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const SHA256_RE = /^[a-f0-9]{64}$/;
const SHA1_RE = /^[a-f0-9]{40}$/;

/** Every third-party `uses:` in a workflow must be pinned to a full 40-char commit SHA. */
function actionRefs(workflow: string): string[] {
  const refs: string[] = [];
  for (const line of workflow.split("\n")) {
    const match = /^\s*uses:\s*(\S+)/.exec(line);
    if (match && !match[1].startsWith("./") && !match[1].startsWith("docker://")) refs.push(match[1]);
  }
  return refs;
}

const dockerfiles = readdirSync(join(ROOT, "infra/docker"))
  .filter((name) => name.startsWith("Dockerfile."))
  .map((name) => `infra/docker/${name}`);

test("every Dockerfile FROM image is pinned to an immutable sha256 digest", () => {
  expect(dockerfiles.length).toBeGreaterThanOrEqual(4);
  for (const rel of dockerfiles) {
    const fromLines = read(rel).split("\n").filter((line) => line.startsWith("FROM "));
    expect(fromLines.length).toBeGreaterThanOrEqual(1);
    for (const line of fromLines) {
      const image = line.replace(/^FROM\s+(--platform=\S+\s+)?/i, "").split(/\s+AS\s+/i)[0].trim();
      const digest = (image.split("@")[1] ?? "").replace(/^sha256:/, "");
      expect(digest, `${rel}: ${line}`).toBeDefined();
      expect(SHA256_RE.test(digest ?? ""), `${rel}: digest must be 64 lowercase hex chars, got "${digest}"`).toBe(true);
      // The human-readable tag must be preserved alongside the digest.
      expect(image.includes(":"), `${rel}: keep the human-readable tag before @sha256`).toBe(true);
    }
  }
});

test("compose.yaml service images are pinned to immutable sha256 digests", () => {
  const compose = read("compose.yaml");
  const images = compose.split("\n").filter((line) => /^\s*image:\s*\S/.test(line)).map((line) => line.trim().replace(/^image:\s*/, ""));
  expect(images.length).toBeGreaterThanOrEqual(1);
  for (const image of images) {
    const digest = (image.split("@")[1] ?? "").replace(/^sha256:/, "");
    expect(image.includes("@sha256:"), `compose.yaml image "${image}" must carry @sha256:<digest>`).toBe(true);
    expect(SHA256_RE.test(digest ?? "")).toBe(true);
  }
});

test("release.yml and packages.yml pin every third-party action to a full commit SHA", () => {
  for (const rel of [".github/workflows/release.yml", ".github/workflows/packages.yml", ".github/workflows/checks.yml"]) {
    const refs = actionRefs(read(rel));
    expect(refs.length, `${rel} should use third-party actions`).toBeGreaterThanOrEqual(3);
    for (const ref of refs) {
      const at = ref.lastIndexOf("@");
      expect(at, `${rel}: "${ref}" must be pinned with @<commit>`).toBeGreaterThan(-1);
      const sha = ref.slice(at + 1).split("#")[0].trim();
      expect(SHA1_RE.test(sha), `${rel}: "${ref}" must use a 40-char commit SHA, got "${sha}"`).toBe(true);
    }
  }
});

test("release.yml builds amd64 and arm64, ships SHA256SUMS, signs, attests and generates SBOMs", () => {
  const release = read(".github/workflows/release.yml");
  for (const arch of ["amd64", "arm64"]) {
    expect(release.includes(arch), `release.yml must build linux/${arch}`).toBe(true);
    expect(release.includes(`linux_${arch}`) || release.includes(`linux/${arch}`)).toBe(true);
  }
  expect(release.includes("SHA256SUMS")).toBe(true);
  expect(release.includes("sha256sum")).toBe(true);
  // Sigstore keyless blob signing with verification bundles.
  expect(release.includes("cosign sign-blob")).toBe(true);
  expect(release.includes("--bundle")).toBe(true);
  expect(release.includes("id-token: write")).toBe(true);
  // SBOM generation and attestations.
  expect(/sbom-action@/.test(release)).toBe(true);
  expect(/attest-build-provenance@/.test(release)).toBe(true);
  expect(/attest-sbom@/.test(release)).toBe(true);
  expect(/spdx/i.test(release)).toBe(true);
  // Signatures, bundles and SBOMs are attached to the GitHub Release.
  expect(release.includes("*.sig")).toBe(true);
  expect(release.includes("*.bundle")).toBe(true);
  expect(release.includes("*.spdx.json")).toBe(true);
});

test("packages.yml publishes amd64+arm64, embeds and attests SBOMs", () => {
  const packages = read(".github/workflows/packages.yml");
  expect(packages.includes("linux/amd64,linux/arm64")).toBe(true);
  expect(packages.includes("sbom: true")).toBe(true);
  expect(/sbom-action@/.test(packages)).toBe(true);
  expect(packages.includes("cosign attest")).toBe(true);
  expect(packages.includes("id-token: write")).toBe(true);
});

test("negative: unpinned tags and mutable references are rejected by the same checks", () => {
  // Guard the guards: the regexes used above must actually reject mutable references.
  expect(SHA1_RE.test("v6")).toBe(false);
  expect(SHA1_RE.test("main")).toBe(false);
  expect(SHA1_RE.test("10e90e3645eae34f1e60eeb005ba3a3d33f178e8")).toBe(true);
  expect(SHA256_RE.test("9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895")).toBe(true);
  expect(SHA256_RE.test("latest")).toBe(false);
  const sample = "      uses: docker/build-push-action@v6";
  const ref = /^\s*uses:\s*(\S+)/.exec(sample)?.[1] ?? "";
  const sha = ref.slice(ref.lastIndexOf("@") + 1);
  expect(SHA1_RE.test(sha)).toBe(false);
});
