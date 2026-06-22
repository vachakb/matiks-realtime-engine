import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RequestGateway } from '../src/data/gateway.ts';
import { RequestBatcher } from '../src/data/batcher.ts';
import type { BatchFetcher } from '../src/data/batcher.ts';
import { OperationTtlPolicy } from '../src/data/policy.ts';
import { requestKey } from '../src/data/keys.ts';
import type { Fetcher, RequestSpec } from '../src/data/types.ts';

// A fetcher that counts how many times it actually ran, per key.
function countingFetcher(bytes = 100, status = 200): { fetcher: Fetcher; calls: () => number } {
  let n = 0;
  const fetcher: Fetcher = async () => {
    n++;
    return { status, bytes };
  };
  return { fetcher, calls: () => n };
}

const gql = (op: string, variables: unknown = {}): RequestSpec => ({
  method: 'POST',
  url: 'https://api.matiks.org/graphql',
  body: JSON.stringify({ operationName: op, variables, query: `query ${op} {}` }),
});

test('requestKey: same op + variables match regardless of key order or query text', () => {
  const a = requestKey(gql('GetCurrentUser', { id: 1, scope: 'x' }));
  const b = requestKey({ ...gql('GetCurrentUser', { scope: 'x', id: 1 }), body: JSON.stringify({ operationName: 'GetCurrentUser', variables: { scope: 'x', id: 1 }, query: 'different text' }) });
  assert.equal(a, b);
  assert.notEqual(a, requestKey(gql('GetCurrentUser', { id: 2 })));
});

test('in-flight dedup: N concurrent identical requests → 1 network call', async () => {
  const { fetcher, calls } = countingFetcher();
  const gw = new RequestGateway(fetcher, new OperationTtlPolicy({}, 0));
  const results = await Promise.all(Array.from({ length: 8 }, () => gw.request(gql('GetUsers'))));
  assert.equal(calls(), 1, 'only one underlying call');
  assert.equal(results.filter((r) => r.deduped).length, 7, 'the other 7 are deduped');
  assert.equal(gw.metrics.deduped, 7);
});

test('TTL cache: hit within TTL, refetch after expiry', async () => {
  const clock = { t: 1000 };
  const { fetcher, calls } = countingFetcher();
  const gw = new RequestGateway(fetcher, new OperationTtlPolicy({ GetCurrentUser: 30_000 }), () => clock.t);

  await gw.request(gql('GetCurrentUser')); // network
  const cached = await gw.request(gql('GetCurrentUser')); // cache hit
  assert.equal(calls(), 1);
  assert.equal(cached.fromCache, true);

  clock.t += 31_000; // past TTL
  await gw.request(gql('GetCurrentUser')); // refetch
  assert.equal(calls(), 2);
  assert.equal(gw.metrics.cacheHits, 1);
});

test('no-cache by default: live data is never cached', async () => {
  const { fetcher, calls } = countingFetcher();
  // GetGameByIdV2 not in rules → default 0 → always networks.
  const gw = new RequestGateway(fetcher, new OperationTtlPolicy({ GetCurrentUser: 30_000 }, 0));
  await gw.request(gql('GetGameByIdV2', { id: 'g1' }));
  await gw.request(gql('GetGameByIdV2', { id: 'g1' }));
  assert.equal(calls(), 2, 'game state refetched every time');
});

test('non-2xx responses are not cached', async () => {
  const { fetcher, calls } = countingFetcher(50, 500);
  const gw = new RequestGateway(fetcher, new OperationTtlPolicy({ GetCurrentUser: 30_000 }));
  await gw.request(gql('GetCurrentUser'));
  await gw.request(gql('GetCurrentUser'));
  assert.equal(calls(), 2, 'errors must not be cached');
});

test('batcher: queries fired in one tick collapse into a single round-trip', async () => {
  let batchCalls = 0;
  let lastSize = 0;
  const bf: BatchFetcher = async (specs) => {
    batchCalls++;
    lastSize = specs.length;
    return specs.map(() => ({ status: 200, bytes: 100 }));
  };
  const b = new RequestBatcher(bf, 25);
  // 30 distinct queries fired together (the launch fan-out)
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) => b.request(gql('Q' + i))),
  );
  assert.equal(results.length, 30);
  // 30 with maxBatch 25 → 2 round-trips (25 + 5), not 30
  assert.equal(b.roundTrips, 2);
  assert.equal(lastSize, 5, 'second chunk has the remaining 5');
  assert.ok(batchCalls === 2);
});

test('batcher: results route back to the right caller, positionally', async () => {
  const bf: BatchFetcher = async (specs) => specs.map((s, i) => ({ status: 200, bytes: i }));
  const b = new RequestBatcher(bf, 25);
  const [r0, r1, r2] = await Promise.all([b.request(gql('A')), b.request(gql('B')), b.request(gql('C'))]);
  assert.deepEqual([r0.bytes, r1.bytes, r2.bytes], [0, 1, 2]);
  assert.equal(b.roundTrips, 1);
});

test('batcher: requests in different ticks are separate round-trips', async () => {
  const bf: BatchFetcher = async (specs) => specs.map(() => ({ status: 200, bytes: 1 }));
  const b = new RequestBatcher(bf);
  await b.request(gql('A'));
  await b.request(gql('B'));
  assert.equal(b.roundTrips, 2);
});

test('metrics: bytesSaved counts dedup + cache hits', async () => {
  const clock = { t: 0 };
  const { fetcher } = countingFetcher(200);
  const gw = new RequestGateway(fetcher, new OperationTtlPolicy({ GetCurrentUser: 10_000 }), () => clock.t);
  await Promise.all([gw.request(gql('GetCurrentUser')), gw.request(gql('GetCurrentUser'))]); // 1 net + 1 dedup
  await gw.request(gql('GetCurrentUser')); // cache hit
  const m = gw.metrics;
  assert.equal(m.networked, 1);
  assert.equal(m.bytesNetworked, 200);
  assert.equal(m.bytesServed, 600); // 3 callers each got 200 bytes
  assert.equal(m.bytesSaved, 400); // 2 of them off the wire
});
