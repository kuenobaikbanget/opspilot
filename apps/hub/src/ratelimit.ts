import { isIP } from "node:net";

/**
 * Bounded in-memory sliding-window rate limiter for sensitive hub endpoints.
 * State is per-process and intentionally small; it is a backstop against
 * brute force, not a cross-instance quota (PostgreSQL remains the source of
 * truth for sessions and agent credentials).
 */

export type RateLimitBucket = {
  windowMs: number;
  max: number;
};

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the oldest hit in the window expires; 0 when allowed. */
  retryAfterSeconds: number;
  remaining: number;
};

type Hit = { at: number };

export class RateLimiter {
  private readonly hits = new Map<string, Hit[]>();
  private readonly bucket: RateLimitBucket;
  /** Optional clock injection for tests. */
  private readonly now: () => number;

  constructor(bucket: RateLimitBucket, now: () => number = Date.now) {
    if (!Number.isFinite(bucket.windowMs) || bucket.windowMs <= 0) {
      throw new Error("windowMs must be a positive number");
    }
    if (!Number.isInteger(bucket.max) || bucket.max < 1) {
      throw new Error("max must be a positive integer");
    }
    this.bucket = bucket;
    this.now = now;
  }

  /** Records a hit for `key` and reports whether it is within the budget. */
  hit(key: string): RateLimitResult {
    const now = this.now();
    const windowStart = now - this.bucket.windowMs;
    const existing = (this.hits.get(key) ?? []).filter((h) => h.at > windowStart);
    if (existing.length >= this.bucket.max) {
      const oldest = existing[0].at;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.bucket.windowMs - now) / 1000));
      this.hits.set(key, existing);
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    }
    existing.push({ at: now });
    this.hits.set(key, existing);
    this.prune(now);
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: this.bucket.max - existing.length,
    };
  }

  /** Drops fully-expired keys so the map cannot grow without bound. */
  private prune(now: number): void {
    if (this.hits.size < 10_000) return;
    const windowStart = now - this.bucket.windowMs;
    for (const [key, hits] of this.hits) {
      const fresh = hits.filter((h) => h.at > windowStart);
      if (fresh.length) this.hits.set(key, fresh);
      else this.hits.delete(key);
    }
  }
}

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
};

/** Per-IP buckets for the sensitive endpoints. Tunable via environment, bounded. */
export const loginLimiter = () =>
  new RateLimiter({
    windowMs: envInt("RATE_LIMIT_LOGIN_WINDOW_MS", 5 * 60_000, 1_000, 3_600_000),
    max: envInt("RATE_LIMIT_LOGIN_MAX", 5, 1, 1_000),
  });

export const enrollLimiter = () =>
  new RateLimiter({
    windowMs: envInt("RATE_LIMIT_ENROLL_WINDOW_MS", 10 * 60_000, 1_000, 3_600_000),
    max: envInt("RATE_LIMIT_ENROLL_MAX", 10, 1, 1_000),
  });

export const adminWriteLimiter = () =>
  new RateLimiter({
    windowMs: envInt("RATE_LIMIT_ADMIN_WINDOW_MS", 60_000, 1_000, 3_600_000),
    max: envInt("RATE_LIMIT_ADMIN_MAX", 600, 1, 100_000),
  });

type IpMatcher = (ip: string) => boolean;

function normalizeIp(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("::ffff:")) {
    const mapped = trimmed.slice(7);
    if (isIP(mapped) === 4) return mapped;
  }
  return trimmed;
}

function ipv4ToUint32(ip: string): number {
  return ip.split(".").reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

function ipv6ToBigInt(ip: string): bigint | null {
  let addr = ip;
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.includes(".")) {
    const v4 = addr.slice(lastColon + 1);
    if (isIP(v4) !== 4) return null;
    const n = ipv4ToUint32(v4);
    addr = `${addr.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 0) return null;
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill("0"), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    const n = Number.parseInt(g, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    value = (value << 16n) | BigInt(n);
  }
  return value;
}

function compileTrustedProxyEntry(entry: string): IpMatcher | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    const target = normalizeIp(trimmed);
    const kind = isIP(target);
    if (kind === 0) return null;
    if (kind === 4) return (ip) => isIP(ip) === 4 && ip === target;
    const targetVal = ipv6ToBigInt(target);
    if (targetVal === null) return null;
    return (ip) => isIP(ip) === 6 && ipv6ToBigInt(ip) === targetVal;
  }

  const base = normalizeIp(trimmed.slice(0, slash));
  const prefixRaw = trimmed.slice(slash + 1);
  if (!/^\d+$/.test(prefixRaw)) return null;
  const prefix = Number(prefixRaw);
  const kind = isIP(base);
  if (kind === 4 && Number.isInteger(prefix) && prefix >= 1 && prefix <= 32) {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    const net = (ipv4ToUint32(base) & mask) >>> 0;
    return (ip) => isIP(ip) === 4 && ((ipv4ToUint32(ip) & mask) >>> 0) === net;
  }
  if (kind === 6 && Number.isInteger(prefix) && prefix >= 1 && prefix <= 128) {
    const baseVal = ipv6ToBigInt(base);
    if (baseVal === null) return null;
    const shift = BigInt(128 - prefix);
    const mask = ((1n << 128n) - 1n) ^ ((1n << shift) - 1n);
    const net = baseVal & mask;
    return (ip) => {
      if (isIP(ip) !== 6) return false;
      const v = ipv6ToBigInt(ip);
      return v !== null && (v & mask) === net;
    };
  }
  return null;
}

let cachedProxyRaw: string | undefined;
let cachedProxyMatchers: IpMatcher[] = [];

function getTrustedProxyMatchers(override?: string): IpMatcher[] {
  const raw = override !== undefined ? override : (process.env.TRUSTED_PROXY_IPS ?? "");
  if (override === undefined && raw === cachedProxyRaw) return cachedProxyMatchers;
  const matchers = raw
    .split(",")
    .map(compileTrustedProxyEntry)
    .filter((m): m is IpMatcher => m !== null);
  if (override === undefined) {
    cachedProxyRaw = raw;
    cachedProxyMatchers = matchers;
  }
  return matchers;
}

/**
 * Resolves the client IP for rate limiting. By default (when `TRUSTED_PROXY_IPS` is unset)
 * only the socket `remoteAddress` is used so `X-Forwarded-For` cannot be spoofed. When
 * `remoteAddress` matches an explicit trusted proxy IP/CIDR, `X-Forwarded-For` is walked
 * right-to-left to find the nearest untrusted hop (falling back to `X-Real-IP`).
 */
export function resolveClientIp(
  req: Request,
  info?: { remoteAddress?: string | null },
  trustedProxies?: string,
): string {
  const rawRemote = info?.remoteAddress;
  if (!rawRemote) return "unknown";
  const remote = normalizeIp(rawRemote);
  if (!remote) return "unknown";

  const matchers = getTrustedProxyMatchers(trustedProxies);
  if (matchers.length === 0) return remote;
  const isTrusted = (ip: string) => matchers.some((m) => m(ip));
  if (!isTrusted(remote)) return remote;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map(normalizeIp)
      .filter((ip) => isIP(ip) !== 0);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isTrusted(hops[i])) return hops[i];
    }
    if (hops.length > 0) return hops[0];
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    const normalized = normalizeIp(realIp);
    if (isIP(normalized) !== 0) return normalized;
  }

  return remote;
}

/** Client identity for rate limiting: socket address or trusted-proxy forwarded client IP. */
export function rateLimitKey(
  req: Request,
  scope: string,
  info?: { remoteAddress?: string | null },
  trustedProxies?: string,
): string {
  return `${scope}:${resolveClientIp(req, info, trustedProxies)}`;
}
