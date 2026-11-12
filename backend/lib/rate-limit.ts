export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number };

type Bucket = number[];

export type RateLimiter = {
  take(key: string, now?: number): Promise<RateDecision>;
  remember(key: string, id: string, now?: number): Promise<RateDecision>;
};

function prune(stamps: Bucket, now: number, windowMs: number): Bucket {
  return stamps.filter((stamp) => now - stamp < windowMs);
}

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const seen = new Map<string, Map<string, number>>();
  let tail = Promise.resolve();

  function exclusive<T>(work: () => T): Promise<T> {
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    take(key, now = Date.now()) {
      return exclusive(() => {
        const fresh = prune(buckets.get(key) ?? [], now, windowMs);
        if (fresh.length >= limit) {
          buckets.set(key, fresh);
          return { ok: false, retryAfterMs: Math.max(1, windowMs - (now - fresh[0])) };
        }
        fresh.push(now);
        buckets.set(key, fresh);
        return { ok: true };
      });
    },
    remember(key, id, now = Date.now()) {
      return exclusive(() => {
        const bucket = seen.get(key) ?? new Map<string, number>();
        for (const [storedId, stamp] of bucket) {
          if (now - stamp >= windowMs) bucket.delete(storedId);
        }
        const previous = bucket.get(id);
        if (previous !== undefined && now - previous < windowMs) {
          seen.set(key, bucket);
          return { ok: true };
        }
        if (bucket.size >= limit) {
          const oldest = Math.min(...bucket.values());
          seen.set(key, bucket);
          return { ok: false, retryAfterMs: Math.max(1, windowMs - (now - oldest)) };
        }
        bucket.set(id, now);
        seen.set(key, bucket);
        return { ok: true };
      });
    },
  };
}
