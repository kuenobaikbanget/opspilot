import { beforeAll, expect, test } from "bun:test";

// auth.ts validates SESSION_SECRET at import time and db.ts requires DATABASE_URL;
// both are inert for the pure functions exercised here.
process.env.SESSION_SECRET = "opspilot-auth-hardening-unit-session-secret";
process.env.DATABASE_URL = "postgres://opspilot:opspilot@127.0.0.1:5433/opspilot";
process.env.NODE_ENV = "test";
delete process.env.DISABLE_AUTH;

const { RateLimiter, rateLimitKey, resolveClientIp } = await import("../apps/hub/src/ratelimit");
const auth = await import("../apps/hub/src/auth");
const { hashSecret } = await import("../apps/hub/src/db");

beforeAll(() => {
  expect(auth.isAuthDisabled()).toBe(false);
});

test("RateLimiter allows up to max hits then rejects with retryAfterSeconds", () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({ windowMs: 60_000, max: 3 }, () => now);
  expect(limiter.hit("k").allowed).toBe(true);
  expect(limiter.hit("k").allowed).toBe(true);
  const third = limiter.hit("k");
  expect(third.allowed).toBe(true);
  expect(third.remaining).toBe(0);
  const fourth = limiter.hit("k");
  expect(fourth.allowed).toBe(false);
  expect(fourth.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  expect(fourth.retryAfterSeconds).toBeLessThanOrEqual(60);
  // Keys are independent.
  expect(limiter.hit("other").allowed).toBe(true);
  // After the window slides past the oldest hit, the key recovers.
  now += 61_000;
  expect(limiter.hit("k").allowed).toBe(true);
});

test("RateLimiter validates its configuration", () => {
  expect(() => new RateLimiter({ windowMs: 0, max: 1 })).toThrow();
  expect(() => new RateLimiter({ windowMs: 1000, max: 0 })).toThrow();
});

test("rateLimitKey ignores X-Forwarded-For unless remoteAddress is a trusted proxy", () => {
  const req = new Request("http://hub/api/auth/login", {
    headers: { "x-forwarded-for": "198.51.100.42", "x-real-ip": "198.51.100.99" },
  });
  // Unset TRUSTED_PROXY_IPS -> header cannot be spoofed.
  expect(rateLimitKey(req, "login", { remoteAddress: "203.0.113.5" }, "")).toBe("login:203.0.113.5");
  // Untrusted peer even when TRUSTED_PROXY_IPS is set -> header still ignored.
  expect(rateLimitKey(req, "login", { remoteAddress: "203.0.113.5" }, "127.0.0.1,172.16.0.0/12")).toBe("login:203.0.113.5");
});

test("resolveClientIp walks X-Forwarded-For right-to-left across trusted proxies and normalizes IPv4-mapped IPv6", () => {
  const req = new Request("http://hub/api/auth/login", {
    headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.77, 172.18.0.3" },
  });
  // Both 172.18.0.2 (socket, IPv4-mapped) and 172.18.0.3 (proxy hop) are trusted;
  // 203.0.113.77 is the nearest untrusted client IP (ignoring spoofed 198.51.100.1).
  expect(
    resolveClientIp(req, { remoteAddress: "::ffff:172.18.0.2" }, "127.0.0.1, 172.16.0.0/12"),
  ).toBe("203.0.113.77");

  // Falls back to X-Real-IP when X-Forwarded-For is absent, and ignores invalid values.
  const realIpReq = new Request("http://hub/api/agents/enroll", { headers: { "x-real-ip": "198.51.100.10" } });
  expect(resolveClientIp(realIpReq, { remoteAddress: "127.0.0.1" }, "127.0.0.1")).toBe("198.51.100.10");

  const garbageReq = new Request("http://hub/api/agents/enroll", { headers: { "x-forwarded-for": "not-an-ip" } });
  expect(resolveClientIp(garbageReq, { remoteAddress: "127.0.0.1" }, "127.0.0.1")).toBe("127.0.0.1");
});

test("session token roundtrip verifies and carries jti/exp", () => {
  const now = Date.now();
  const session = auth.createSession(now);
  const payload = auth.verifySession(session.token, now);
  expect(payload).not.toBeNull();
  expect(payload!.sub).toBe("single-admin");
  expect(typeof payload!.jti).toBe("string");
  expect(payload!.exp).toBe(Math.floor(now / 1000) + auth.SESSION_MAX_AGE_SECONDS);
  expect(session.sessionHash).toBe(hashSecret(session.token));
  expect(session.csrfHash).toBe(hashSecret(session.csrfToken));
  expect(session.csrfHash).not.toBe(session.sessionHash);
});

test("session token rejects tampering, wrong shape, and expiry", () => {
  const now = Date.now();
  const session = auth.createSession(now);
  // Flipped signature character.
  const tampered = `${session.token.slice(0, -1)}${session.token.endsWith("a") ? "b" : "a"}`;
  expect(auth.verifySession(tampered, now)).toBeNull();
  // Extra segment.
  expect(auth.verifySession(`${session.token}.extra`, now)).toBeNull();
  // Garbage.
  expect(auth.verifySession("not-a-token", now)).toBeNull();
  expect(auth.verifySession("", now)).toBeNull();
  // Expired relative to the injected clock.
  expect(auth.verifySession(session.token, now + (auth.SESSION_MAX_AGE_SECONDS + 1) * 1000)).toBeNull();
  // Distinct sessions get distinct tokens.
  expect(auth.createSession(now).token).not.toBe(session.token);
});

test("checkCsrfToken accepts only the session-bound token in constant time", () => {
  const session = auth.createSession();
  const admin = { sessionHash: session.sessionHash, csrfHash: session.csrfHash, jti: "jti" };
  const req = (token: string | null) =>
    new Request("http://hub/api/x", {
      method: "POST",
      headers: token === null ? {} : { [auth.CSRF_HEADER]: token },
    });
  expect(auth.checkCsrfToken(req(session.csrfToken), admin)).toBe(true);
  expect(auth.checkCsrfToken(req(null), admin)).toBe(false);
  expect(auth.checkCsrfToken(req("wrong-token"), admin)).toBe(false);
  expect(auth.checkCsrfToken(req(session.csrfToken.slice(0, -1)), admin)).toBe(false);
  expect(auth.checkCsrfToken(req("x".repeat(300)), admin)).toBe(false);
  // A token bound to a different session must not validate.
  const other = auth.createSession();
  expect(auth.checkCsrfToken(req(other.csrfToken), admin)).toBe(false);
});

test("sessionTokenFromRequest parses the opspilot_session cookie only", () => {
  const session = auth.createSession();
  const req = new Request("http://hub/", {
    headers: { cookie: `other=1; ${auth.CSRF_COOKIE}=abc; opspilot_session=${session.token}; more=2` },
  });
  expect(auth.sessionTokenFromRequest(req)).toBe(session.token);
  expect(auth.sessionTokenFromRequest(new Request("http://hub/"))).toBeNull();
  expect(auth.sessionTokenFromRequest(new Request("http://hub/", { headers: { cookie: "opspilot_session=" } }))).toBeNull();
});

test("csrf cookie helpers carry the double-submit token and clear it", () => {
  expect(auth.csrfCookie("tok123")).toContain("opspilot_csrf=tok123");
  expect(auth.csrfCookie("tok123")).toContain("SameSite=Strict");
  expect(auth.csrfCookie("tok123")).not.toContain("HttpOnly");
  expect(auth.clearCsrfCookie()).toContain("opspilot_csrf=;");
  expect(auth.clearCsrfCookie()).toContain("Max-Age=0");
  expect(auth.sessionCookie("abc")).toContain("HttpOnly");
  expect(auth.logoutCookie()).toContain("Max-Age=0");
});
