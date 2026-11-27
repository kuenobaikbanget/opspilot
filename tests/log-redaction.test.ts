import { expect, test } from "bun:test";
import {
  REDACTION_CATEGORIES,
  emptyRedactionSummary,
  mergeRedactionSummaries,
  redact,
  redactText,
  redactValue,
  type RedactionSummary,
} from "../packages/ai/src/redaction";

// Synthetic fixtures built from parts so secret scanners do not flag test literals.
const OPENAI_KEY = ["sk", "proj", "9f8e7d6c5b4a3210ZY"].join("-");
const ANTHROPIC_KEY = ["sk", "ant", "api03", "9f8e7d6c5b4a3210ABCDEF"].join("-");
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const GITHUB_PAT = ["ghp", "abcdefghijklmnopqrstuvwx1234567890"].join("_");
const GITHUB_FINE_GRAINED = ["github", "pat", "11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
const SLACK_TOKEN = ["xoxb", "123456789012", "abcdefghijkl"].join("-");
const STRIPE_KEY = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const DB_URL = "postgres://svc_user:hunter2secret@db.internal:5432/prod";
const REDIS_URL = "redis://:redispass123@cache.internal:6379/0";
const MONGO_URL = "mongodb+srv://mongoUser:mongoPass99@cluster0.example.mongodb.net/app";
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA7fakefakefakefake", "-----END RSA PRIVATE KEY-----"].join("\n");
const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
const BASIC_B64 = "Basic dXNlcjpwYXNzd29yZA==";
const PASSWORD = "hunter2secret";
const API_KEY_VALUE = "rahasia-12345";

// Patterned secrets that the pipeline must always catch. (Bare random strings without a
// recognizable shape, e.g. a lone "hunter2", are out of scope for a regex first line.)
const ALL_SECRETS = [
  OPENAI_KEY, ANTHROPIC_KEY, AWS_KEY, GITHUB_PAT, GITHUB_FINE_GRAINED, SLACK_TOKEN,
  STRIPE_KEY, JWT, DB_URL, REDIS_URL, MONGO_URL,
];

function expectNoSecrets(text: string, secrets: string[] = ALL_SECRETS) {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

test("systemd/journal log lines are redacted with accurate per-category counts", () => {
  const log = [
    'Jun 01 12:00:01 web-01 app[812]: starting with token="' + API_KEY_VALUE + '"',
    "Jun 01 12:00:02 web-01 app[812]: Authorization: Bearer abcdef123456",
    "Jun 01 12:00:03 web-01 app[812]: db url " + DB_URL,
    "Jun 01 12:00:04 web-01 app[812]: password=" + PASSWORD,
    "Jun 01 12:00:05 web-01 app[812]: healthy on port 8080",
  ].join("\n");
  const { text, summary } = redactText(log);
  expectNoSecrets(text, [API_KEY_VALUE, "abcdef123456", DB_URL, PASSWORD]);
  expect(text).toContain("healthy on port 8080");
  expect(summary.byCategory.secret_assignment).toBe(2); // token="..." and password=...
  expect(summary.byCategory.authorization_header).toBe(1);
  expect(summary.byCategory.connection_url_credentials).toBe(1);
  expect(summary.total).toBe(4);
});

test("nginx/HTTP access logs: authorization and cookie headers are redacted", () => {
  const log = [
    '10.1.2.3 - - [01/Jun/2026:12:00:00 +0000] "GET /api HTTP/1.1" 200 512 "-" "curl/8"',
    "authorization=bearer TokEnVaLue123 header",
    "Cookie: session=abc123session; theme=dark",
    "Set-Cookie: id=xyz789; Path=/; HttpOnly",
  ].join("\n");
  const { text, summary } = redactText(log);
  expect(text).not.toContain("TokEnVaLue123");
  expect(text).not.toContain("abc123session");
  expect(text).not.toContain("xyz789");
  expect(text).toContain("[REDACTED_COOKIE]");
  expect(summary.byCategory.authorization_header).toBe(1);
  expect(summary.byCategory.cookie_header).toBe(2);
  // Non-secret log content survives.
  expect(text).toContain('"GET /api HTTP/1.1" 200 512');
});

test(".env snippets: every secret assignment shape is redacted, comments survive", () => {
  const env = [
    "# app config",
    "DATABASE_URL=" + DB_URL,
    "API_KEY=" + API_KEY_VALUE,
    'PASSWORD="' + PASSWORD + '"',
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "export TOKEN=tok_998877",
    "PLAIN=hello-world",
  ].join("\n");
  const { text, summary } = redactText(env);
  expectNoSecrets(text, [DB_URL, API_KEY_VALUE, PASSWORD, "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "tok_998877"]);
  expect(text).toContain("# app config");
  expect(text).toContain("PLAIN=hello-world");
  expect(summary.byCategory.connection_url_credentials).toBe(1);
  expect(summary.byCategory.secret_assignment).toBe(4);
});

test("stack traces carrying connection URLs and keys are redacted", () => {
  const trace = [
    "Error: connect ECONNREFUSED at " + REDIS_URL,
    "    at connect (node:net:437:16)",
    "caused by auth with " + MONGO_URL + " and key sk-live-" + "a".repeat(20),
  ].join("\n");
  const { text } = redactText(trace);
  expect(text).not.toContain("redispass123");
  expect(text).not.toContain("mongoPass99");
  expect(text).not.toContain("sk-live-");
  expect(text).toContain("at connect (node:net:437:16)");
});

test("all token families: AWS, GitHub, Slack, Stripe, OpenAI, Anthropic, JWT", () => {
  const { text, summary } = redactText(ALL_SECRETS.join("\n"));
  expectNoSecrets(text);
  expect(summary.byCategory.aws_access_key).toBe(1);
  expect(summary.byCategory.github_token).toBe(2);
  expect(summary.byCategory.slack_token).toBe(1);
  expect(summary.byCategory.stripe_key).toBe(1);
  expect(summary.byCategory.api_key).toBe(2); // sk-... and sk-ant-...
  expect(summary.byCategory.jwt).toBe(1);
});

test("PEM private key blocks (any key type) are replaced wholesale", () => {
  for (const label of ["RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PRIVATE KEY"]) {
    const pem = `-----BEGIN ${label}-----\nMIIEpAIBAAKCAQEA7secretmaterial\n-----END ${label}-----`;
    const { text, summary } = redactText(`before\n${pem}\nafter`);
    expect(text).not.toContain("MIIEpAIBAAKCAQEA7secretmaterial");
    expect(text).toContain("[REDACTED_PRIVATE_KEY]");
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect(summary.byCategory.private_key).toBe(1);
  }
  expectNoSecrets(redactText(PEM).text, ["MIIEpAIBAAKCAQEA7fakefakefakefake"]);
});

test("connection URLs with embedded credentials across schemes", () => {
  const cases = [DB_URL, REDIS_URL, MONGO_URL, "mysql://root:toor@127.0.0.1:3306/db", "amqp://guest:guest@mq:5672/"];
  for (const url of cases) {
    const { text, summary } = redactText(`connecting to ${url} now`);
    const credentials = /:\/\/([^:/@]*):([^@]+)@/.exec(url)!;
    if (credentials[1]) expect(text).not.toContain(credentials[1]);
    expect(text).not.toContain(credentials[2]);
    expect(text).toContain("[REDACTED]:[REDACTED]@");
    expect(summary.byCategory.connection_url_credentials).toBe(1);
  }
  // URLs without credentials are untouched.
  expect(redactText("GET https://api.example.com/v1/models").text).toBe("GET https://api.example.com/v1/models");
});

test("authorization header variants: Bearer/Basic/Digest/Token, colon or equals, any case", () => {
  const samples = [
    `Authorization: ${BEARER}`,
    `authorization: basic ${BASIC_B64}`,
    `AUTHORIZATION=digest abcdef`,
    `Authorization:   Token   spaced-token-value`,
  ];
  for (const sample of samples) {
    const { text, summary } = redactText(sample);
    expect(summary.byCategory.authorization_header).toBe(1);
    expect(text).toMatch(/authorization\s*[:=]\s*\w+\s+\[REDACTED\]/i);
  }
  expect(redactText(`Authorization: ${BEARER}`).text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
});

test("opt-in PII redaction: email and IP only when enabled", () => {
  const text = "login from 192.168.10.20 and 2001:db8::1 by admin@example.com at 12:30:45";
  const off = redactText(text);
  expect(off.text).toBe(text);
  expect(off.summary.byCategory.email).toBe(0);
  expect(off.summary.byCategory.ip_address).toBe(0);

  const on = redactText(text, { redactEmail: true, redactIp: true });
  expect(on.text).not.toContain("192.168.10.20");
  expect(on.text).not.toContain("2001:db8::1");
  expect(on.text).not.toContain("admin@example.com");
  expect(on.text).toContain("[REDACTED_IP]");
  expect(on.text).toContain("[REDACTED_EMAIL]");
  // Plain times are not mangled by the IP layer.
  expect(on.text).toContain("12:30:45");
  expect(on.summary.byCategory.email).toBe(1);
  expect(on.summary.byCategory.ip_address).toBe(2);

  const emailOnly = redactText(text, { redactEmail: true });
  expect(emailOnly.text).not.toContain("admin@example.com");
  expect(emailOnly.text).toContain("192.168.10.20");
});

test("redactValue redacts nested JSON payloads without corrupting structure", () => {
  const payload = {
    incident: { title: "nginx down", tags: ["web", "prod"] },
    evidence: [
      { id: "e1", content: `failed auth password=${PASSWORD}` },
      { id: "e2", content: `url ${DB_URL}` },
    ],
    config: { workers: 4, credentials: { api_key: API_KEY_VALUE, nested: { token: "tok123" } }, note: null, ok: true, score: 1.5 },
  };
  const { value, summary } = redactValue(payload);
  const serialized = JSON.stringify(value);
  expectNoSecrets(serialized, [PASSWORD, DB_URL, API_KEY_VALUE, "tok123"]);
  // Structure preserved.
  const out = value as typeof payload;
  expect(out.incident.title).toBe("nginx down");
  expect(out.incident.tags).toEqual(["web", "prod"]);
  expect(out.evidence).toHaveLength(2);
  expect(out.config.workers).toBe(4);
  expect(out.config.note).toBeNull();
  expect(out.config.ok).toBe(true);
  expect(out.config.score).toBe(1.5);
  // Credential-named keys are redacted wholesale.
  expect(out.config.credentials.api_key).toBe("[REDACTED]");
  expect((out.config.credentials.nested as { token: string }).token).toBe("[REDACTED]");
  expect(summary.byCategory.secret_assignment).toBe(3);
  expect(summary.byCategory.connection_url_credentials).toBe(1);
  expect(summary.total).toBe(4);
});

test("redaction summary never contains raw matched values", () => {
  const { summary } = redactText(`password=${PASSWORD} token=${API_KEY_VALUE} ${OPENAI_KEY}`);
  const serialized = JSON.stringify(summary);
  expect(serialized).not.toContain(PASSWORD);
  expect(serialized).not.toContain(API_KEY_VALUE);
  expect(serialized).not.toContain(OPENAI_KEY);
  expect(summary.total).toBe(3);
  expect(Object.keys(summary.byCategory).sort()).toEqual([...REDACTION_CATEGORIES].sort());
});

test("summary helpers: empty shape is stable and merge sums counts", () => {
  const empty = emptyRedactionSummary();
  expect(empty.total).toBe(0);
  expect(Object.keys(empty.byCategory)).toHaveLength(REDACTION_CATEGORIES.length);
  const a: RedactionSummary = { total: 2, byCategory: { ...empty.byCategory, jwt: 1, api_key: 1 } };
  const b: RedactionSummary = { total: 1, byCategory: { ...empty.byCategory, jwt: 1 } };
  const merged = mergeRedactionSummaries(a, b);
  expect(merged.total).toBe(3);
  expect(merged.byCategory.jwt).toBe(2);
  expect(merged.byCategory.api_key).toBe(1);
});

test("backwards-compatible redact() matches previous placeholder behavior", () => {
  expect(redact('password="supersecret123" api_key=\'rahasia\'')).toBe('password="[REDACTED]" api_key=\'[REDACTED]\'');
  expect(redact("token=secret password=abc")).not.toContain("token=secret");
  expect(redact("Authorization: Bearer abc123")).not.toContain("abc123");
  expect(redact("upstream connection refused on port 443")).toBe("upstream connection refused on port 443");
  expect(redact("")).toBe("");
});

test("negative/bypass edge cases: quoting, casing, whitespace and partial tokens", () => {
  // Extra whitespace inside assignments.
  expect(redactText("password   =   spaced-secret").text).not.toContain("spaced-secret");
  // Uppercase key names.
  expect(redactText("PASSWORD=upper-secret").text).not.toContain("upper-secret");
  // Value with punctuation stops at delimiters but the secret part is gone.
  const quoted = redactText(`secret='quoted-secret-value'`).text;
  expect(quoted).not.toContain("quoted-secret-value");
  expect(quoted).toContain("secret='[REDACTED]'");
  // A bare sk- prefix shorter than 16 chars is not treated as a key (avoids false positives).
  expect(redactText("sk-abc").text).toBe("sk-abc");
  // AKIA with wrong length is not an AWS key.
  expect(redactText("AKIA123").text).toBe("AKIA123");
  // Redaction is idempotent in output text.
  const once = redactText(`key ${OPENAI_KEY} url ${DB_URL}`);
  const twice = redactText(once.text);
  expect(twice.text).toBe(once.text);
  // A fully redacted token-only string produces zero further matches.
  const tokenOnly = redactText(`key ${OPENAI_KEY}`);
  expect(redactText(tokenOnly.text).summary.total).toBe(0);
});

test("JSON log strings and IPv6 addresses starting with :: are redacted", () => {
  const jsonLog = '{"user":"ops","password": "rahasia-json","api_key":"tok-999","token":unquoted_tok}';
  const redactedJson = redactText(jsonLog);
  expect(redactedJson.text).not.toContain("rahasia-json");
  expect(redactedJson.text).not.toContain("tok-999");
  expect(redactedJson.text).not.toContain("unquoted_tok");
  expect(redactedJson.text).toContain('"user":"ops"');
  expect(redactedJson.text).toContain('"password": "[REDACTED]"');
  expect(redactedJson.text).toContain('"token":[REDACTED]}');
  expect(redactedJson.summary.byCategory.secret_assignment).toBe(3);

  const ipv6Log = "peer ::1 connected, mapped ::ffff:192.0.2.1, bracketed [::1], link fe80:: at 12:30:45";
  const redactedIp = redactText(ipv6Log, { redactIp: true });
  expect(redactedIp.text).not.toContain("::1");
  expect(redactedIp.text).not.toContain("192.0.2.1");
  expect(redactedIp.text).not.toContain("fe80::");
  expect(redactedIp.text).toContain("12:30:45");
  expect(redactedIp.summary.byCategory.ip_address).toBe(4);
});
