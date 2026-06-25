// RequestGateway — client data layer over any Fetcher: in-flight dedup (identical concurrent
// requests share one call) + opt-in per-operation TTL cache. Metrics counted; `now` injectable.

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

  // No TS parameter properties — Node's strip-only loader can't emit them; assign by hand.
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
