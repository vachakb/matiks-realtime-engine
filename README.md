# Matiks — a measured performance & integrity audit, and a working fix

An unsolicited, evidence-based teardown of the live Matiks app — profiled on **your production build and a real budget Galaxy A13** (a top-selling India device) — and a **built, tested, on-device fix** for what we found. Every number below is reproducible from this repo: 47 passing tests, a runnable demo that ran on the A13, and scenario scripts you can re-run yourself.

---

## TL;DR

Three things are hurting real users. We measured each on your live app + a real low-end device, then built, tested, and **ran the fixes on that device.**

| What we found (measured) | What we built | Before → after |
|---|---|---|
| **Redundant network.** 184 identical GraphQL calls re-fired per session; a 26–33-call burst when the home screen mounts; no client query cache. | **Data layer** — request dedup + tunable TTL cache + batching, dropping in over your Apollo client. | **355 → 195 HTTP round-trips/session (−45%)**, replayed from your real capture. |
| **Match-start freeze.** The encrypted question bank is fetched + AES-decrypted + JSON-parsed **on the JS thread**, inside the synchronized-start countdown. | **Native off-thread decrypt** (proven) + the real fix: **stop client-decrypting the bank mid-countdown.** | Off-thread decrypt **4 ms** on the A13; we proved the JSI **bridge**, not the decrypt, is the wall. |
| **Client-authoritative scoring.** A bot that knows the answers (the bank is on the client) can submit a perfect score; leaderboards/leagues are gameable. | **Server-authoritative engine** — the server recomputes correctness + flags bot cadence. | **100% of bots flagged, 0 honest players** flagged. |

The thread tying all three together: on this device, **the JS thread is the single bottleneck** — 97% of frames janky while the **GPU sits at ~3.5%** and **7 CPU cores idle**. It's not a graphics problem; it's everything piled on one thread at the wrong moments.

---

## 1. What we found (exact)

Profiled with six instruments — Perfetto (per-thread scheduling + FrameTimeline), Chrome DevTools traces, `dumpsys gfxinfo`, static APK dissection, a CDP traffic capture, and a JSON-vs-binary microbench.

**① The network does redundant work, worst on mobile data.**
From your real captured traffic (analytics excluded):
- **184 GraphQL calls re-fired identical** `operationName`+`variables` in one session (~485 KB) — `GetUserTodayQuest` ×20, `GetCurrentUser` ×16, `CheckUserStreakStatus` ×15, leaderboards/quests/contests…
- The home screen mounts a **burst of 26–33 distinct GraphQL calls in ~2 s** (33 in the first 1.5 s of a cold launch).
- GraphQL POSTs aren't HTTP-cacheable and there's **no client-side query cache**, so every repeat is a fresh round-trip. *(Correction we made after measuring: static assets **are** already cached `max-age=3600,immutable` — the gap is specifically the query layer.)*

**② Match start freezes the JS thread.**
The whole question bank is shipped (51 KB, **3× per duel**), then AES-decrypted + JSON-parsed **synchronously on the JS thread**, *inside* the ~3.5 s synchronized-start countdown — so a slow phone can start a timed duel already behind. On the A13 a pure-JS decrypt of 75 questions froze the UI for **~8.4 s** (507 dropped frames) in our harness.

**③ Scoring is client-authoritative.**
The client tells the server its score. Because the bank is decrypted on the client, a bot knows every answer — so a perfect, instant score is trivially forgeable. For an app whose core loop is **competitive leagues + ratings**, that makes the leaderboard the weakest link.

---

## 2. What we built (architecture)

One shared, platform-agnostic TypeScript core — written once, tested in Node, and dropped onto each platform through a thin shim. It mirrors your existing `{type,channel,data}` WebSocket contract, so **the server never has to change.**

```
            ┌──────────────── shared core (TypeScript, 47 tests) ────────────────┐
            │  codec · monotonic clock-sync · prediction + reconciliation · duel   │
            └─────────────────────────────────────────────────────────────────────┘
                 ▲                          ▲                           ▲
          DATA LAYER                  NATIVE shim                   WEB shim
     dedup · TTL cache · batch    Nitro/JSI on a C++ thread     WebSocket in a Worker
     (wraps your Apollo)          (off the JS thread)           (off the main thread)

          AUTHORITATIVE SERVER MODEL (integrity)
     recomputes correctness from its own key · flags bot/timing anomalies · voids cheats
```

- **Data layer** (`src/data/`) — a `RequestGateway` (in-flight dedup + per-operation TTL cache, default *never cache* so live data stays fresh) + a `RequestBatcher` (coalesces same-tick queries into one request, like Apollo `BatchHttpLink`). Drops in over Apollo as a link.
- **Real-time engine** (`src/core/`) — client-side **prediction + server reconciliation** (Gambetta/Valve model), a **monotonic clock** (NTP-style sync over your existing PING_PONG channel, anchored to `performance.now()` — never `Date.now()`), a binary codec, and inbound coalescing. `submitAnswer()` returns **synchronously** so the UI is instant.
- **Integrity** (`src/sim/server.ts`) — an authoritative server model that recomputes correctness from its own answer key and flags superhuman answer cadence, voiding the score. The client only learns it's flagged via the snapshot.
- **The native module** (`demo/modules/react-native-matiks-realtime/`) — a real Nitro HybridObject. We built it, ran it on the A13, and it taught us *where* off-threading pays off (see §5).

---

## 3. Before → after (exact, with network conditions)

Run it yourself: `node bench/scenarios.ts` and `node bench/replay-launch.ts <your-capture.jsonl>`.

**Data layer — replayed on your real capture (≈16-min session):**
```
BEFORE : 355 GraphQL calls,  1474 KB
AFTER  : 195 HTTP round-trips (−45%)   ← dedup + TTL cache + batching, live data never cached
```
Cache collapses the re-polls (`GetUserTodayQuest` 21→8, `GetRewardsByIDs` 16→3, `GetCurrentUser` 17→9…); batching flattens the launch burst.

**Prediction — felt latency per answer (measured on the engine):**

| Network | Round-trip | Naive (wait for server) | With prediction | Rollbacks |
|---|---|---|---|---|
| WiFi | 30 ms | ~35 ms | **0 ms — instant** | 0 |
| 4G | 90 ms | ~95 ms | **0 ms** | 0 |
| 3G / mobile data | 260 ms | ~263 ms | **0 ms** | 0 |
| congested / edge | 460 ms | ~462 ms | **0 ms** | 0 |

Your answer scores the instant you tap, on every network; a naive client lags by a full round-trip. Rollbacks stay **0** because answer correctness is deterministic (the client already has the question) — so going server-authoritative for anti-cheat costs **no** felt latency.

**Monotonic clock — a wall-clock correction mid-duel:**
```
answer   true gap   Date.now() gap                              monotonic gap
2        800ms      -200ms  ← CORRUPT: answered in negative time   800ms
```
One NTP/throttle correction makes a real 800 ms answer register as **−200 ms** under `Date.now()` — corrupting a *timed* duel's scoring. The monotonic clock can't go backwards.

**Integrity — detection vs false-positives (threshold 350 ms):**
```
human — fast (450ms)   ✓ clean      BOT — instant (30ms)    🚩 flagged, voided
human — avg  (900ms)   ✓ clean      BOT — throttled (150ms) 🚩 flagged, voided
human — slow (1800ms)  ✓ clean
```
100% of bots flagged, 0 honest players — no human sustains sub-350 ms mental-math answers.

---

## 4. What this means for your users

- **Faster open, especially on mobile data.** Collapsing the launch burst from a wave of round-trips into one or two — and caching the re-polls — cuts the home-screen network wait most on slow links, which is the India reality. ~45% fewer round-trips × ~2.84 M users is millions of fewer calls/day (server cost + scale) and less battery/data per session.
- **Fair, instant duels on any network.** On 4G/3G a naive client feels 90–460 ms of lag *per answer*; prediction keeps it at 0. In a timed duel, that lag is lost points — and it disproportionately punishes your mobile-data users.
- **Trustworthy competition.** Server-authoritative scoring + a monotonic fair clock means leagues, ratings, and leaderboards can't be gamed by a bot or a clock glitch — the credibility your competitive core (and monetization) depends on.

---

## 5. Honesty — what's measured, what we walked back

Trust is the point, so here's the line between measured and modeled:
- **6 instruments, real device + real capture.** Native architecture (Hermes, New Arch, Nitro) is confirmed from your shipped APK, not inferred.
- **We built the native module and it changed our own conclusion.** On the A13 the off-thread decrypt is **4 ms** — but the JSI **payload marshaling** is a **~685 ms** JS-thread cost (release build), and packing it into one bridge crossing didn't help. So "make the decrypt native" fixes the wrong 1%; the real fix is the **data path** (don't client-decrypt the bank at match start). The module is a real win *and* the instrument that proved this (`reports/15`).
- **Three claims we walked back after measuring:** msgpack is only a *modest* ~10% on this traffic (the real size lever is `permessage-deflate`); the "felt latency" win is partly hidden today by optimistic UI (prediction's real value is enabling anti-cheat *without* latency); and "zero cache-control everywhere" was wrong — static assets are cached, the query layer isn't.
- **What's modeled, not measured:** the per-network *wall-clock launch time* (round-trips × RTT, parallelism assumed). The round-trip counts, prediction latency, clock behavior, and bot detection are all measured.
- **What we deliberately did NOT build:** a reconnection layer (yours is already mature), a WS-protocol replacement, or a C++/Rust core you'd have to maintain. Every piece is modular — you can take one.

---

## Try it / reading order

```bash
npm test                       # 47 tests: prediction, reconciliation, clock, data layer, integrity
node bench/scenarios.ts        # the network / clock / integrity tables above
node bench/replay-launch.ts <capture.jsonl>   # the data-layer before/after on real traffic
cd demo && npx expo run:android               # the playable duel + off-thread-decrypt demo (ran on the A13)
```

| Start here | What it is |
|---|---|
| **this README** | the diagnosis + the fix + the numbers |
| `reports/16` | the data layer, measured on your real capture |
| `reports/15` + `13` | the native module on the A13 — and why the bridge, not the decrypt, is the wall |
| `reports/01` | the original device teardown (97% janky, JS-thread-bound) |

The runnable demo (`demo/`) is a single app with two screens: a **playable duel** (prediction, a live opponent, a monotonic timer, and a Cheat button that the server catches and disqualifies) and the **off-thread decrypt** A/B/C harness. It was built and run on the Galaxy A13.

*Built by Vacha. Happy to walk through any of it live.*
