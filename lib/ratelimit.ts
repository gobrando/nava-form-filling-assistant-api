/**
 * A fixed-window rate limiter.
 *
 * The connector contract requires the service to "rate-limit lookups and return
 * generic errors to the extension", and an unthrottled record lookup is an
 * enumeration oracle over participant identifiers.
 *
 * This counts in process memory, so with more than one instance the effective
 * limit is the configured limit times the instance count. That is acceptable
 * for a prototype and not acceptable in production; the fix is the same shared
 * store labs-asp already runs (Upstash Redis) and this module's signature does
 * not change when it lands.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

export type RateLimitVerdict = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitVerdict {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSeconds: allowed ? 0 : Math.ceil((existing.resetAt - now) / 1000),
  };
}

/** Record lookups are the sensitive surface, so they get the tighter budget. */
export const RECORD_LOOKUP_LIMIT = 60;
export const RECORD_LOOKUP_WINDOW_MS = 60_000;

export const GENERAL_LIMIT = 600;
export const GENERAL_WINDOW_MS = 60_000;

/** Exposed for tests; there is no other reason to reach into the window map. */
export function resetRateLimits(): void {
  windows.clear();
}
