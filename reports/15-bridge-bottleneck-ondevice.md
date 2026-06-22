# 15 — The real wall is the JS↔native bridge, not the decrypt (on-device, debug **and** release)

We shipped the `MatiksRealtime` Nitro module into a real RN app, ran it **on the Galaxy A13 (armeabi-v7a, Android 14)**, instrumented the C++ with `logcat` timestamps, and ran it in **both a debug and a release (Hermes-bytecode, no dev bridge) build**. The measurement overturned our own hypothesis — which is exactly why we measured instead of asserting.

## The experiment (one screen, three buttons)

Same 75-question bank (~27 KB ciphertext → ~55 KB as `ivHex:ctHex` blobs). A live `requestAnimationFrame` spinner is the JS-thread "free?" readout — it can only advance when the JS thread is idle.

- **A — decrypt on the JS thread** (pure-JS AES, the current approach).
- **B — `decryptQuestions`** off-thread Nitro: 75 blobs in, 75 plaintext strings out (75 JSI crossings each way).
- **C — `decryptQuestionsPacked`** off-thread: blobs newline-joined into **one** string in, plaintexts joined into **one** string out (1 JSI crossing each way). Built specifically to test whether per-element marshaling was the cost.

## Results (same A13, same session)

| Path | Debug | Release |
|---|---|---|
| **A** · JS thread | 10563 ms · 634 dropped · JS free ❌ | **4677 ms · 281 · ❌** |
| **B** · off-thread, 75 strings | 1681 ms · 100 · ❌ | **689 ms · 41 · ❌** |
| **C** · off-thread, 1 packed string | 1737 ms · 103 · ❌ | **673 ms · 40 · ❌** |
| **decrypt loop** (C++ `logcat`) | `spawn=0ms decryptLoop=21ms` | `spawn=1ms decryptLoop=4ms` |

`logcat` from inside the C++ worker (release):

```
MatiksBench: decryptQuestions: spawn=1ms  decryptLoop=4ms  blobs=75
```

## What it means

The off-thread AES decrypt of all 75 questions is **4 ms in release** (`spawn=1ms` → the worker thread launches instantly). Yet the JS-side `await` measured **689 ms**. Decompose release B:

| Cost | Time | Share |
|---|---|---|
| Off-thread AES decrypt (our C++) | 4 ms | ~1% |
| **JSI bridge — marshaling the payload in + out, on the JS thread** | **~685 ms** | **~99%** |

Two facts kill the obvious explanations:
1. **B ≈ C** in *both* builds (689 vs 673 ms release; 1681 vs 1737 ms debug). Collapsing 75 JSI crossings to 1 changed nothing → the cost is **not** per-element marshaling overhead. It is **byte-bound payload marshaling across the Hermes/JSI boundary**, synchronously on the JS thread.
2. **JS thread free = ❌ in release too.** ~40 dropped frames over ~685 ms = the spinner froze. So the freeze is **production-real, not a dev-mode artifact** — release is only ~2.4× faster (optimized Hermes), same shape.

### The headline
"Make the decrypt native and off-thread" fixes the wrong 1%. Once the AES is off-thread it costs **4 ms**. **The wall is moving the question payload across the JS↔native boundary at all** — that crossing is synchronous on the JS thread and dwarfs the compute, in both debug and release. The native module is a real ~6.8× end-to-end win *and* the instrument that proved where the cost actually lives.

### The fix this points to
Architectural, not native: **don't ship + client-decrypt the entire question bank during the match-start countdown** (the data-layer track, `reports/08`). Hand the client data it doesn't have to AES-decrypt-then-marshal mid-countdown. The native module offloads the compute; the bridge crossing of that payload is the constraint that remains — confirmed on a real low-end device, in a release build.

## What is proven

- The native module is genuinely linked: `lib/armeabi-v7a/libMatiksRealtime.so` (109 KB) ships in the APK next to `libNitroModules.so`; Nitro registers the HybridObject at load (`Successfully registered HybridObject "MatiksRealtime"`).
- The AES core is FIPS-197-correct, decrypts all 75 real questions, and runs **off the JS thread in ~4 ms (release) / ~21 ms (debug)** on the A13.
- Off-threading the decrypt is a **~6.8× end-to-end win** (release 4677 → 689 ms) and drops **240 fewer frames** — even before any data-layer change.
- The residual freeze is the **JS↔native payload marshaling (~685 ms in release)**, independent of payload framing — so the decisive fix is to stop crossing the bridge with that payload at match start.

## Honest open refinement (not yet measured)

We have not isolated whether the ~685 ms is strictly proportional to payload **bytes** or includes a large **fixed per-async-call** cost. B≈C rules out per-*string* overhead, and a ~685 ms fixed cost would contradict Nitro's ~µs-per-call design, so byte-bound marshaling is the strong hypothesis — but a per-blob-count sweep (decrypt 5 vs 25 vs 75) would pin the curve. It does not change the conclusion: reducing/eliminating the payload crossing is the fix; packing it differently is not.
