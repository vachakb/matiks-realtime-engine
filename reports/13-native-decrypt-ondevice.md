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
- The ~2.5 s freeze is decrypt **+ JSON.parse + React state hydration**; the 3.8 ms is decrypt + a byte-scan stand-in for parse. Not pure apples-to-apples on *parse*.
- **Important correction — now measured in-app (`reports/15`).** This 3.8 ms is the *raw* decrypt in a standalone binary, with no JS↔native bridge. Once wrapped as the actual Nitro module and run inside a real RN app on the A13, the off-thread decrypt is still ~ms (**4 ms in release**) — but marshaling the question payload across the JSI boundary re-introduces a **~685 ms JS-thread block (release)**. So off-threading the decrypt is a real ~6.8× win, yet it does **not** by itself zero the freeze: the *bridge crossing of the payload* is the residual wall. The decisive fix is the data layer (don't client-decrypt the bank at match start).
- Apple-Silicon macOS ran the same code in 0.7 ms (correctness + ceiling); 3.8 ms is the real 32-bit on-device number.

## What this proves
Correct (FIPS KAT), compiled-for-the-target, run-on-device native code — the `MatiksRealtime` Nitro module's core. **This final step is now done (`reports/15`):** wrapped as the Nitro `HybridObject`, `nitrogen`-built, and run inside a real RN app on the A13 in both debug and release. Headline from that step — the off-thread decrypt is ~4 ms, but the JSI payload marshaling is the real ~685 ms JS-thread cost, so the decisive fix is the data layer, not the native module alone.
