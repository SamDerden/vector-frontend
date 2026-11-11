import { createHash } from 'node:crypto';
import type { DbQuery } from './sofi-generate.ts';

export class CapacityError extends Error {
  readonly status = 429;
  readonly retryAfter: number;
  constructor(retryAfter: number) { super('Слишком много запросов. Попробуй позже.'); this.retryAfter = retryAfter; }
}

// Fixed, bounded keys: shared counters survive restarts and work across replicas.
export async function consumeLimit(query: DbQuery, key: string, seconds: number, limit: number) {
  const result = await query(`INSERT INTO request_budgets (key, window_start, used)
    VALUES ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
    ON CONFLICT (key) DO UPDATE SET
      window_start = EXCLUDED.window_start,
      used = CASE WHEN request_budgets.window_start = EXCLUDED.window_start
        THEN request_budgets.used + 1 ELSE 1 END
    WHERE request_budgets.window_start <> EXCLUDED.window_start OR request_budgets.used < $3
    RETURNING used`, [key, seconds, limit]);
  if (!result.rowCount) throw new CapacityError(seconds);
}

export function clientBucket(headers: Pick<Headers, 'get'>): string {
  // Not an authorization signal. Global budgets remain effective even if spoofed.
  const address = headers.get('x-real-ip') ?? headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown';
  return createHash('sha256').update(address.trim()).digest('hex').slice(0, 32);
}
