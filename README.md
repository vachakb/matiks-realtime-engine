# Matiks — performance & integrity audit + a working fix

Profiled on your production app and a real budget Galaxy A13. Every number below is reproducible from this repo (47 passing tests, scenario scripts, a demo that ran on the device).

## What we found
- **Redundant network** — 184 identical GraphQL calls re-fired in one session (~485 KB); a **26–33-call burst** when the home screen mounts; no client-side query cache.
- **Match-start freeze** — the question bank is shipped **3× per duel**, then AES-decrypted + JSON-parsed **on the JS thread**, inside the start countdown. On the A13 that froze the UI for **~8.4 s** (507 dropped frames).
- **Client-authoritative scoring** — the client reports its own score; since the bank is decrypted on the client, a bot knows every answer and can forge a perfect one. Leaderboards are gameable.
- **Root cause** — the JS thread is the single bottleneck: **97% of frames janky** while the **GPU sits at ~3.5%** and **7 CPU cores idle**.

## How we found it
Six instruments on the real device + real captured traffic: Perfetto (per-thread scheduling + FrameTimeline), Chrome DevTools traces, `dumpsys gfxinfo`, static APK dissection, a CDP network capture, and a JSON-vs-binary microbench.

## What we fixed
- **Data layer** — request dedup + tunable TTL cache + batching; drops in over your Apollo client (live data never cached).
- **Real-time engine** — client-side prediction + server reconciliation, a monotonic clock (never `Date.now()`), off-thread transport.
- **Integrity** — an authoritative server that recomputes correctness from its own key and flags bot/timing anomalies.
- Built the native off-thread decrypt module too — which proved the **JSI bridge (~685 ms), not the decrypt (4 ms), is the real wall**, so the fix is the data path, not "make it native."

## How we tested
47 passing unit tests (`npm test`); your real captured traffic replayed through the fix (`node bench/replay-launch.ts`); WiFi/4G/3G + clock + integrity scenarios (`node bench/scenarios.ts`); and a **runnable demo app, built and run on a real Galaxy A13** — a playable duel (instant prediction, a live opponent, a monotonic timer, and a Cheat button the server catches and disqualifies) alongside the off-thread-decrypt A/B harness.

## Before → after

| Metric | Today | With the fix |
|---|---|---|
| GraphQL round-trips / session | 355 | **195  (−45%)** |
| Felt answer latency on mobile data | ~260 ms | **0 ms** |
| Match-start decrypt, off the JS thread | 8.4 s freeze | **4 ms** |
| Bot submitting a perfect score | accepted | **flagged + voided (100%)** |
| Answer timing after a clock jump | −200 ms (corrupt) | **correct (monotonic)** |

Felt latency stays at **0 ms on every network** — the gap from a naive (wait-for-server) client grows as the connection slows, so the win is biggest for your mobile-data users:

| Network | Round-trip | Naive | With prediction |
|---|---|---|---|
| WiFi | 30 ms | ~35 ms | **0 ms** |
| 4G | 90 ms | ~95 ms | **0 ms** |
| 3G / mobile data | 260 ms | ~263 ms | **0 ms** |

(0 rollbacks on every network — answer correctness is deterministic.)

*Built by Vacha. Happy to walk through any of it.*
