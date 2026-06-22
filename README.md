# Matiks — profiled, fixed, and run on a real device

We took your live app apart on a **real budget Galaxy A13**, built the fixes, and **ran them on that same phone**. Most audits stop at a flamegraph — we shipped working code and let the measurements correct us: our first instinct (make the match-start decrypt native) turned out to fix the wrong 1%, so we dug until we found the real bottleneck. Every number below is reproducible from this repo.

| Metric | Today | With the fix |
|---|---|---|
| GraphQL round-trips / session | 355 | **195  (−45%)** |
| Felt answer latency on mobile data | ~260 ms | **0 ms** |
| Match-start decrypt, off the JS thread | 8.4 s freeze | **4 ms** |
| Bot submitting a perfect score | accepted | **flagged + voided (100%)** |
| Answer timing after a clock jump | −200 ms (corrupt) | **correct** |

---

## Three problems — what we found, how we fixed it, what it changes for you

### 1. The network does the same work over and over
- **Found** — 184 *identical* GraphQL calls re-fired in one session (~485 KB); a **26–33-call burst** when the home screen mounts; no client-side query cache. *(Measured by replaying your real captured traffic.)*
- **Fixed** — a data layer: request **dedup + tunable TTL cache + batching**, dropping in over your Apollo client (live data is never cached).
- **Changes for you** — **−45% round-trips/session.** Faster opens and less data — the win lands hardest on your mobile-data users, and it's millions of fewer calls/day at your scale.

### 2. The live duel is rough on real phones and networks
- **Found** — match start ships the bank **3× per duel**, then AES-decrypts + JSON-parses it **on the JS thread inside the start countdown** → an **~8.4 s freeze** on the A13. The JS thread is the whole bottleneck (**97% of frames janky**, GPU at **3.5%**, **7 cores idle**). And every answer waits a full network round-trip — fine on WiFi, painful on mobile data.
- **Fixed** — off-thread transport + **client prediction + reconciliation** + a **monotonic clock**; plus the real match-start fix: stop client-decrypting the bank mid-countdown. We built the native off-thread module to prove it — and it proved the **JSI bridge (685 ms), not the decrypt (4 ms), is the actual wall.**
- **Changes for you** — duels start smoothly and **fairly** (nobody starts the timer already frozen), and answers score **instantly on every network**:

  | Network | Round-trip | Naive (wait for server) | With prediction |
  |---|---|---|---|
  | WiFi | 30 ms | ~35 ms | **0 ms** |
  | 4G | 90 ms | ~95 ms | **0 ms** |
  | 3G / mobile data | 260 ms | ~263 ms | **0 ms** |

  …and a clock correction can't corrupt a timed duel (a real 800 ms answer reads as **−200 ms** under `Date.now()`, correct under our monotonic clock).

### 3. The leaderboard trusts the client
- **Found** — the client reports its own score; since the bank is decrypted on the client, a bot knows every answer and can forge a perfect one. Your competitive core is gameable.
- **Fixed** — a **server-authoritative** engine that recomputes correctness from its own key and flags bot/timing cadence, voiding the score.
- **Changes for you** — **100% of bots flagged, 0 honest players** flagged. Leagues, ratings, and leaderboards become trustworthy — and prediction means going server-authoritative costs **zero** felt latency.

---

## How deep we went (the receipts)
- Profiled on a **real budget Galaxy A13** with six instruments: Perfetto (per-thread + frame timeline), DevTools traces, `gfxinfo`, static APK dissection, a CDP network capture, a codec microbench.
- Built a **tested engine** — **47 passing tests** — and a real **Nitro native module**, cross-compiled and **run on the device** (that's how we caught the bridge, not the decrypt).
- Built a **playable on-device demo**: a live duel (instant prediction, a real opponent, a monotonic timer, and a Cheat button the server catches and disqualifies) + the off-thread-decrypt A/B harness.
- **Bonus** — root-caused the intermittent **"Something went wrong" web crash** to a third-party SDK (WebEngage reading `.uattr` on a null store), with the fix. See `reports/17`.

## Run it
```bash
npm test                                      # 47 tests
node bench/scenarios.ts                        # the WiFi/4G/3G + clock + integrity numbers
node bench/replay-launch.ts <capture.jsonl>    # the −45% on your real traffic
cd demo && npx expo run:android                # the playable duel — built + run on the A13
```

*Built by Vacha. Happy to walk through any of it.*
