# Matiks — real-time duel engine + on-device performance teardown

A teardown of the live Matiks app on a budget Galaxy A13 (Perfetto + logcat), plus an engine and a
demo that reproduce and fix what the trace shows. Every number is measured. Two sources, never
mixed: **[live app]** = the shipped `com.matiks.app`; **[reproduction]** = the A/B demo on the same A13.

## What's wrong, technically  [live app]

The duel is **single-thread compute-bound, not graphics-bound — and the hardware isn't the limit.**

- **The app never idles.** A full render pipeline runs ~60×/sec *continuously* — ~590 `doFrame`/10 s in **every** bucket of the 220 s trace, including idle stretches with **0 text changes**. Frames are being produced for nothing.
- **One JS thread does everything.** 94.6% busy at match start, 40% in play, **91% of frames janky**, GPU ~idle, 7 CPU cores idle. The wall is compute on a single thread, not the GPU.
- **State changes re-render the whole screen.** At match start: a single **820 ms** Fabric `traversal` + `MountItemDispatcher` churn — the 2–3 s "stuck on starting" freeze.
- **A session-replay SDK runs on the UI thread.** Microsoft Clarity captures frames for **~4.2 s** of UI-thread time *mid-duel*.
- **GC churn.** ART GC daemon at **~12%** during the freeze.
- **It's not the phone.** **55% of CPU sat idle** during the freeze, clocks free. (And typing isn't the load — only **47** input events in 220 s.)

## What was tried → what worked  [reproduction]

Reproduce Matiks' exact mechanism — **timer-based** (most-correct-before-the-clock; no answers after time's up) with a **typed auto-evaluating input** — and A/B two render strategies on the same A13:

- **Naive** — one component, a per-frame `requestAnimationFrame` + `setState` countdown → the whole screen re-renders ~60×/s.
- **Engine** — store that notifies only on real change (idle when static), slice subscriptions with stable identities, a native-driver timer → the JS thread idles between updates.

| Metric | Naive | Engine |
|---|---|---|
| Expensive subtree re-renders | 2,869 | **16** |
| JS-thread CPU | 79.3% | **30.9%** |
| RenderThread CPU | 55.8% | **42.8%** |
| Dropped frames (>33 ms) | 396 | **203** |

**Worked:** taking rendering and animation off the per-frame JS path. The expensive subtree renders once instead of ~2,900 times; the JS thread is freed (79% → 31%).

**Didn't (and why it matters):**
- A first pass kept a perpetual Reanimated animation in the "fixed" build, so it never idled — frames got *worse* (694 dropped). The win isn't moving a forever-animation to another thread; it's **not animating when nothing changes**.
- Reanimated 4 cost **~2× more per frame** than the built-in `Animated` native driver on this 32-bit device → use built-in `Animated` for a simple countdown here.
- Moving the AES decrypt off the JS thread: **4.7 s → 0.69 s**, but the residual is JSI **bridge marshaling**, not the AES — off-threading helps, it doesn't zero the cost.

## Limits

The reproduction proves the fix *pattern* on the same hardware; it does not prove these are the exact
root causes inside the shipped app — that needs the source or a profileable build. Pausing Clarity or
shipping the fixes also needs the app source; the engine exposes an `onPhase('active'|'ended')` hook
for the app to gate non-essential UI-thread work during a match.

## The engine

A shared TypeScript core + a thin per-platform shim over the existing `{type, channel, data}`
WebSocket. Server unchanged. Zero runtime dependencies.

- **Store** — `useSyncExternalStore`-shaped; notifies only on change (idle when static); slice subscriptions; phase lifecycle
- **Prediction + reconciliation** — the answer scores instantly; the bank is local, so rollbacks ≈ 0
- **Native** — AES decrypt off the JS thread, a Nitro/JSI module built and measured on-device ([`/modules/react-native-matiks-realtime`](modules/react-native-matiks-realtime))
- **Data layer** — in-flight dedup + per-operation TTL cache + same-tick batching
- **Bot/cadence detection** — flags sustained superhuman answer cadence (a correctness check can't catch a fast-correct bot)

**49 tests** on the zero-dependency core.

## Setup

```bash
npm test                          # 49 passing tests
cd demo && npx expo run:android   # playable duel A/B (Naive vs Engine) + off-thread-decrypt
```

*Built by Vacha.*
