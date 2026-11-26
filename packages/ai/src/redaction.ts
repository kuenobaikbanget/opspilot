/**
 * Regex-based first-line secret redaction. Shared by the diagnosis pipeline and
 * the embedding pipeline so no outbound request ever carries obvious credentials.
 * This is NOT a complete secret scanner (see docs/SECURITY.md release blockers).
 */

/** Redacts common credential patterns (Bearer/Basic tokens, key=value secrets, AWS keys, GitHub tokens, PEM blocks, URL userinfo, JWTs) from text. */
export function redact(text: string): string {
  return text
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic|digest|token)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:password|api[_-]?key|token|secret|passwd|pwd)\s*[:=]\s*["']?)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s@]+)@/gi, "$1[REDACTED]:[REDACTED]@");
}
