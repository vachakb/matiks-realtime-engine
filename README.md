# Matiks — a real-time duel engine + client data layer

A cross-platform engine and client data layer for Matiks' duel loop — built from a teardown of the live app, not guesses. Every number below traces to a capture or an on-device run.

## How it was investigated

| Probe | Tool | What it showed |
|---|---|---|
| Live network | Chrome DevTools + CDP capture | a redundant GraphQL fan-out; no client-side query cache |
| Thread + frames | Perfetto, on a real Galaxy A13 | JS thread saturated while the GPU sits idle — a compute bottleneck, not graphics |
| APK teardown | unzip + native-symbol scan | New Architecture in prod — ships Nitro (`libNitroModules`, `NitroMmkv`…) on Fabric + JSI |
| Security model | browser-console WebSocket MITM | the server re-checks correctness — a forged result is rejected |

## What it found

**Performance**
- **Redundant network** — 184 identical GraphQL calls re-fire per session (~485 KB); a 26–33-call burst on home-screen mount; static assets are cached, the GraphQL layer isn't.
- **One overloaded thread** — in the captured trace, 97% of frames janky while the GPU sits at ~3.5% and 7 CPU cores idle. The single JS thread is the wall — not graphics.

**Integrity — tested, not asserted**
- *Hypothesis:* the client reports its own score, so a forged "I won" should stick. → **Probed with a WebSocket MITM → the server rejected it.** Claim dropped.
- *What is real:* the bank is decrypted client-side, so a script knows every answer and can submit *genuinely correct* answers at inhuman speed. A correctness check can't catch that — only cadence/behavioral detection can.

## What was built

One shared TypeScript core + a thin per-platform shim, over the existing `{type, channel, data}` WebSocket. Server unchanged. Zero runtime dependencies.

```
                shared core  (TypeScript, 40 tests)
        codec · prediction + reconciliation · duel reducer
         │                      │                         │
    DATA LAYER             NATIVE shim                WEB shim
  dedup·cache·batch     Nitro module (C++/JSI)    WebSocket in a Worker
   (over Apollo)         (off the JS thread)       (off the main thread)

   SERVER-SIDE CHECK — flags superhuman answer cadence (bots)
```

- **Data layer** — in-flight dedup + per-operation TTL cache (live data never cached) + same-tick batching (`BatchHttpLink`-style); TTLs derived from the capture. → redundant network
- **Prediction + reconciliation** — Gambetta/Valve netcode: the answer scores on screen instantly, the server confirms, a mismatch rolls back. The bank is local, so rollbacks ≈ 0. → instant answers on any network
- **Bot/cadence detection** — the server flags sustained superhuman answer cadence and voids the run — the only thing that catches a correct-but-superhuman bot. → bots
- **Off-thread decrypt (native)** — AES decrypt in the Nitro module on a background thread; built + measured on-device, where the measurement became the finding (below). The socket transport targets the same swappable `Transport` interface — written, not yet run end-to-end.

**Core internals** — deterministic duel reducer · pluggable JSON/msgpack codec · inbound-frame coalescing · reconnect + resubscribe. The **40 tests** cover prediction rollback, reconnection + offline queue, dedup/TTL/batching, and the cadence flag.

**Native shim** — a Nitro module (Margelo's JSI framework; a faster alternative to TurboModules). The APK teardown shows Matiks already ships Nitro — so this is one more module in a running toolchain.

**Native ≠ automatic win** — JSI drops serialization, but copying the bank into JS values is still JS-thread work: **~685 ms vs ~4 ms** for the decrypt itself. So the match-start lever is the data path, not faster crypto. If profiling ever justified going further: keep the decrypted bank in native state and hand JS one question at a time, so the cost amortizes across the match instead of spiking. An architecture to reach for on evidence, not by default.

## How it holds up
- **40 passing tests** on a zero-dep core (`npm test`).
- Real captured traffic replayed through the data layer → the −45% below.
- Prediction validated against a simulated link at WiFi/4G/3G latencies (30/90/260 ms).
- The Nitro decrypt cross-compiled and run on a real Galaxy A13.
- A **playable on-device demo** — a live duel (with a Cheat button the server flags and voids) and the decrypt A/B/C harness. Its spinner runs on the JS thread, so it stalls exactly when the thread blocks: JS-thread availability is visible, not inferred.

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
