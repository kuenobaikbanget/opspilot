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

/** Client identity for rate limiting: socket address only, never a spoofable header. */
export function rateLimitKey(req: Request, scope: string, info?: { remoteAddress?: string | null }): string {
  return `${scope}:${info?.remoteAddress ?? "unknown"}`;
}
