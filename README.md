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
`npm test` → **47 passing tests**. `node bench/replay-launch.ts <capture>` replays your real traffic. `node bench/scenarios.ts` runs the network/clock/integrity cases below. The engine ran a **playable duel on the Galaxy A13**.

## Before → after

**Network (replayed on your real capture, ~16-min session)**
```
355 GraphQL calls  →  195 HTTP round-trips   (−45%)
```

**Prediction — felt latency per answer (measured)**

| Network | Round-trip | Naive (wait for server) | With prediction |
|---|---|---|---|
| WiFi | 30 ms | ~35 ms | **0 ms** |
| 4G | 90 ms | ~95 ms | **0 ms** |
| 3G / mobile data | 260 ms | ~263 ms | **0 ms** |
| congested | 460 ms | ~462 ms | **0 ms** |

0 rollbacks on every network (answer correctness is deterministic).

**Monotonic clock — a wall-clock correction mid-duel**
```
real 800 ms answer →  Date.now(): −200 ms (corrupt)  |  monotonic: 800 ms (correct)
```

**Integrity — bot detection**
```
bots flagged: 100%   honest players flagged: 0%   (threshold 350 ms)
```

*Built by Vacha. Happy to walk through any of it.*
