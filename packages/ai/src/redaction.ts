/**
 * Deterministic, composable, multi-layer redaction pipeline shared by the diagnosis
 * pipeline, the evidence-ingestion path and the embedding pipeline, so no stored row
 * and no outbound LLM request ever carries obvious credentials.
 *
 * Every layer replaces matches with a fixed placeholder and only ever records a
 * per-category COUNT in the structured {@link RedactionSummary} — raw matched values
 * are never logged, stored or returned.
 *
 * This is first-line defense, not a complete secret scanner (see docs/SECURITY.md
 * release blockers): it covers well-known token shapes and is regex-based by design.
 */

export type RedactionCategory =
  | "private_key"
  | "authorization_header"
  | "cookie_header"
  | "connection_url_credentials"
  | "jwt"
  | "aws_access_key"
  | "github_token"
  | "slack_token"
  | "stripe_key"
  | "api_key"
  | "secret_assignment"
  | "email"
  | "ip_address";

export const REDACTION_CATEGORIES: readonly RedactionCategory[] = [
  "private_key",
  "authorization_header",
  "cookie_header",
  "connection_url_credentials",
  "jwt",
  "aws_access_key",
  "github_token",
  "slack_token",
  "stripe_key",
  "api_key",
  "secret_assignment",
  "email",
  "ip_address",
];

/** Per-category match counts plus a total; never contains raw matched values. */
export type RedactionSummary = {
  total: number;
  byCategory: Record<RedactionCategory, number>;
};

export type RedactionOptions = {
  /** Opt-in PII redaction of email addresses. */
  redactEmail?: boolean;
  /** Opt-in PII redaction of IPv4/IPv6 addresses. */
  redactIp?: boolean;
};

export type RedactionResult = {
  text: string;
  summary: RedactionSummary;
};

type Layer = {
  category: RedactionCategory;
  pattern: RegExp;
  /** Replacement string, or a function of the match (never receives raw secrets into output). */
  replacement: string | ((...args: unknown[]) => string);
  /** Whether the layer only runs when the matching option is enabled. */
  pii?: "email" | "ip";
};

const SECRET_KEY_NAME = "(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|session[_-]?token|token)";

/**
 * Ordered redaction layers. Order matters: structured blocks and headers first, then
 * connection URLs (so userinfo is masked before any IP layer), then specific token
 * families, then generic key=value assignments, then opt-in PII.
 */
const LAYERS: Layer[] = [
  {
    category: "private_key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    category: "authorization_header",
    pattern: /(authorization\s*[:=]\s*(?:bearer|basic|digest|token|oauth)\s+)[^\s"']+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    category: "cookie_header",
    pattern: /((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi,
    replacement: "$1[REDACTED_COOKIE]",
  },
  {
    category: "connection_url_credentials",
    pattern: /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]*):([^\s@]+)@/gi,
    replacement: "$1[REDACTED]:[REDACTED]@",
  },
  {
    category: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    category: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  {
    category: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    category: "slack_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  {
    category: "stripe_key",
    pattern: /\b(?:sk_live|sk_test|rk_live|pk_live)_[A-Za-z0-9]{10,}\b/g,
    replacement: "[REDACTED_STRIPE_KEY]",
  },
  {
    category: "api_key",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    category: "secret_assignment",
    pattern: new RegExp(`(${SECRET_KEY_NAME}\\s*[:=]\\s*["']?)[^\\s,;"']+`, "gi"),
    replacement: "$1[REDACTED]",
  },
  {
    category: "email",
    pii: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    category: "ip_address",
    pii: "ip",
    // IPv4 dotted quad, full 8-group IPv6, or compressed IPv6 containing "::".
    // (Deliberately does not match plain times like 12:30:45.)
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b[0-9a-fA-F]{0,4}::[0-9a-fA-F:]*\b/g,
    replacement: "[REDACTED_IP]",
  },
];

/** Empty summary with every category present so the shape is stable for consumers. */
export function emptyRedactionSummary(): RedactionSummary {
  const byCategory = {} as Record<RedactionCategory, number>;
  for (const category of REDACTION_CATEGORIES) byCategory[category] = 0;
  return { total: 0, byCategory };
}

export function mergeRedactionSummaries(...summaries: RedactionSummary[]): RedactionSummary {
  const merged = emptyRedactionSummary();
  for (const summary of summaries) {
    merged.total += summary.total;
    for (const category of REDACTION_CATEGORIES) merged.byCategory[category] += summary.byCategory[category];
  }
  return merged;
}

/**
 * Runs every enabled layer over `text` in order, returning the redacted text plus a
 * structured summary (counts only — never raw matched values).
 */
export function redactText(text: string, options: RedactionOptions = {}): RedactionResult {
  const summary = emptyRedactionSummary();
  let output = text;
  for (const layer of LAYERS) {
    if (layer.pii === "email" && !options.redactEmail) continue;
    if (layer.pii === "ip" && !options.redactIp) continue;
    output = output.replace(layer.pattern, (...args: unknown[]) => {
      summary.byCategory[layer.category] += 1;
      summary.total += 1;
      return typeof layer.replacement === "string"
        ? layer.replacement.replace(/\$(\d+)/g, (_, index) => String(args[Number(index)] ?? ""))
        : (layer.replacement as (...a: unknown[]) => string)(...args);
    });
  }
  return { text: output, summary };
}

/** Object keys whose values are always replaced wholesale, regardless of content shape. */
const SENSITIVE_OBJECT_KEY = new RegExp(`^(${SECRET_KEY_NAME})$`, "i");

/**
 * Recursive structured redaction for JSON-like evidence payloads and prompt inputs:
 * walks objects/arrays, redacts every string, and replaces the whole value of any
 * object key that names a credential. JSON structure (keys, nesting, arrays, non-string
 * scalars) is preserved. Returns the redacted value plus a merged summary.
 */
export function redactValue(value: unknown, options: RedactionOptions = {}): { value: unknown; summary: RedactionSummary } {
  const summaries: RedactionSummary[] = [];
  const walk = (input: unknown, key: string | null): unknown => {
    if (typeof input === "string") {
      const result = redactText(input, options);
      summaries.push(result.summary);
      return result.text;
    }
    if (Array.isArray(input)) return input.map((item) => walk(item, null));
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(input as Record<string, unknown>)) {
        if (typeof childValue === "string" && SENSITIVE_OBJECT_KEY.test(childKey)) {
          // A credential-named key is redacted wholesale even if the value looks benign.
          const summary = emptyRedactionSummary();
          summary.byCategory.secret_assignment = 1;
          summary.total = 1;
          summaries.push(summary);
          out[childKey] = "[REDACTED]";
        } else {
          out[childKey] = walk(childValue, childKey);
        }
      }
      return out;
    }
    return input;
  };
  const redacted = walk(value, null);
  return { value: redacted, summary: mergeRedactionSummaries(...summaries) };
}

/**
 * Backwards-compatible single-shot redaction. Equivalent to `redactText(text).text`
 * with PII layers disabled; prefer {@link redactText} when summary metadata is needed.
 */
export function redact(text: string): string {
  return redactText(text).text;
}
