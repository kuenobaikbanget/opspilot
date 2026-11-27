# Security Policy

## Supported Versions

OpsPilot is an early-stage, self-hosted project. Security fixes are applied to the
latest release on `main` and published as new `v*` tags.

| Version | Supported |
|---|---|
| Latest `v*` release | Yes |
| Older releases | No — upgrade to the latest tag |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting for this repository
(**Security → Advisories → Report a vulnerability**), or contact the maintainers
through a private channel if listed in the repository profile.

Please include, when available:

- A description of the issue and its security impact.
- Reproduction steps, proof-of-concept, or affected commit/tag.
- Affected components (Hub, Web, Worker, Go agent, installer, workflows).
- Whether secrets, credentials, or host data are exposed.

### Coordinated disclosure & response SLA

- **Acknowledgement:** within 3 business days.
- **Initial assessment / triage:** within 7 business days, including whether the
  report is in scope and a preliminary severity.
- **Fix or mitigation:** targeted within 30 days for high/critical issues; lower
  severities are scheduled with the next release.
- We will coordinate public disclosure timing with you. Credit is given in the
  release notes unless you prefer to remain anonymous.

### Scope

In scope: the Hub API, Web dashboard, Worker, Go agent and installer, the agent
WebSocket protocol, authentication/enrollment, workflow release pipeline, and
container images published from this repository.

Out of scope: vulnerabilities in third-party dependencies already publicly
disclosed upstream (report them upstream), issues in self-hosted infrastructure
you operate, and denial-of-service via resource exhaustion of your own deployment.

## Verifying Signed Releases and SBOMs

Every `v*` GitHub Release ships `linux_amd64` and `linux_arm64` agent archives
with:

- `SHA256SUMS` — SHA-256 checksum manifest for both archives.
- `<archive>.sig` / `<archive>.pem` / `<archive>.bundle` — Sigstore **keyless**
  detached signatures (Fulcio certificate + Rekor transparency-log bundle).
- `<archive>.spdx.json` — SPDX SBOM for the archive.
- GitHub **build-provenance** and **SBOM attestations** on the release assets and
  on the GHCR container images (`hub`, `worker`, `web`, `agent`).

### 1. Verify checksums

```bash
sha256sum -c SHA256SUMS
```

### 2. Verify the keyless cosign signature

```bash
cosign verify-blob \
  --certificate-identity-regexp '^https://github.com/<owner>/<repo>/\\.github/workflows/release\\.yml@' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  --bundle opspilot-agent_<version>_linux_amd64.tar.gz.bundle \
  --signature opspilot-agent_<version>_linux_amd64.tar.gz.sig \
  opspilot-agent_<version>_linux_amd64.tar.gz
```

(Adjust the identity regexp to this repository's workflow path.)

### 3. Verify the release attestations (provenance + SBOM)

```bash
gh attestation verify opspilot-agent_<version>_linux_amd64.tar.gz \
  --repo <owner>/<repo> --format json
```

### 4. Verify container image SBOM/provenance attestations

```bash
cosign verify-attestation ghcr.io/<owner>/opspilot-hub:<version> \
  --certificate-identity-regexp '^https://github.com/<owner>/<repo>/\\.github/workflows/packages\\.yml@' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

Container base images in `infra/docker/Dockerfile.*` and `compose.yaml` are
pinned to immutable `@sha256:` digests; pull by digest rather than by mutable tag
in production:

```bash
docker pull ghcr.io/<owner>/opspilot-hub@sha256:<digest>
```

## Security documentation

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model, hardening
checklist and release verification instructions, and
[docs/TESTING.md](docs/TESTING.md) for the test and load/chaos verification plan.
