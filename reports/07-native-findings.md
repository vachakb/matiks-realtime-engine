# 07 — Native ground truth (APK dissection) + the decrypt-timing result

## Device (verified via `getprop`)
**Samsung Galaxy A13 (SM-A135F), Exynos 850, Android 14, 32-bit ONLY** (`armeabi-v7a`; no arm64 in abilist), ~6 GB RAM. A top-selling India budget phone — so this *is* the low-end target, and 32-bit Hermes amplifies the JS-thread cost.

## Native stack — confirmed from the shipped APK (resolves the web-build UNKNOWNs)
- **Hermes:** yes — `libhermes.so` + `index.android.bundle` is Hermes bytecode (magic `c6 1f bc 03`).
- **New Architecture:** yes — `libjsi`, `libreactnative`, `libworklets` + Codegen libs (`libreact_codegen_rnscreens/rnsvg/safeareacontext/RNKC`) = Fabric + TurboModules in production.
- **Nitro Modules ALREADY in production:** `libNitroModules` + `NitroMmkv`, `NitroAppState`, `NitroRnKeyboard`, `NitroRnStrokeText`. → our engine is *another Nitro module* in a toolchain they already run. Major de-risk for the pitch.
- Also present: RN Skia (`librnskia`), Reanimated + Worklets, Gesture Handler, RN Screens/SVG, Fresco + AVIF/WebP/GIF, Lottie, Rive (the countdown), Sentry + Crashlytics, ML-Kit barcode (`barhopper`), LAME audio, and **QuickJS** (`libquickjs-android-wrapper` — a 2nd JS engine alongside Hermes; purpose TBD, worth a look).

### Corrections to the web-only gap analysis (the APK overrides it)
- **MMKV is used on native** (`NitroMmkv` + `mmkv`). The web "AsyncStorage" was a platform fallback — **not** a violation.
- **RN Skia is present** natively (invisible from the web bundle).

## Memory
~407 MB PSS / 170 MB native heap — moderate on a 6 GB device (not a crisis; would matter more on 2–3 GB).

## Decrypt-timing result (Perfetto, real duel on the A13)
| Metric | Value |
|---|---|
| Frames janky | **97%** (1653/1712) |
| GPU on-CPU | ~1.4 s → CPU/JS-bound, not graphics |
| JS thread (`mqt_v_js`) longest contiguous busy run | **2,825 ms** |
| Longest single JS on-CPU slices (ms) | 756, 678, 676, 641, 545, 527 |
| **Largest gap between presented frames (a freeze)** | **2,480 ms at +6.3 s** (match-start region) |
| Other freezes | 2017, 1820, 1736, 1580, 1552 ms |

**Reading:** on the real 32-bit device, freezes are **1.5–2.8 s**, not the 652 ms seen on web V8. A ~2.5 s freeze near match start eats most of the ~3.5 s synchronized-start window and janks the Rive countdown — so the window does **not** hide the work; the slow player gets a frozen screen and the first interactive frame lands near/after `startTime`. Off-thread is the fix, and 32-bit Hermes makes it matter more.

**Honest caveat:** Perfetto on a prod build can't *label* which freeze is the decrypt vs a screen transition; +6.3 s timing + magnitude are consistent with match-start. To *name* the task definitively, run the CPU-throttled web Performance trace (Method B) which shows JS task names. The headline holds regardless: multi-second JS-thread freezes, 97% janky, GPU idle.

_Trace: `/Users/vacha/matiks-duel2.perfetto-trace` · APKs: `/Users/vacha/matiks-apk/`._
