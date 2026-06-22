# Matiks — a real-time duel engine + client data layer

A cross-platform real-time engine and a client data layer, built for Matiks' duel loop and grounded in measurements of the live app on a real budget Galaxy A13 (Perfetto thread/frame traces, Chrome DevTools traces, a CDP network capture).

## Issues found

**Performance**
- **Redundant network** — 184 identical GraphQL calls re-fire per session (~485 KB); a 26–33-call burst fires when the home screen mounts; no client-side query cache. (Static assets are cached; the GraphQL layer is not.)

**Integrity**
- **A bot can't be caught by correctness alone** — the question bank is decrypted client-side, so a script knows every answer and can submit *genuinely correct* answers at inhuman speed. A correctness check can't catch that; catching it needs behavioral/cadence detection.

## What was built

One shared TypeScript core + a thin per-platform shim, speaking the existing `{type, channel, data}` WebSocket. The server is unchanged.

```
                shared core  (TypeScript, 40 tests)
        codec · prediction + reconciliation · duel reducer
         │                      │                         │
    DATA LAYER             NATIVE shim                WEB shim
  dedup·cache·batch     Nitro module (C++/JSI)    WebSocket in a Worker
   (over Apollo)         (off the JS thread)       (off the main thread)

   SERVER-SIDE CHECK — flags superhuman answer cadence (bots)
```

- **Data layer** — dedupes in-flight requests, caches slow-changing queries (per-query TTL; live data never cached), batches same-tick calls into one (`BatchHttpLink`-style). → redundant network
- **Prediction + reconciliation** — answers score on screen instantly, then the server confirms. The bank is local so the guess is right ~always → rollbacks ≈ 0. → laggy answers on slow networks
- **Off-thread decrypt (native)** — built and measured on a real device: the AES decrypt runs in the Nitro module on a background thread. The measurement *is* the result — it's what found the bridge, not the crypto, to be the real cost (below). The socket transport targets the same swappable `Transport` interface (a native thread; a Worker on web) — written, not yet run end-to-end.
- **Bot/cadence detection** — the server flags sustained superhuman answer cadence and voids the run. A correctness check can't catch a bot here (the answers are real); behavioral detection can. → bots

**Native shim** — a Nitro module (Margelo's JSI framework on RN's New Architecture; a faster alternative to TurboModules). Matiks' APK already ships Nitro — one more module in a running toolchain.

**Native ≠ automatic win** — JSI drops serialization, but copying the bank into JS values is still JS-thread work: ~685 ms vs ~4 ms for the decrypt. So the real match-start fix is the data path, not faster crypto. If profiling ever justified going further, the bridge itself is beatable — keep the decrypted bank in native state and hand JS one question at a time, so the cost amortizes across the match instead of spiking in the countdown. An architecture to reach for on evidence, not by default.

## How it was tested
- 40 passing unit tests (`npm test`).
- Real captured traffic replayed through the data layer.
- Prediction validated against a simulated link at WiFi/4G/3G-representative latencies (30/90/260 ms one-way).
- The AES-decrypt Nitro module cross-compiled and run on a real Galaxy A13.
- A playable on-device demo — a live duel (with a Cheat button the server flags as a bot and voids) plus the off-thread-decrypt A/B/C harness. Its spinner is driven by `requestAnimationFrame` (which runs on the JS thread), so it stalls exactly when the thread is blocked — making JS-thread availability directly visible, not inferred.

## Results

| Metric | Today | With the fix |
|---|---|---|
| GraphQL round-trips / session | 355 | **195 (−45%)** |
| Felt answer latency on mobile data | ~260 ms | **0 ms** |

Against a simulated link at representative latencies, felt answer latency stays 0 ms (the answer renders locally) and rollbacks stay 0 (the answer bank is local, so the prediction is right):

| Network | Simulated RTT | Naive (wait for server) | With prediction |
|---|---|---|---|
| WiFi | 30 ms | ~35 ms | **0 ms** |
| 4G | 90 ms | ~95 ms | **0 ms** |
| 3G / mobile data | 260 ms | ~263 ms | **0 ms** |

<p align="center">
  <img src="assets/duel-bot-detection.png" width="270" alt="The engine flags a bot's superhuman cadence mid-duel and voids the run, on the A13">
  &nbsp;&nbsp;&nbsp;
  <img src="assets/decrypt-abc.png" width="270" alt="On-device A/B/C: decrypt on the JS thread vs off the JS thread">
</p>
<p align="center"><sub><b>Left:</b> the engine catches a bot (superhuman answer cadence) mid-duel and voids the run — on the A13. &nbsp;&nbsp; <b>Right:</b> the on-device A/B/C decrypt test that found the bridge, not the decrypt, is the wall.</sub></p>

## Setup
```bash
npm test                          # 40 passing tests
cd demo && npx expo run:android   # the playable duel + off-thread-decrypt demo
```

*Built by Vacha.*
