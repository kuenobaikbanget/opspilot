import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { CSRF_COOKIE, CSRF_HEADER } from "@opspilot/contracts";
import { db, hashSecret } from "./db";

export { CSRF_COOKIE, CSRF_HEADER };

/** Returns true only in non-production when `DISABLE_AUTH=true`; throws if enabled in production. */
export function isAuthDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const disabled = env.DISABLE_AUTH === "true";
  if (env.NODE_ENV === "production" && disabled) {
    throw new Error("DISABLE_AUTH cannot be enabled in production");
  }
  return env.NODE_ENV !== "production" && disabled;
}

const secret = process.env.SESSION_SECRET || "";
if (!isAuthDisabled() && secret.length < 32) {
  throw new Error("SESSION_SECRET must have >= 32 chars");
}

const cookieName = "opspilot_session";

const sign = (payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
};

/** Absolute session lifetime; the token exp claim mirrors this but the DB enforces it. */
export const SESSION_MAX_AGE_SECONDS = envInt("SESSION_MAX_AGE_SECONDS", 8 * 3600, 60, 30 * 86_400);
/** Idle timeout enforced server-side via sessions.last_seen_at. */
export const SESSION_IDLE_TIMEOUT_SECONDS = envInt("SESSION_IDLE_TIMEOUT_SECONDS", 3600, 60, 30 * 86_400);

export type SessionTokenPayload = {
  sub: "single-admin";
  jti: string;
  iat: number;
  exp: number;
};

export type IssuedSession = {
  token: string;
  csrfToken: string;
  sessionHash: string;
  csrfHash: string;
  expiresAt: Date;
};

/** Creates a signed single-admin session token and its session-bound CSRF token. */
export function createSession(now = Date.now()): IssuedSession {
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must have >= 32 chars");
  }
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: "single-admin",
      jti: randomUUID(),
      iat,
      exp: iat + SESSION_MAX_AGE_SECONDS,
    } satisfies SessionTokenPayload),
  ).toString("base64url");
  const token = `${payload}.${sign(payload)}`;
  const csrfToken = randomUUID() + randomUUID().replaceAll("-", "");
  return {
    token,
    csrfToken,
    sessionHash: hashSecret(token),
    csrfHash: hashSecret(csrfToken),
    expiresAt: new Date((iat + SESSION_MAX_AGE_SECONDS) * 1000),
  };
}

/** Verifies only the HMAC signature and exp claim of a session token (pure, no DB). */
export function verifySession(token: string, now = Date.now()): SessionTokenPayload | null {
  if (secret.length < 32) {
    return null;
  }
  const [payload, signature, ...extra] = token.split(".");
  if (!payload || !signature || extra.length) {
    return null;
  }

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (
      data.sub !== "single-admin" ||
      typeof data.exp !== "number" ||
      typeof data.jti !== "string" ||
      data.exp <= Math.floor(now / 1000)
    ) {
      return null;
    }
    return data as SessionTokenPayload;
  } catch {
    return null;
  }
}

/** Extracts the raw session token from the request cookie header. */
export function sessionTokenFromRequest(req: Request): string | null {
  const raw = req.headers.get("cookie") || "";
  const token = raw
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return token || null;
}

export type AdminSession = {
  sessionHash: string;
  csrfHash: string;
  jti: string;
};

type SessionRow = {
  id: string;
  session_hash: string;
  csrf_hash: string;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};

// Throttle last_seen_at writes: at most one UPDATE per session per 30s.
const lastSeenTouch = new Map<string, number>();

/**
 * Full server-side session validation: HMAC + exp, then the PostgreSQL row must
 * exist, be unrevoked, be within the absolute expiry, and be within the idle
 * timeout. A replayed cookie after logout/revocation/expiry is rejected here.
 */
export async function authenticateRequest(
  req: Request,
  now = Date.now(),
): Promise<AdminSession | null> {
  if (isAuthDisabled()) {
    return { sessionHash: "auth-disabled", csrfHash: "auth-disabled", jti: "auth-disabled" };
  }
  const token = sessionTokenFromRequest(req);
  if (!token) return null;
  const payload = verifySession(token, now);
  if (!payload) return null;

  const sessionHash = hashSecret(token);
  const rows = await db<SessionRow[]>`
    SELECT id,session_hash,csrf_hash,last_seen_at,expires_at,revoked_at
    FROM sessions WHERE session_hash=${sessionHash}`;
  const row = rows[0];
  if (!row || row.revoked_at !== null) return null;
  if (row.expires_at.getTime() <= now) return null;
  if (now - row.last_seen_at.getTime() > SESSION_IDLE_TIMEOUT_SECONDS * 1000) return null;

  const lastTouch = lastSeenTouch.get(sessionHash) ?? 0;
  if (now - lastTouch > 30_000) {
    lastSeenTouch.set(sessionHash, now);
    void db`UPDATE sessions SET last_seen_at=NOW() WHERE session_hash=${sessionHash}`
      .execute()
      .catch(console.error);
  }
  return { sessionHash: row.session_hash, csrfHash: row.csrf_hash, jti: payload.jti };
}

/** Returns true when dev auth bypass is active or the request carries a valid, live admin session. */
export async function isAuthed(req: Request): Promise<boolean> {
  return (await authenticateRequest(req)) !== null;
}

/** Persists a freshly issued session row. */
export async function storeSession(session: IssuedSession, req?: Request): Promise<void> {
  await db`INSERT INTO sessions(session_hash,csrf_hash,expires_at,user_agent,ip)
    VALUES(${session.sessionHash},${session.csrfHash},${session.expiresAt},${req?.headers.get("user-agent")?.slice(0, 200) ?? null},${req ? (clientIp(req) ?? null) : null})`;
}

/** Marks the session matching this raw token revoked (logout). */
export async function revokeSessionToken(token: string): Promise<boolean> {
  const rows = await db<{ id: string }[]>`
    UPDATE sessions SET revoked_at=NOW()
    WHERE session_hash=${hashSecret(token)} AND revoked_at IS NULL
    RETURNING id`;
  return rows.length > 0;
}

/** Marks one session revoked by id; returns false when unknown or already revoked. */
export async function revokeSessionById(id: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return false;
  }
  const rows = await db<{ id: string }[]>`
    UPDATE sessions SET revoked_at=NOW()
    WHERE id=${id} AND revoked_at IS NULL
    RETURNING id`;
  return rows.length > 0;
}

/** Revokes every live session (single-admin hub: all rows). */
export async function revokeAllSessions(exceptToken?: string | null): Promise<number> {
  const except = exceptToken ? hashSecret(exceptToken) : null;
  const rows = await db<{ id: string }[]>`
    UPDATE sessions SET revoked_at=NOW()
    WHERE revoked_at IS NULL AND (${except}::text IS NULL OR session_hash <> ${except})
    RETURNING id`;
  return rows.length;
}

export type SessionInfo = {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  user_agent: string | null;
  ip: string | null;
  current: boolean;
};

/** Lists all sessions (live and revoked) for the admin, flagging the caller's own. The session hash itself is never returned. */
export async function listSessions(currentSessionHash: string | null): Promise<SessionInfo[]> {
  const rows = await db<(Omit<SessionInfo, "created_at" | "last_seen_at" | "expires_at" | "revoked_at" | "current"> & {
    session_hash: string;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
  })[]>`SELECT id,session_hash,created_at,last_seen_at,expires_at,revoked_at,user_agent,ip FROM sessions ORDER BY created_at DESC LIMIT 100`;
  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at.toISOString(),
    last_seen_at: row.last_seen_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
    user_agent: row.user_agent,
    ip: row.ip,
    current: currentSessionHash !== null && row.session_hash === currentSessionHash,
  }));
}

/** Constant-time CSRF check: header value hashed and compared to the session-bound hash. */
export function checkCsrfToken(req: Request, session: AdminSession): boolean {
  if (isAuthDisabled()) return true;
  const header = req.headers.get(CSRF_HEADER);
  if (!header || header.length > 256) return false;
  const expected = Buffer.from(session.csrfHash, "utf8");
  const actual = Buffer.from(hashSecret(header), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Best-effort client IP for session records/rate limits; Bun exposes it on the server info. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first && first.length <= 45) return first;
  }
  return null;
}

const attrs = (maxAge: number) =>
  `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${
    process.env.COOKIE_SECURE === "true" ? "; Secure" : ""
  }`;

/** Formats the `Set-Cookie` header value for an authenticated admin session. */
export const sessionCookie = (token: string) => `${cookieName}=${token}; ${attrs(SESSION_MAX_AGE_SECONDS)}`;

/** Formats the `Set-Cookie` header for the JS-readable CSRF double-submit cookie (NOT HttpOnly). */
export const csrfCookie = (token: string) =>
  `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${
    process.env.COOKIE_SECURE === "true" ? "; Secure" : ""
  }`;

/** Formats the `Set-Cookie` header value that clears the admin session cookie. */
export const logoutCookie = () =>
  `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${
    process.env.COOKIE_SECURE === "true" ? "; Secure" : ""
  }`;

/** Formats the `Set-Cookie` header value that clears the CSRF double-submit cookie. */
export const clearCsrfCookie = () =>
  `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${
    process.env.COOKIE_SECURE === "true" ? "; Secure" : ""
  }`;

/** Verifies the submitted admin password against `ADMIN_PASSWORD_HASH` (or local `ADMIN_PASSWORD`). */
export async function checkPassword(password: string): Promise<boolean> {
  if (process.env.ADMIN_PASSWORD_HASH) {
    return Bun.password.verify(password, process.env.ADMIN_PASSWORD_HASH);
  }
  if (process.env.NODE_ENV !== "production" && process.env.ADMIN_PASSWORD) {
    const a = Buffer.from(password);
    const b = Buffer.from(process.env.ADMIN_PASSWORD);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  throw new Error(
    "ADMIN_PASSWORD_HASH required (production), or ADMIN_PASSWORD (local only)",
  );
}
