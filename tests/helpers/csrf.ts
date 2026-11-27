/** Extracts the raw CSRF token from the hub login response's `opspilot_csrf` Set-Cookie. */
export function csrfFromLogin(res: Response): string {
  for (const cookie of res.headers.getSetCookie()) {
    if (cookie.startsWith("opspilot_csrf=")) {
      return cookie.split(";")[0]!.slice("opspilot_csrf=".length);
    }
  }
  return "";
}

/** Adds the CSRF header to `headers` for state-changing methods when a token is known. */
export function withCsrf(headers: Headers, method: string, csrf: string): void {
  if (method !== "GET" && method !== "HEAD" && csrf) {
    headers.set("x-opspilot-csrf", csrf);
  }
}
