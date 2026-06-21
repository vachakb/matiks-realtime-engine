# @matiks/realtime-engine

A cross-platform real-time game-sync engine for Matiks duels. **One shared core, two bodies:**
a Nitro/JSI module on native (socket on a dedicated native thread) and the same core in a Web
Worker on web (socket off the main thread), behind one identical TypeScript API. The server is
never touched — it speaks the same `{type, channel, data}` protocol it does today.

> This exists because of a measured problem, not a hunch. On a real Exynos-850 device during a
> live Blitz/DMAS duel: the **JS thread (`mqt_v_js`) was the busiest thread in the app at 39.7%
> on-CPU**, **90% of frames were janky** ("App Deadline Missed"), the **GPU was idle at 3.5%**,
> and **match start froze for ~652 ms** decrypting questions on the JS thread — all while 7 CPU
> cores sat idle. The bottleneck is one overloaded JS thread, not the device or the network.

## What it changes (and what it deliberately doesn't)

| Capability | Why | Evidence it's needed |
|---|---|---|
| **Off-thread transport + decode + decrypt** | The single highest-leverage fix | JS thread 39.7% on-CPU; 652 ms match-start decrypt freeze |
| **Client prediction + server reconciliation** | Instant feel *and* makes server-authoritative scoring viable | answer round-trip p50 270 ms; client-side `isCorrect` today = cheatable |
| **Monotonic clock-sync** (NTP via PING_PONG) | Fair timing in a *timed* duel | today timing uses `Date.now()` (non-monotonic) |
| **Inbound coalescing + bounded buffers** | Stop per-frame JS-thread floods / unbounded growth | no inbound batching today |
| **permessage-deflate for fat frames** | The real wire-size lever | `GAME_EVENT` −58%, `USER_EVENT` −42% (bench) |

**Deliberately unchanged** — Matiks already does these well, so the engine reuses the spirit and
doesn't "fix" them: their WebSocket reliability layer (exponential backoff, offline queue,
per-message acks, heartbeat, network-quality tiers) and their strong React memoization.

## Honest trade-offs (read this first)

- **msgpack alone is a *modest* ~10% wire win on their traffic** (it's PING_PONG-heavy, and on V8
  msgpack actually decodes *slower* than JSON.parse). The codec is pluggable and ships, but the
  honest size lever is **deflate** (above) and the honest CPU lever is **running decode off the
  thread**, not the format. The benchmark prints all of this.
- **Prediction's latency win is conditional.** Matiks likely already updates *your own* answer
  optimistically today, so you don't feel 270 ms *now*. Prediction's real value is letting them go
  **server-authoritative** (closing the bot-cheating hole) **without** introducing that 270 ms.
- **The native/web shims are integration scaffolding**, not yet compiled in an app. The **core**
  (`src/core/*`) is platform-agnostic and fully unit-tested in Node (`node --test`).

## Run it

```bash
node --test test/*.test.ts      # 32 unit tests, zero dependencies (Node >= 23.6)
node bench/run.ts               # replays the real captured frames -> before/after numbers
```

## Layout

```
src/core/        platform-agnostic, fully tested
  codec.ts         JSON + dependency-free MessagePack
  clock.ts         monotonic NTP-style clock sync
  ringbuffer.ts    bounded ring buffer + frame batcher (backpressure)
  prediction.ts    client-side prediction + server reconciliation (Gambetta model)
  duel.ts          deterministic Blitz/DMAS reducer (correctness known locally)
  transport.ts     Transport interface + MockTransport
  engine.ts        RealtimeEngine — orchestrates all of the above
src/native/      Nitro/JSI module spec + transport + C++ sketch (iOS/Android body)
src/web/         Web Worker + WorkerTransport (web body)
src/index.*.ts   platform entry points (Expo resolves .native.ts / .web.ts)
test/            edge-case unit tests
bench/           benchmark over real captured frames
```

## Design references
Valve "Source Multiplayer Networking" & Gabriel Gambetta "Fast-Paced Multiplayer" (prediction +
reconciliation), GGPO (rollback); Nitro Modules / `jsi::NativeState` (margelo); MessagePack.
