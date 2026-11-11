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
test('the first forwarded hop selects the bucket and a client can spoof it', () => {
  const first = clientBucket(new Headers({ 'x-forwarded-for': '203.0.113.8, 198.51.100.2' }));
  const spoofed = clientBucket(new Headers({ 'x-forwarded-for': '203.0.113.9, 198.51.100.2' }));
  const sameFirstHop = clientBucket(new Headers({ 'x-forwarded-for': '203.0.113.8, 192.0.2.9' }));
  assert.notEqual(first, spoofed);
  assert.equal(first, sameFirstHop);
});
