# 16 — Client data layer, measured against the real capture

Phase A of the duel runtime: a drop-in client data layer that removes redundant network work. Every number here is replayed from a **real Matiks CDP capture** (`tools/`/`reports/06`), and it **corrects two earlier overstatements** — measuring beats asserting.

## What the real traffic actually shows (corrected)

Analyzed 4 captures (cold launch + live sessions), Matiks API only (analytics excluded):

- **Cold-launch fan-out is real:** the cold-start capture fired **33 API calls in the first 1.5 s**; the densest 2 s GraphQL window is **26–32 calls** in every session.
- **Redundant GraphQL is the big waste:** **184 identical `operationName`+`variables` calls were re-fired** in one session (~485 KB) — `GetUserTodayQuest` ×20, `GetCurrentUser` ×16, `CheckUserStreakStatus` ×15, leaderboards/quests/contests… GraphQL POSTs aren't HTTP-cacheable, and there's no client-side query cache, so they all hit the network.
- **Correction 1 — static assets *are* cached.** Earlier notes said "zero `cache-control` on any response." Not true: images/static GETs ship `public,max-age=3600,immutable` and **0 GETs lack cache-control**. The gap is specifically the GraphQL query layer.
- **Correction 2 — the launch "fan-out" is the home-screen load,** not necessarily the first 1.5 s of every capture; it's real but lands when the dashboard mounts.

## What we built (`src/data/`)

A framework-agnostic `RequestGateway` that wraps any fetcher (drops in over Apollo as a link, or plain fetch). Two safe, measured levers:

1. **In-flight dedup** — identical requests issued before the first resolves share one network call. Always behavior-preserving.
2. **Tunable TTL cache** (`OperationTtlPolicy`) — per-operation TTLs, default **0 = never cache**, so live data (e.g. `GetGameByIdV2` duel state) is always fresh while slow-changing user/meta queries are reused. `MATIKS_QUERY_TTL_MS` is a starting ruleset derived from the capture.
3. **Request batching** (`RequestBatcher`) — coalesces GraphQL ops fired in the same tick into ONE batched HTTP request (Apollo `BatchHttpLink`-style). This is the only lever that helps the cold-launch burst of *distinct* queries, which dedup/cache can't. Requires the server to accept an array of operations (Apollo Server does by default).

Everything is counted (`metrics.bytesSaved`, calls networked vs deduped vs cache-hit, batched round-trips) so the win is measurable, not claimed. **9 unit tests pass** (`node --test test/data.test.ts`): dedup, TTL hit/expiry, no-cache default, error-not-cached, stable GraphQL keying, metrics, + batching (one-tick collapse, positional routing, separate-tick separation).

## Proof — replay of real captured traffic

Replaying a full real session capture through the data layer (the capture is kept private — it holds tokens/PII):

```
Replayed 355 real GraphQL calls over 956s (MATIKS_QUERY_TTL_MS policy)
  BEFORE : 355 network calls, 1474 KB
  AFTER  : 274 network calls, 1373 KB
  SAVED  : 81 calls (23%), 100 KB
  Top collapsed: GetUserTodayQuest 21→8, GetRewardsByIDs 16→3, GetCurrentUser 17→9,
                 CheckUserStreakStatus 16→8, GetDailyChallenges 10→2 …
```

**81 fewer round-trips per ~16-min session from the cache lever alone**, conservatively tuned, with live game data never cached. On top of that, **request batching** (50 ms window) collapses the calls that still hit the network:

```
  + request batching (50ms window, max 25/batch):
    network HTTP round-trips: 274 calls → 195 batched requests
    (no caching, batching alone:  355 calls → 214 batched requests)
```

**End-to-end: 355 GraphQL calls → 195 HTTP round-trips per session (−45%).** Cache removes redundant re-polls; batching flattens the cold-launch burst of distinct queries. Across ~2.84 M users that is millions of fewer HTTP round-trips/day (server cost + scale) and less battery/latency on the low-end Indian networks this app targets — every session, invisibly.

## Honest scope

- Two distinct levers, both built: **cache/dedup** removes steady-state repeats; **batching** flattens the cold-launch burst of distinct queries. They compose (cache first, batch the remainder).
- We only collapse **identical** `op`+`variables` within a TTL, so **intentional polling of changing data is preserved** — the 23% is deliberately conservative.
- The TTLs are starting points; a team tunes them against their own freshness needs. The mechanism, the tests, and the measurement are the deliverable.
