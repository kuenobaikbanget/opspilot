import { createHmac, timingSafeEqual } from "node:crypto";

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

/** Creates a signed single-admin session token valid for 8 hours. */
export function createSession(): string {
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must have >= 32 chars");
  }
  const payload = Buffer.from(
    JSON.stringify({
      sub: "single-admin",
      exp: Math.floor(Date.now() / 1000) + 8 * 3600,
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Verifies the HMAC signature and expiration of a session token. */
export function verifySession(token: string): boolean {
  if (secret.length < 32) {
    return false;
  }
  const [payload, signature, ...extra] = token.split(".");
  if (!payload || !signature || extra.length) {
    return false;
  }

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return false;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return (
      data.sub === "single-admin" &&
      typeof data.exp === "number" &&
      data.exp > Date.now() / 1000
    );
  } catch {
    return false;
  }
}

/** Returns true when dev auth bypass is active or the incoming request carries a valid admin session cookie. */
export function isAuthed(req: Request): boolean {
  if (isAuthDisabled()) {
    return true;
  }
  const raw = req.headers.get("cookie") || "";
  const token = raw
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return !!token && verifySession(token);
}

const attrs = () =>
  `Path=/; HttpOnly; SameSite=Strict; Max-Age=${8 * 3600}${
    process.env.COOKIE_SECURE === "true" ? "; Secure" : ""
  }`;

/** Formats the `Set-Cookie` header value for an authenticated admin session. */
export const sessionCookie = (token: string) => `${cookieName}=${token}; ${attrs()}`;

/** Formats the `Set-Cookie` header value that clears the admin session cookie. */
export const logoutCookie = () =>
  `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${
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
