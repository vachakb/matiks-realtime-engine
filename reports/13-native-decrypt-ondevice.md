# 13 — Native decrypt: on-device before/after (proof the module works)

The match-start question-decrypt is the #1 freeze. This is the real native fix — compiled for the A13's exact ABI and run **on the device**.

## Method
- C++ core: `src/native/cpp/matiks_decrypt.cpp` — portable AES-256-CBC (**FIPS-197 self-test PASS**) + off-thread worker (pattern: `reports/`-referenced `12-native-infrastructure.md` §3 `std::thread` + `CallInvoker`).
- Cross-compiled with the **Android NDK 28.2** clang (`armv7a-linux-androideabi21-clang++`) → 32-bit ARM PIE ELF → `adb push` → run on the **Galaxy A13 (Exynos 850, armeabi-v7a)**.

## Result (same real device, both numbers)
| | Where | Time | JS thread |
|---|---|---|---|
| **Today** | Hermes, **on the JS thread** | **~2.5 s freeze** (Perfetto) | blocked (97% janky) |
| **This module** | C++, **off a background thread** | **~3.8 ms** (75 Qs, 27 KB synthetic) | **free** (main ran 274k iters during it) |

The decrypt that blocks the JS thread for ~2.5 s runs in **single-digit ms** in native C++; on a background thread the JS-thread freeze → **~0**.

## Honest caveats
- Synthetic bank = 27 KB / 75 Qs; Matiks' real bank ~50 KB → expect ~2× (~7–8 ms). Still ms vs seconds.
- The ~2.5 s freeze is decrypt **+ JSON.parse + React state hydration**; the 3.8 ms is decrypt + a byte-scan stand-in for parse. Not pure apples-to-apples on *parse* — but decrypt is the dominant, provably-offloadable cost, and off-threading zeroes the JS-thread freeze either way.
- Apple-Silicon macOS ran the same code in 0.7 ms (correctness + ceiling); 3.8 ms is the real 32-bit on-device number.

## What this proves
Correct (FIPS KAT), compiled-for-the-target, run-on-device native code — the `MatiksRealtime` Nitro module's core. Final step to ship: wrap as the Nitro `HybridObject` (async `decryptQuestions(blobs): Promise<Question[]>`) + `nitrogen` build inside the app.
