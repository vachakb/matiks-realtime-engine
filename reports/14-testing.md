# 14 — How the native module is tested (and what's still the gate)

You never hand over untested native code. The decrypt core is tested at three levels; **L1 + L3 are green on macOS *and* the on-device A13**, L2 is the pre-handoff gate.

## Level 1 — C++ core: correctness · robustness · thread-safety · fuzz  ✅ macOS + A13
`src/native/cpp/matiks_decrypt_test.cpp` — 8 checks, all pass on macOS **and** on the Galaxy A13 (armeabi-v7a):
- AES-256 **FIPS-197 known-answer test** (crypto provably correct)
- encrypt→decrypt round-trip, sizes 1..5000 (PKCS7)
- empty / malformed-hex / **non-16-aligned ciphertext rejected** (a real OOB read that testing caught → we fixed)
- wrong key → graceful, no crash
- **8 threads × 200 concurrent decrypts → all correct** (thread-safe; shared const key context)
- **20,000 fuzz iterations** (random blobs + hex) → **zero crashes**

## Level 3 — golden test on REAL captured data  ✅ macOS
Decrypting Matiks' actual captured question bank (recovered key + `enc_questions_sample.json`): **75/75 blobs decrypt to valid printable JSON.** Proves the core reproduces their *production* decryption on *real* data — not just synthetic. (Key/data passed as args — never committed.)

## Level 2 — Nitro binding layer  🔨 the pre-handoff gate
The nitrogen-generated JSI bindings, the async Promise, JS↔C++ marshaling, and memory/lifecycle can **only** be tested inside a React Native app. Build the minimal RN test-harness app, run the module on the A13, assert the same correctness + measure the async path. **Do not hand over until L2 passes.** (Multi-hour build: JDK 17 + Expo + `nitrogen` + Gradle.)

## What this proves / doesn't
**Proves:** the decrypt core is correct (incl. on real data), robust to bad input, thread-safe, fast (~3.8 ms on the A13), crash-free under fuzz.
**Does NOT prove:** the Nitro binding layer (needs L2), nor that the decrypt is *the* dominant cause of the match-start freeze (a separate, honest open question — see `reports/13`).
