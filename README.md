# Matiks — real-time duel engine + on-device performance teardown

A teardown of the live Matiks app across two captures — an **A13 Perfetto + logcat render trace**, and
an earlier **Chrome DevTools / CDP network capture + WebSocket MITM + APK teardown** — plus an engine
and a demo that reproduce and fix what they show. Every number is measured. **[live app]** = the
shipped `com.matiks.app`; **[reproduction]** = the A/B demo on the same A13.

## What's wrong, technically  [live app]

**Rendering / JS thread** (A13 trace) — single-thread compute-bound, not graphics-bound:
- **Never idles** — a full render pipeline runs ~60×/sec *continuously*: ~590 `doFrame`/10 s in **every** bucket, including idle stretches with **0 text changes**.
- **One JS thread does everything** — 94.6% busy at match start, 40% in play, **91% of frames janky**, GPU ~idle, 7 CPU cores idle.
- **State changes re-render the whole screen** — an **820 ms** Fabric `traversal` + `MountItemDispatcher` churn at match start (the 2–3 s "stuck on starting" freeze).
- **Session-replay on the UI thread** — Microsoft Clarity captures frames for **~4.2 s** of UI-thread time mid-duel.
- **GC churn** — ART GC daemon at **~12%** during the freeze.
- **Not the phone** — **55% of CPU idle** during the freeze, clocks free. (Typing isn't the load — 47 input events in 220 s.)

**Network & protocol** (CDP capture + WS MITM):
- **Redundant GraphQL** — 184 identical calls/session (~485 KB); a 26–33-call burst on home-screen mount; no client query cache (static assets are cached, the GraphQL layer isn't).
- **N+1** — the league list fires 4 identical `GetUnifiedContestParticipants` calls differing only by a `sortKey`; one fetch sorted client-side would do.
- **Stale subscriptions** — after a reconnect, the client re-subscribes to `GAME_EVENT`/chat channels for already-ended games.
- **Felt answer latency** — ~260 ms on mobile data: the answer waits for the server round-trip before it shows.

**Integrity** (APK teardown + WS MITM):
- The question bank is decrypted client-side, so a script knows every answer and submits *genuinely correct* answers at inhuman speed. A correctness check can't catch that — only answer-cadence detection can.

## What was tried → what worked

**Render A/B** [reproduction] — reproduce Matiks' exact mechanism (timer-based; typed auto-evaluating input) and A/B two render strategies on the same A13. Naive = one component, per-frame `requestAnimationFrame` + `setState` (whole screen re-renders); Engine = store that notifies only on change, slice subscriptions, native-driver timer (idles when static):

| Metric | Naive | Engine |
|---|---|---|
| Expensive subtree re-renders | 2,869 | **16** |
| JS-thread CPU | 79.3% | **30.9%** |
| Dropped frames (>33 ms) | 396 | **203** |

**Engine against the captured/real protocol:**

| Fix | Before | After |
|---|---|---|
| GraphQL round-trips / session — dedup + per-op TTL cache + same-tick batch | 355 | **195** |
| Redundant GraphQL transfer / session | ~485 KB | **~0** |
| Felt answer latency, mobile data — client prediction + reconciliation | ~260 ms | **0 ms** |
| Match-start AES decrypt on the JS thread — off-thread Nitro/JSI module | 4.7 s | **0.69 s** |
| Client-side-decrypt bot | uncatchable by correctness | **flagged by cadence, run voided** |

**Didn't (and why it matters):**
- A first render pass kept a perpetual Reanimated animation in the "fixed" build, so it never idled — frames got *worse* (694 dropped). The win is **not animating when nothing changes**, not moving a forever-animation to another thread.
- Reanimated 4 cost **~2× more per frame** than the built-in `Animated` native driver on this 32-bit device → built-in `Animated` for a simple countdown.
- Off-thread decrypt's residual is JSI **bridge marshaling**, not the AES (~4 ms compute) — off-threading helps, it doesn't zero the cost.

## Limits

"After" numbers are measured with the engine — the render A/B on the same A13, the GraphQL figures
against the captured traffic, latency against a simulated link, decrypt on-device — not a re-run of
the shipped app. The reproduction proves the fix *pattern* on the same hardware; confirming the exact
root cause in the shipped app (or pausing Clarity / shipping the fixes) needs the app source or a
profileable build. The engine exposes an `onPhase('active'|'ended')` hook for the app to gate
non-essential UI-thread work during a match.

## The engine

A shared TypeScript core + a thin per-platform shim over the existing `{type, channel, data}`
WebSocket. Server unchanged. Zero runtime dependencies.

- **Store** — `useSyncExternalStore`-shaped; notifies only on change (idle when static); slice subscriptions; phase lifecycle
- **Prediction + reconciliation** — the answer scores instantly; the bank is local, so rollbacks ≈ 0
- **Data layer** — in-flight dedup + per-operation TTL cache + same-tick batching (over Apollo/`fetch`)
- **Native** — AES decrypt off the JS thread, a Nitro/JSI module built and measured on-device ([`/modules/react-native-matiks-realtime`](modules/react-native-matiks-realtime))
- **Bot/cadence detection** — flags sustained superhuman answer cadence

**49 tests** on the zero-dependency core.

## Setup

```bash
npm test                          # 49 passing tests
cd demo && npx expo run:android   # playable duel A/B (Naive vs Engine) + off-thread-decrypt
```

*Built by Vacha.*
