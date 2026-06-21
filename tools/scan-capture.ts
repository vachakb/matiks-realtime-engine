#!/usr/bin/env node
/**
 * scan-capture — turns a Matiks traffic capture (JSONL from capture.mjs) into a bug & waste
 * report. Auto-detects the signatures we found by hand so they're reproducible and reusable.
 *
 * Usage: node tools/scan-capture.ts <capture.jsonl>
 *
 * Detects: server/GraphQL errors, the matchmaking abort-race, duplicate question payloads,
 * and redundant identity/opponent fetches. (Client-side TypeError crashes are NOT visible in a
 * network capture — see reports/09 + reports/11 for how to capture those with DevTools.)
 */
import { readFileSync } from 'node:fs';

interface Ev {
  type: string; id?: number; ts: number; status?: number;
  url?: string; method?: string; postData?: string | null; body?: string | null;
}

const path = process.argv[2];
if (!path) { console.error('usage: node tools/scan-capture.ts <capture.jsonl>'); process.exit(1); }

const ev: Ev[] = [];
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { ev.push(JSON.parse(line)); } catch { /* skip */ }
}
const reqById = new Map<number, Ev>();
for (const e of ev) if (e.type === 'request' && e.id != null) reqById.set(e.id, e);
const op = (e?: Ev): string | undefined => {
  if (e?.postData) { try { return JSON.parse(e.postData).operationName; } catch { /* */ } }
  return undefined;
};
const t0 = ev[0]?.ts ?? 0;
const at = (t: number) => `+${((t - t0) / 1000).toFixed(0)}s`;
const count = (name: string) => ev.filter((e) => op(e) === name).length;

console.log(`# Capture scan — ${path.split('/').pop()}  (${ev.length} events)\n`);

// 1) Server / network health
const httpErrs = ev.filter((e) => e.type === 'response' && (e.status ?? 0) >= 400);
const gqlErrs: string[] = [];
for (const e of ev) {
  if (e.type === 'response' && (e.url || '').includes('/api') && e.body) {
    try { const b = JSON.parse(e.body); if (b?.errors) gqlErrs.push(`${op(reqById.get(e.id!))}: ${JSON.stringify(b.errors).slice(0, 160)}`); } catch { /* */ }
  }
}
console.log('## Server / network health');
console.log(`- non-2xx responses: ${httpErrs.length}`);
console.log(`- GraphQL error responses: ${gqlErrs.length}`);
gqlErrs.slice(0, 5).forEach((s) => console.log(`    - ${s}`));
if (httpErrs.length === 0 && gqlErrs.length === 0) console.log('  → clean: any client crash in this session is client-side, not server/network.');

// 2) Matchmaking abort-race
const searches = ev.filter((e) => op(e) === 'SearchOpponent');
const aborts = ev.filter((e) => op(e) === 'AbortSearching').map((e) => e.ts);
let raceCount = 0;
console.log('\n## Matchmaking abort-race signature');
for (const s of searches) {
  const ab = aborts.filter((a) => a >= s.ts && a - s.ts <= 2000).sort((a, b) => a - b)[0];
  const gap = ab != null ? ab - s.ts : null;
  const race = gap != null && gap <= 50;
  if (race) raceCount++;
  console.log(`  search ${at(s.ts)}  abort ${gap == null ? '—' : '+' + gap + 'ms'}  ${race ? '⚠ RACE-PRONE (abort within 50ms of an instant match)' : ''}`);
}
console.log(`  → ${raceCount}/${searches.length} matches are race-prone (instant bot-match + immediate AbortSearching).`);

// 3) Duplicate encrypted-question payloads
const encResp = ev.filter((e) => e.type === 'response' && (e.body || '').includes('encryptedQuestions')).length;
console.log('\n## Bandwidth waste');
console.log(`- responses carrying encryptedQuestions: ${encResp}  (expect ~1/duel; more = the triple-fetch)`);

// 4) Redundant identity / opponent fetches
console.log('\n## Redundant fetches');
console.log(`- GetCurrentUser: ${count('GetCurrentUser')}  (identity already returned by GoogleLogin)`);
console.log(`- GetUsers: ${count('GetUsers')}  (opponent already in UserMatchedEvent)`);
