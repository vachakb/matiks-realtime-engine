# Matiks — a performance teardown, measured on your real app + device (and a working fix)

An unsolicited, evidence-based teardown of the live Matiks app — profiled on **your production build and a real 32-bit Galaxy A13** (a top-selling India device) — plus a **built, tested engine** that fixes the core of it. Six independent instruments; every number is reproducible from the captured artifacts.

---

## TL;DR — what I measured

**On the real device (Galaxy A13, 32-bit, Android 14), during a live Blitz duel:**
- **97% of frames are janky.** The JS thread (`mqt_v_js`) is the **busiest thread in the app**, while the **GPU sits at ~3.5%** — so it's *not* a graphics problem, it's a one-overloaded-JS-thread problem. The phone had **7 cores idle** the whole time.
- **Match start freezes for up to ~2.5 s** (a synchronous `crypto-js` AES-decrypt of the whole question array on the JS thread) — *inside* the ~3.5 s synchronized-start countdown, so a slow phone can start the timed duel already behind.

**On the wire (same backend, web + native):**
- **~27–37 GraphQL calls fired unbatched in the first ~1.4 s of launch**; **zero `cache-control`** on any response; the **51 KB encrypted-question blob is shipped 3× per duel** (~900 KB/session of pure redundancy).
- **PII fanned out to 6 trackers** (email/name/ratings to WebEngage/Amplitude/Mixpanel/GA/Ahrefs + 380 KB to first-party Sakshi) — *more* analytics traffic than API traffic.

**And:** 2 reproducible-from-the-capture client bugs, plus answer-scoring is client-authoritative *(see the back-pocket section)*.

---

## What's here — two tracks of fixes + the evidence

- **Track A — the real-time engine** (`src/`): off-thread transport + **client-side prediction + reconciliation** + monotonic clock-sync. It **drops into the Nitro Modules toolchain you already ship** (confirmed from your APK). **32 unit tests pass**, benchmarked on your real captured frames.
- **Track B — data-layer quick wins** (`reports/08`): batch the launch fan-out, add caching, kill the triple question-fetch. **No native code — days, not weeks.** The founder-friendly first move.

## Start here (reading order)

| Report | What it is |
|---|---|
| **`reports/01-performance-teardown.html`** | The diagnosis + proof it's Matiks, not the device/network. **Start here.** |
| `reports/02-engine-verdict.html` | A founder's-eye, no-sugar grade of every claim — *including what's oversold*. |
| `reports/05-architecture-data-layer.html` | Your backend/data model + the data-layer waste, mapped from the wire. |
| `reports/08-track-b-data-layer-proposal.md` | The cheap data-layer wins, ranked, with before/after targets. |
| `reports/12-rich-session-findings.md` | Rate-limit budget, the PII fan-out, per-keystroke telemetry, more. |
| **`reports/13` + `reports/15`** | The `MatiksRealtime` Nitro decrypt module run **on a real A13** (debug + release): off-thread decrypt = 4 ms, but the JSI payload marshaling — not the decrypt — is the ~685 ms wall. The honest depth piece. |
| `reports/03-gap-backlog.html` | Everything vs the RN docs corpus, ranked (incl. native corrections). |
| **`reports/09` + `reports/11`** | The 2 stability bugs I hit, with repro + fixes *(back-pocket)*. |
| `reports/04, 06, 07, 10` | Method & raw evidence: decrypt-timing test, capture playbook, native APK findings, web trace. |

## The engine

```bash
npm test                 # 32 unit tests (prediction/reconciliation edge cases, codec, clock, backpressure)
node bench/run.ts        # replays your real captured frames → before/after numbers
node tools/scan-capture.ts <capture.jsonl>   # auto-detects bug + waste signatures from a capture
```
`src/core/` is platform-agnostic and fully Node-tested; `src/native/` is the Nitro shim, `src/web/` the Web-Worker shim — one shared core, two bodies, one TS API.

## Honesty (what's measured vs inferred, and what I walked back)

- **6 instruments:** Perfetto (per-thread sched + FrameTimeline), Chrome DevTools traces, `gfxinfo`/`dumpsys`, APK static dissection, a CDP traffic capture, and a JSON-vs-binary microbench.
- **The freeze is native-specific.** On web/V8 the decrypt is cheap; the ~2.5 s freeze is a **Hermes (no-JIT) + 32-bit** phenomenon, confirmed on-device. The web's dominant cost is different (synchronous `localStorage` + analytics).
- **I walked back two of my own claims after measuring:** msgpack is only a *modest* ~10% on this traffic (the real size lever is `permessage-deflate`, −58% on game frames), and the 270 ms "felt latency" is *partly hidden today* by optimistic UI — prediction's real value is letting you go **server-authoritative for anti-cheat without adding latency.**
- **And a third, after *building* it:** I shipped the `MatiksRealtime` Nitro module into a real RN app and ran it on the A13. The off-thread decrypt is real (~4 ms in release) but it does **not** by itself zero the match-start freeze — measuring in-app (debug *and* release) showed the JSI marshaling of the question payload is the true ~685 ms JS-thread cost, and packing it into one bridge crossing didn't help. The native module is a 6.8× win and the instrument that proved this; the **decisive** fix is the data layer (`reports/15`).
- Native architecture (Hermes, New Arch, Nitro) is **confirmed from the shipped APK**, not inferred.

---

*Built by Vacha. Questions / a walkthrough: happy to.*
