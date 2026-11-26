/**
 * Client-side shape checks for an operator-supplied probe target. The Hub applies the full
 * SSRF/egress policy server-side and can still reject the target with `invalid_target`;
 * nothing is saved without a validated target.
 */
export function targetUrlProblem(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Enter a valid absolute URL, for example https://api.example.com/health.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Only HTTP(S) targets can be monitored.";
  if (parsed.username || parsed.password) return "URLs with embedded credentials are not allowed.";
  if (parsed.hash) return "Remove the fragment (#…) from the target URL.";
  return null;
}
