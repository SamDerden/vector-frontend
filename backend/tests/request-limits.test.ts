import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeLimit, CapacityError, clientBucket } from '../lib/request-limits.ts';

test('exhausted database budget rejects the request with a retry interval', async () => {
  await assert.rejects(consumeLimit(async () => ({ rowCount: 0, rows: [] }), 'ai:global:day', 86400, 200),
    (error: unknown) => error instanceof CapacityError && error.status === 429 && error.retryAfter === 86400);
});
test('available database budget accepts a request', async () => {
  await consumeLimit(async () => ({ rowCount: 1, rows: [{ used: 1 }] }), 'ai:global:day', 86400, 200);
});
test('rate-limit client identifiers do not store raw IP addresses', () => {
  assert.equal(clientBucket(new Headers({ 'x-real-ip': '192.0.2.1' })).length, 32);
  assert.notEqual(clientBucket(new Headers({ 'x-real-ip': '192.0.2.1' })), clientBucket(new Headers({ 'x-real-ip': '192.0.2.2' })));
});
