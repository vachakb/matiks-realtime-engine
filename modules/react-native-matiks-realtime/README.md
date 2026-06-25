# react-native-matiks-realtime

Off-thread **AES-256-CBC question decryption** for Matiks match-start, packaged as a
[React Native **Nitro Module**](https://nitro.margelo.com) implemented in **C++ on both
platforms** (`ios: 'c++'`, `android: 'c++'`).

The whole decrypt loop runs on a background `std::thread`; the `Promise` resolves back on
the JS thread via Nitro's `CallInvoker`. On a 32-bit Hermes build the synchronous version
of this work was a ~2.5 s JS-thread freeze (measured via Perfetto) — here it is ~0 ms on
the JS thread.

The crypto is the **same FIPS-197-verified AES core** that ships in
`matiks-engine/src/native/cpp/matiks_decrypt.cpp`, copied verbatim into
[`cpp/aes.hpp`](./cpp/aes.hpp). The same source compiles for macOS clang and the Android NDK.

## API

```ts
import { MatiksRealtime } from 'react-native-matiks-realtime'

// Each blob is "ivHex:ctHex" (AES-256-CBC, PKCS7).
// keyUtf8 is a 32-character string; its raw UTF-8 bytes are the AES-256 key.
const plaintexts: string[] = await MatiksRealtime.decryptQuestions(blobs, keyUtf8)
```

`decryptQuestions(blobs: string[], keyUtf8: string): Promise<string[]>`
- Resolves with the plaintext strings, in the same order as `blobs`.
- Rejects if `keyUtf8` is not exactly 32 bytes, a blob is malformed (missing `:`, bad hex,
  IV not 16 bytes, ciphertext not a multiple of 16), or the AES FIPS-197 self-test fails on
  the build's toolchain.

PKCS7 padding is stripped (per the proven core's `cbcDecrypt`).

---

## Build steps

### 1. Install dependencies

```sh
npm i
# react-native-nitro-modules is a peer dependency — make sure it (and `nitrogen`)
# are installed in the consuming app too.
```

### 2. Generate the Nitro spec glue

```sh
npx nitrogen          # or: npm run nitrogen
```

This reads [`nitro.json`](./nitro.json) + [`src/MatiksRealtime.nitro.ts`](./src/MatiksRealtime.nitro.ts)
and writes (commit these):

```
nitrogen/generated/
├── shared/c++/HybridMatiksRealtimeSpec.{hpp,cpp}     ← our cpp/HybridMatiksRealtime.hpp includes this
├── ios/MatiksRealtime+autolinking.rb                 ← loaded by MatiksRealtime.podspec
└── android/
    ├── MatiksRealtime+autolinking.cmake              ← include()d by android/CMakeLists.txt
    ├── MatiksRealtime+autolinking.gradle             ← apply from: in android/build.gradle
    └── MatiksRealtimeOnLoad.hpp                       ← used by android/src/main/cpp/cpp-adapter.cpp
```

> The generated spec declares the pure-virtual `decryptQuestions(...)` returning
> `std::shared_ptr<Promise<std::vector<std::string>>>`, which `HybridMatiksRealtime` overrides.

### 3. Build TypeScript (optional, for publishing)

```sh
npm run typescript
```

### 4. Autolinking into the app

This is a normal autolinked RN library — no app code changes beyond installing it.

**Expo (prebuild):**

```sh
# in the app
npm i ../path/to/react-native-matiks-realtime react-native-nitro-modules
npx expo prebuild --clean
# iOS
npx pod-install        # or: cd ios && pod install
npx expo run:ios
# Android
npx expo run:android
```

**Bare RN / Gradle + CocoaPods:**

```sh
# Android: react-native-nitro-modules + this module autolink via settings.gradle / RN CLI.
./gradlew :app:assembleDebug      # or run from Android Studio

# iOS:
cd ios && pod install             # the podspec is picked up by `use_native_modules!`
npx react-native run-ios
```

Nitro registers the HybridObject by name (`"MatiksRealtime"`) at load time via the
`autolinking` block in `nitro.json`, so `NitroModules.createHybridObject<MatiksRealtime>('MatiksRealtime')`
in [`src/index.ts`](./src/index.ts) just works.

---

## How it maps to the repo docs

- **Off-thread pattern** — `02-architecture-and-performance/12-native-infrastructure.md` §3
  (JSI HostObject + `std::thread` + `CallInvoker`). Nitro's `Promise` is the modern wrapper
  over that exact pattern: we resolve from the worker thread and Nitro hops back to JS.
- **C++ ↔ native** — `09-jni-and-cpp-bindings.md`. On Android the generated `JNI_OnLoad`
  in `cpp-adapter.cpp` calls `registerAllNatives()`; fbjni handles the JNI plumbing.
- **Nitro's >50 ms rule** — the bank decrypt is far above 50 ms, so the method is async /
  off-thread, never synchronous.

## File tree

```
react-native-matiks-realtime/
├── src/
│   ├── MatiksRealtime.nitro.ts        # HybridObject spec
│   └── index.ts                       # createHybridObject('MatiksRealtime')
├── cpp/
│   ├── aes.hpp                        # PROVEN AES core + fromHex (verbatim) + FIPS-197 self-test
│   ├── HybridMatiksRealtime.hpp       # implements the generated spec
│   └── HybridMatiksRealtime.cpp       # decrypt loop on a background std::thread
├── android/
│   ├── CMakeLists.txt
│   ├── build.gradle
│   ├── fix-prefab.gradle
│   ├── gradle.properties
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── cpp/cpp-adapter.cpp        # JNI_OnLoad → registerAllNatives()
│       └── java/com/margelo/nitro/matiksrealtime/MatiksRealtimePackage.kt
├── ios/Bridge.h
├── MatiksRealtime.podspec
├── nitro.json
├── package.json
├── tsconfig.json
├── babel.config.js
└── react-native.config.js
```
