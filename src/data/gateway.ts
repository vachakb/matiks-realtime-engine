// RequestGateway — the client data layer. Wraps any Fetcher and adds two safe, measured
// optimizations over the raw network:
//
//   1. In-flight dedup — identical requests issued before the first resolves share ONE
//      network call. Always behavior-preserving (same response, same moment).
//   2. TTL cache — responses are reused for `policy.ttlMs(spec)` after they arrive. Opt-in
//      per operation, so live data stays fresh.
//
// Everything is counted so the win is measurable, not asserted. `now` is injectable so the
// cache is testable without real time.

import type { Fetcher, CachePolicy, RequestSpec, ResponseRecord, GatewayMetrics } from './types.ts';
import { requestKey } from './keys.ts';

interface CacheEntry {
  expires: number;
  record: ResponseRecord;
}

export class RequestGateway {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ResponseRecord>>();
  private readonly fetcher: Fetcher;
  private readonly policy: CachePolicy;
  private readonly now: () => number;
  private readonly m = {
    requested: 0,
    networked: 0,
    deduped: 0,
    cacheHits: 0,
    bytesNetworked: 0,
    bytesServed: 0,
  };

  // Explicit field assignment (no TS parameter properties): Node's strip-only TS loader
  // can't emit the implicit `this.x = x`, so the whole repo assigns fields by hand.
  constructor(fetcher: Fetcher, policy: CachePolicy, now: () => number = () => Date.now()) {
    this.fetcher = fetcher;
    this.policy = policy;
    this.now = now;
  }

  async request(spec: RequestSpec): Promise<ResponseRecord> {
    this.m.requested++;
    const key = requestKey(spec);

    // 1. Fresh cache hit → no network.
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) {
      this.m.cacheHits++;
      this.m.bytesServed += hit.record.bytes;
      return { ...hit.record, fromCache: true, deduped: false };
    }

    // 2. Identical request already in flight → ride along.
    const pending = this.inflight.get(key);
    if (pending) {
      this.m.deduped++;
      const rec = await pending;
      this.m.bytesServed += rec.bytes;
      return { ...rec, deduped: true, fromCache: false };
    }

    // 3. Real network call.
    const p = this.fetcher(spec);
    this.inflight.set(key, p);
    try {
      const rec = await p;
      this.m.networked++;
      this.m.bytesNetworked += rec.bytes;
      this.m.bytesServed += rec.bytes;
      const ttl = this.policy.ttlMs(spec);
      if (ttl > 0 && rec.status >= 200 && rec.status < 300) {
        this.cache.set(key, { expires: this.now() + ttl, record: { ...rec, fromCache: false, deduped: false } });
      }
      return { ...rec, fromCache: false, deduped: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  get metrics(): GatewayMetrics {
    return { ...this.m, bytesSaved: this.m.bytesServed - this.m.bytesNetworked };
  }

  /** Drop all cached entries (e.g. on logout / cache-busting events). */
  clear(): void {
    this.cache.clear();
  }
}
