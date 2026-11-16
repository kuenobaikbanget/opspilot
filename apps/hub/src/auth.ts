import { createHmac, timingSafeEqual } from "node:crypto";
const secret = process.env.SESSION_SECRET || "";
if (secret.length < 32) throw new Error("SESSION_SECRET must have >= 32 chars");
const cookieName = "opspilot_session";
const sign = (payload:string) => createHmac("sha256", secret).update(payload).digest("base64url");
export function createSession(): string {
  const payload = Buffer.from(JSON.stringify({sub:"single-admin",exp:Math.floor(Date.now()/1000)+8*3600})).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
export function verifySession(token: string): boolean {
  const [payload,signature,...extra] = token.split(".");
  if (!payload || !signature || extra.length) return false;
  const expected=Buffer.from(sign(payload)); const actual=Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try { const data=JSON.parse(Buffer.from(payload,"base64url").toString()); return data.sub==="single-admin" && typeof data.exp==="number" && data.exp > Date.now()/1000; }
  catch { return false; }
}
export function isAuthed(req:Request): boolean {
  const raw=req.headers.get("cookie")||"";
  const token=raw.split(";").map(x=>x.trim()).find(x=>x.startsWith(cookieName+"="))?.slice(cookieName.length+1);
  return !!token && verifySession(token);
}
const attrs = () => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${8*3600}${process.env.COOKIE_SECURE==="true" ? "; Secure":""}`;
export const sessionCookie = (token:string) => `${cookieName}=${token}; ${attrs()}`;
export const logoutCookie = () => `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.COOKIE_SECURE==="true"?"; Secure":""}`;
export async function checkPassword(password:string):Promise<boolean> {
  if (process.env.ADMIN_PASSWORD_HASH) return Bun.password.verify(password, process.env.ADMIN_PASSWORD_HASH);
  if (process.env.NODE_ENV!=="production" && process.env.ADMIN_PASSWORD) {
    const a=Buffer.from(password), b=Buffer.from(process.env.ADMIN_PASSWORD);
    return a.length===b.length && timingSafeEqual(a,b);
  }
  throw new Error("ADMIN_PASSWORD_HASH required (production), or ADMIN_PASSWORD (local only)");
}
