// Client data-layer types — framework-agnostic: the gateway wraps any fetch-like function (Apollo
// link, plain fetch, or the capture-replay harness).

export interface RequestSpec {
  method: string;
  url: string;
  body?: string; // for GraphQL, the JSON POST body
}

export interface ResponseRecord {
  status: number;
  bytes: number; // response size (what the network would have transferred)
  body?: unknown;
  fromCache?: boolean; // served from the TTL cache (no network)
  deduped?: boolean;   // collapsed into an in-flight identical request (no extra network)
}

export type Fetcher = (spec: RequestSpec) => Promise<ResponseRecord>;

// How long a response may be reused. 0 = never cache.
export interface CachePolicy {
  ttlMs(spec: RequestSpec): number;
}

export interface GatewayMetrics {
  requested: number;      // calls the app asked the gateway to make
  networked: number;      // calls that actually hit the fetcher
  deduped: number;        // collapsed into an in-flight identical request
  cacheHits: number;      // served from the TTL cache
  bytesNetworked: number; // bytes actually fetched
  bytesServed: number;    // bytes handed back to callers (incl. cache/dedup)
  bytesSaved: number;     // bytesServed - bytesNetworked
}
