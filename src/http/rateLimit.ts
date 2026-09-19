/**
 * Rate limiting — in-memory sliding window (swap the store for Redis in
 * production; the interface is identical). Applied to authentication, invite
 * redemption, imports, exports and report generation.
 */
export interface RateLimiter {
  /** Returns true when the action is allowed; false when over budget. */
  allow(key: string, limit: number, windowMs: number, now: number): boolean;
  hits(key: string): number;
}

export function createRateLimiter(): RateLimiter {
  const buckets = new Map<string, number[]>(); // key → timestamps

  const prune = (key: string, windowMs: number, now: number): void => {
    const arr = buckets.get(key);
    if (!arr) return;
    const kept = arr.filter((t) => now - t < windowMs);
    if (kept.length === 0) buckets.delete(key);
    else buckets.set(key, kept);
  };

  return {
    allow(key, limit, windowMs, now) {
      prune(key, windowMs, now);
      const arr = buckets.get(key) ?? [];
      if (arr.length >= limit) {
        buckets.set(key, arr);
        return false;
      }
      arr.push(now);
      buckets.set(key, arr);
      return true;
    },
    hits(key) {
      return buckets.get(key)?.length ?? 0;
    },
  };
}
