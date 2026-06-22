// Request identity. Two requests are "the same" if they'd return the same response:
// same method + URL (sans cache-busting noise) + same body. For GraphQL POSTs that means
// the same operationName + variables, so we parse the body to get a stable key regardless
// of key ordering in the serialized JSON.

import type { RequestSpec } from './types.ts';

export interface GqlInfo {
  op: string;
  variables: unknown;
}

/** Parse a GraphQL POST body → {op, variables}, or null if it isn't GraphQL. */
export function gqlInfo(body: string | undefined): GqlInfo | null {
  if (!body) return null;
  try {
    let b = JSON.parse(body) as Record<string, unknown> | Array<Record<string, unknown>>;
    if (Array.isArray(b)) b = b[0] ?? {}; // batched GraphQL: key on the first op
    const op = (b as Record<string, unknown>).operationName;
    if (typeof op === 'string' && op) {
      return { op, variables: (b as Record<string, unknown>).variables ?? null };
    }
  } catch {
    /* not JSON / not GraphQL */
  }
  return null;
}

/** Deterministic JSON: object keys sorted recursively, so {a,b} and {b,a} hash equal. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Stable identity key for a request. */
export function requestKey(spec: RequestSpec): string {
  const gql = gqlInfo(spec.body);
  if (gql) return `gql:${gql.op}:${stableStringify(gql.variables)}`;
  // Non-GraphQL: method + url (strip a trailing cache-buster like ?_=123 if present).
  const url = spec.url.replace(/([?&])_=\d+(&|$)/, (_m, p1, p2) => (p2 ? p1 : ''));
  return `${spec.method.toUpperCase()} ${url}${spec.body ? ' ' + spec.body : ''}`;
}
