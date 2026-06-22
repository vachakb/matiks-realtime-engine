// The client data layer's shared types. Framework-agnostic on purpose: the gateway
// wraps any `fetch`-like function, so it drops in over Apollo (as a link), plain fetch,
// or the capture-replay harness — same code, same tests.

/** A request the app wants to make. For GraphQL, `body` is the JSON POST body. */
export interface RequestSpec {
  method: string;
  url: string;
  body?: string;
}

/** The result of a request, plus how the gateway served it. */
export interface ResponseRecord {
  status: number;
  /** Response size in bytes (what the network would have transferred). */
  bytes: number;
  body?: unknown;
  /** True if served from the TTL cache (no network). */
  fromCache?: boolean;
  /** True if collapsed into an already-in-flight identical request (no extra network). */
  deduped?: boolean;
}

/** The underlying transport the gateway wraps (real fetch, Apollo, or a replay stub). */
export type Fetcher = (spec: RequestSpec) => Promise<ResponseRecord>;

/** Decides how long a given request's response may be reused. 0 = never cache. */
export interface CachePolicy {
  ttlMs(spec: RequestSpec): number;
}

/** Running totals. `bytesSaved` is what dedup + cache kept off the wire. */
export interface GatewayMetrics {
  requested: number; // calls the app asked the gateway to make
  networked: number; // calls that actually hit the fetcher
  deduped: number; // collapsed into an in-flight identical request
  cacheHits: number; // served from the TTL cache
  bytesNetworked: number; // bytes actually fetched
  bytesServed: number; // bytes handed back to callers (incl. cache/dedup)
  bytesSaved: number; // bytesServed - bytesNetworked
}
