# Matiks — performance & integrity audit + fix

Audit of the live Matiks app — profiled on a real budget Galaxy A13 with Perfetto thread/frame traces, Chrome DevTools traces, and a CDP network capture — with built and tested fixes for what was found. Every number is reproducible from this repo.

## Issues found

**Performance**
- **Redundant network** — 184 identical GraphQL calls re-fire per session (~485 KB); a 26–33-call burst fires when the home screen mounts; no client-side query cache. (Static assets are cached; the GraphQL layer is not.)
- **Match-start freeze** — the question bank is fetched 3× per duel, then AES-decrypted + JSON-parsed on the JS thread, inside the start countdown. React Native runs all JS on one thread against a ~16.67 ms/frame budget; Hermes executes AOT bytecode with no JIT, so heavy crypto + parsing is slower there and blocks rendering. Result: an ~8.4 s freeze on the A13.
- **One overloaded thread** — that single JS thread is the bottleneck: 97% of frames janky while the GPU sits at ~3.5% and 7 CPU cores idle. Not a graphics problem.

**Integrity / correctness**
- **Client-authoritative scoring** — the client reports its own score. The question bank is decrypted client-side, so a bot knows every answer and can forge a perfect one. Leagues and leaderboards are gameable.
- **Timed scoring uses `Date.now()`** — a wall-clock correction (NTP / background resume) can register an answer at negative elapsed time, corrupting a timed duel.

**Bugs**
- **Web crash — "Cannot read properties of null (reading 'uattr')"** — an intermittent full-page crash. Root-caused to the WebEngage SDK reading `getForever().uattr` on a null store; a non-critical analytics tracker takes down the whole app. (`reports/17`)
- Two more reproducible client stability bugs documented in `reports/09` and `reports/11`.

## The fix

One shared TypeScript core, dropped onto each platform through a thin shim. It mirrors the existing `{type, channel, data}` WebSocket contract — the server is unchanged.

```
                shared core  (TypeScript, 47 tests)
   codec · monotonic clock-sync · prediction + reconciliation · duel reducer
         │                      │                         │
    DATA LAYER             NATIVE shim                WEB shim
  dedup·cache·batch     Nitro/JSI, C++ thread     WebSocket in a Worker
   (over Apollo)         (off the JS thread)       (off the main thread)

   AUTHORITATIVE SERVER MODEL — recomputes correctness · flags bots · voids cheats
```

Each mechanism, and the issue it closes:
- **Data layer** — `RequestGateway` (in-flight dedup + per-operation TTL cache, default never-cache so live data stays fresh) + `RequestBatcher` (coalesces same-tick queries into one request, like Apollo `BatchHttpLink`). → redundant network.
- **Prediction + reconciliation** — answers apply optimistically and return synchronously; an authoritative server snapshot rebases state and replays still-unacked inputs. Rollbacks are ≈0 because answer correctness is deterministic (the bank is local). → laggy answers on slow networks; also lets scoring go server-authoritative with no felt latency.
- **Monotonic clock** — NTP-style sync over the existing PING_PONG channel, anchored to `performance.now()`, never `Date.now()`. → timed-scoring corruption.
- **Off-thread transport** — JSI/Nitro invokes C++ directly, without the legacy bridge's JSON-serialized message queue, so transport + crypto run off the JS thread. Web uses a Worker. → JS-thread contention.
- **Authoritative server model** — recomputes correctness from its own answer key and flags superhuman answer cadence, voiding flagged scores. → client-authoritative scoring.

The non-obvious result (and why the native module was built): JSI removes *serialization*, but marshaling the decrypted question payload into JS values is still synchronous JS-thread work. Measured on the A13, the decrypt itself is ~4 ms off-thread while the bridge crossing is ~685 ms — so the real match-start fix is **not** shipping + decrypting the whole bank on the client mid-countdown, rather than simply "make the decrypt native."

## How it was tested
- 47 passing unit tests — prediction, reconciliation, clock, data layer, integrity.
- Real captured traffic replayed through the data layer.
- Network / clock / integrity scenarios across WiFi, 4G, and 3G.
- Native module cross-compiled and run on a real Galaxy A13.
- A playable on-device demo — a live duel plus the off-thread-decrypt A/B/C harness. Its spinner is driven by `requestAnimationFrame` (which runs on the JS thread), so it stalls exactly when the thread is blocked — making JS-thread availability directly visible, not inferred.

## Results

| Metric | Today | With the fix |
|---|---|---|
| GraphQL round-trips / session | 355 | **195 (−45%)** |
| Felt answer latency on mobile data | ~260 ms | **0 ms** |
| Match-start decrypt, off the JS thread | 8.4 s freeze | **4 ms** |
| Bot submitting a perfect score | accepted | **flagged + voided (100%)** |
| Timed answer after a clock jump | −200 ms (corrupt) | **correct** |

Felt latency holds at 0 ms on every network, with 0 rollbacks:

| Network | Round-trip | Naive (wait for server) | With prediction |
|---|---|---|---|
| WiFi | 30 ms | ~35 ms | **0 ms** |
| 4G | 90 ms | ~95 ms | **0 ms** |
| 3G / mobile data | 260 ms | ~263 ms | **0 ms** |

<p align="center">
  <img src="assets/duel-bot-detection.png" width="270" alt="Bot caught and score voided mid-duel on the A13">
  &nbsp;&nbsp;&nbsp;
  <img src="assets/decrypt-abc.png" width="270" alt="On-device A/B/C: decrypt on the JS thread vs off the JS thread">
</p>
<p align="center"><sub><b>Left:</b> a bot caught and its score voided mid-duel — on the real A13. &nbsp;&nbsp; <b>Right:</b> the on-device A/B/C decrypt test that found the bridge, not the decrypt, is the wall.</sub></p>

## Setup
```bash
npm test                                      # 47 tests
node bench/scenarios.ts                        # network / clock / integrity numbers
node bench/replay-launch.ts <capture.jsonl>    # data-layer before/after on real traffic
cd demo && npx expo run:android                # the playable demo, built + run on the A13
```

*Built by Vacha.*
