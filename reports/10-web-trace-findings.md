# 10 — Web match-start trace (Method B): the decrypt isn't the web bottleneck — storage/analytics is

CPU-throttled (6×) DevTools Performance trace of a Blitz match start on matiks.com (`Trace-20260622T033902.json`). Goal was to *name* the decrypt task. **Honest result: the decrypt is NOT the dominant cost on web** — a useful correction.

## Main-thread self-time over the clip (top functions)
| self-time | % | function |
|---|---|---|
| 12,067 ms | 30.6% | `setItem` — synchronous **localStorage** writes |
| 11,767 ms | 29.9% | (idle) |
| 9,940 ms | 25.2% | (anonymous) @ `service-worker.js:46` |
| 3,139 ms | 8.0% | (anonymous) @ WebEngage `storage-frame-1.13.htm` |
| rest | <1% ea | rAF, GC, timers, a little `__common`, `rive.wasm` |

## Reading (honest)
- **The AES decrypt does NOT appear as a top cost on web.** On V8 it's cheap; the ~2.5 s match-start freeze is a **native-Hermes** (no-JIT) phenomenon — confirmed on the device via Perfetto, not reproducible on web. "Decrypt freeze" is a *native* claim; the web trace doesn't show it, and I won't pretend it does.
- **What the web trace DID surface is a separate, real bottleneck: ~64% of active main-thread time is storage + analytics** — synchronous `localStorage.setItem` (30%), a service worker (25%), and WebEngage's cross-domain storage iframe (8%). Likely culprits: zustand-persist / Apollo cache / WebEngage writing to localStorage on the match hot path. Synchronous localStorage on the main thread is a classic jank source. (6× throttle inflates this — ~⅙ unthrottled, still seconds over a match.)

## Two distinct, real bottlenecks now established
- **Native:** match-start decrypt freeze (Hermes, 32-bit) — ~2.5 s, confirmed by Perfetto.
- **Web:** storage/analytics thrash — confirmed here.
Different platforms, different fixes; both real.

## To name the native decrypt definitively
Web can't (different cost profile). Use the **Hermes sampling profiler** on a dev/Expo build, or instrument the decrypt. Bundle code (synchronous `crypto-js` AES-CBC over the whole question array at match start) + the 2.5 s native freeze are strong circumstantial evidence meanwhile.

## New web TODO
Reduce synchronous `localStorage.setItem` on the match hot path (debounce/batch zustand-persist; move WebEngage/analytics off the critical path; async/IndexedDB persistence). Quantify by counting setItem calls + payload sizes.
