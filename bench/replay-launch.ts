// Replays REAL captured Matiks GraphQL traffic through the data-layer gateway to measure,
// on real call timing, how many network calls + bytes a tunable TTL-cache policy would save.
//
// The capture path is passed as an argument (it contains tokens/PII), so nothing sensitive
// is ever committed — same pattern as the L3 golden decrypt test:
//
//   node bench/replay-launch.ts /path/to/matiks-capture.jsonl
//
// "BEFORE" = every GraphQL call the app actually made. "AFTER" = the calls that would still
// hit the network under MATIKS_QUERY_TTL_MS (live data like GetGameByIdV2 has no TTL → never
// cached → always counted). Honest by construction: we only avoid identical op+variables.

import { readFileSync } from 'node:fs';
import { RequestGateway } from '../src/data/gateway.ts';
import { OperationTtlPolicy, MATIKS_QUERY_TTL_MS } from '../src/data/policy.ts';
import { gqlInfo } from '../src/data/keys.ts';
import type { Fetcher, RequestSpec } from '../src/data/types.ts';

interface Call {
  ts: number;
  op: string;
  bytes: number;
  spec: RequestSpec;
}

function responseBytes(resp: Record<string, unknown>): number {
  const h = resp.headers;
  if (h && typeof h === 'object') {
    const cl = (h as Record<string, string>)['content-length'] ?? (h as Record<string, string>)['Content-Length'];
    if (cl) return Number(cl);
  }
  return Buffer.byteLength(typeof resp.body === 'string' ? resp.body : '', 'utf8');
}

function loadGqlCalls(path: string): Call[] {
  const reqs = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'request') reqs.set(e.id as string, e);
    else if (e.type === 'response') {
      const rq = reqs.get(e.id as string);
      if (!rq) continue;
      const url = String(rq.url ?? '');
      if (!url.includes('matiks.org') || rq.method !== 'POST') continue;
      const body = typeof rq.postData === 'string' ? rq.postData : undefined;
      const op = gqlInfo(body)?.op;
      if (!op) continue;
      calls.push({ ts: Number(rq.ts ?? 0), op, bytes: responseBytes(e), spec: { method: 'POST', url, body } });
    }
  }
  return calls.sort((a, b) => a.ts - b.ts);
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node bench/replay-launch.ts <capture.jsonl>');
    process.exit(1);
  }
  const calls = loadGqlCalls(path);
  if (!calls.length) {
    console.error('no GraphQL calls found in capture');
    process.exit(1);
  }

  const sizeOf = new Map<RequestSpec, number>();
  for (const c of calls) sizeOf.set(c.spec, c.bytes);

  const netByOp = new Map<string, number>();
  const netTimes: number[] = []; // timestamps of calls that actually hit the network
  const fetcher: Fetcher = async (spec) => {
    const op = gqlInfo(spec.body)?.op ?? '?';
    netByOp.set(op, (netByOp.get(op) ?? 0) + 1);
    netTimes.push(clock.t);
    return { status: 200, bytes: sizeOf.get(spec) ?? 0 };
  };

  const clock = { t: calls[0].ts };
  const gw = new RequestGateway(fetcher, new OperationTtlPolicy(MATIKS_QUERY_TTL_MS, 0), () => clock.t);

  const beforeByOp = new Map<string, number>();
  for (const c of calls) beforeByOp.set(c.op, (beforeByOp.get(c.op) ?? 0) + 1);
  const beforeBytes = calls.reduce((s, c) => s + c.bytes, 0);

  for (const c of calls) {
    clock.t = c.ts;
    await gw.request(c.spec);
  }

  const m = gw.metrics;
  const spanS = Math.round((calls[calls.length - 1].ts - calls[0].ts) / 1000);
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

  console.log(`Replayed ${calls.length} real GraphQL calls over ${spanS}s (MATIKS_QUERY_TTL_MS policy)\n`);
  console.log(`  BEFORE : ${calls.length} network calls, ${Math.round(beforeBytes / 1024)} KB`);
  console.log(`  AFTER  : ${m.networked} network calls, ${Math.round(m.bytesNetworked / 1024)} KB`);
  console.log(`  SAVED  : ${calls.length - m.networked} calls (${pct(calls.length - m.networked, calls.length)}%), ${Math.round((beforeBytes - m.bytesNetworked) / 1024)} KB\n`);

  const saved = [...beforeByOp.entries()]
    .map(([op, before]) => ({ op, before, after: netByOp.get(op) ?? 0 }))
    .filter((r) => r.before - r.after > 0)
    .sort((a, b) => b.before - b.after - (a.before - a.after));
  console.log('  Top operations collapsed (before → after):');
  for (const r of saved.slice(0, 12)) console.log(`    ${String(r.before - r.after).padStart(3)} saved   ${r.op}  (${r.before} → ${r.after})`);

  // Batching estimate: group the calls that still hit the network into windows (concurrent
  // queries → one batched HTTP request). This is the launch-fan-out lever dedup/cache can't touch.
  const WINDOW = 50, MAXBATCH = 25;
  const windowedRoundTrips = (times: number[]): number => {
    const t = [...times].sort((a, b) => a - b);
    let trips = 0, i = 0;
    while (i < t.length) {
      const start = t[i];
      let n = 0;
      while (i < t.length && t[i] - start <= WINDOW && n < MAXBATCH) { i++; n++; }
      trips++;
    }
    return trips;
  };
  const allTimes = calls.map((c) => c.ts);
  console.log(`\n  + request batching (${WINDOW}ms window, max ${MAXBATCH}/batch):`);
  console.log(`    network HTTP round-trips: ${m.networked} calls → ${windowedRoundTrips(netTimes)} batched requests`);
  console.log(`    (no caching, batching alone: ${calls.length} calls → ${windowedRoundTrips(allTimes)} batched requests)`);
}

main();
