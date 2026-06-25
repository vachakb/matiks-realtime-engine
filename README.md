# Matiks — real-time duel engine + on-device performance teardown

A teardown of the live app, plus a runnable engine + demo. Numbers are tagged by source and never mixed:

- **[their app]** — measured in an on-device Perfetto + logcat trace of `com.matiks.app` on a budget Galaxy A13.
- **[demo]** — measured in this repo's demo on the same A13 (our engine vs a naive baseline).

## What their trace shows [their app]

The duel is **CPU/JS-bound, not graphics-bound — and the phone is not the limit.**

| Measured | Number |
|---|---|
| Frames janky (>16.7 ms) in play | **91%** |
| JS thread busy — match start / in play | **94.6% / 40%** (GPU idle) |
| Renders ~60 fps **even when idle** | ~590 `doFrame` / 10 s in every bucket; idle buckets = 0 text changes |
| Match-start freeze | one **904 ms** frame; **820 ms** view `traversal` + Fabric mount churn |
| Session-replay (Microsoft Clarity) on the UI thread | **~4.2 s** of UI-thread time, mid-duel |
| ART GC during the freeze | **~12%** |
| CPU **idle** during the freeze | **55%**, clocks free → not the phone |
| Input events in 220 s | **47** → typing isn't the load |

*Redundant GraphQL (184 repeat calls/session; 26–33-call home-mount burst) is from an earlier network capture, not re-verified here.*

## A demo that fixes this class of problem [demo]

Same mechanism as Matiks — **timer-based** (most-correct-in-time wins; no answers after the clock) with a **typed auto-evaluating input**. A toggle runs two render strategies on identical play:

- **Naive** — one component, per-frame `setState` → the whole screen re-renders continuously.
- **Engine** — idle-when-static store, slice subscriptions, native-driver timer → the screen idles when nothing changes.

Same A13, same person playing both (scored 56 vs 60):

| | Naive | Engine |
|---|---|---|
| Expensive subtree re-renders | 2,869 | **16** |
| JS-thread CPU | 79.3% | **30.9%** |
| RenderThread CPU | 55.8% | **42.8%** |
| Dropped frames (>33 ms) | 396 | **203** |

Measured separately on the A13: an AES decrypt moved off the JS thread = **4.7 s → 0.69 s**.

> This proves the *pattern* and its fix on their hardware. It does **not** prove these are the root causes inside their app.

## What adopting it needs (their source)

We can't read their code or profile a release build at function level, so we can't, and don't claim to:

- identify *which* element drives their always-on 60 fps render (a JS-ticked timer? a Lottie? a shimmer?);
- pause Clarity during a duel — the engine exposes an `onPhase('active'|'ended')` hook, but only the app can call into the SDK;
- ship any of this into the live app.

What the engine offers is drop-in: a `useSyncExternalStore`-shaped store (idle + slices), a match `deadline` for native-driver timing, an off-thread decrypt module, and a server-side cadence flag for bots.

## The engine

One shared TypeScript core + a thin per-platform shim over the existing `{type, channel, data}` WebSocket. Server unchanged. Zero runtime dependencies.

- **Store** — notifies only on real change (idle when static); slice subscriptions with stable identities; phase lifecycle
- **Prediction + reconciliation** — the answer scores instantly; the bank is local, so rollbacks ≈ 0
- **Native** — AES decrypt off the JS thread (Nitro/JSI), built and run on-device
- **Data layer** — in-flight dedup + per-operation TTL cache + same-tick batching (over Apollo/`fetch`)
- **Bot/cadence detection** — flags sustained superhuman answer cadence (a correctness check can't catch a fast-correct bot)

**49 tests** on the zero-dependency core.

## Setup

```bash
npm test                          # 49 passing tests
cd demo && npx expo run:android   # playable duel A/B (Naive vs Engine) + off-thread-decrypt
```

*Built by Vacha.*
