// The client data layer: in-flight dedup + tunable TTL caching for the request fan-out,
// measured against real Matiks capture traffic. Framework-agnostic core;
// drops in over Apollo as a link or over plain fetch.
export { RequestGateway } from './gateway.ts';
export { RequestBatcher } from './batcher.ts';
export type { BatchFetcher } from './batcher.ts';
export { OperationTtlPolicy, MATIKS_QUERY_TTL_MS } from './policy.ts';
export { requestKey, gqlInfo, stableStringify } from './keys.ts';
export type {
  RequestSpec,
  ResponseRecord,
  Fetcher,
  CachePolicy,
  GatewayMetrics,
} from './types.ts';
