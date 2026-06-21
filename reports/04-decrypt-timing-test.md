# Decrypt-timing test — does the match-start decrypt overrun the synchronized-start window?

**The question (the founder's challenge):** the ~652 ms match-start decrypt sits inside a *deliberate* synchronized-start window. So is it actually a problem?

**What we've already verified**
- `JoinGameV2` returns `encryptedQuestions` + an absolute `startTime`. Across **7 captured matches**, `startTime` lands **3.0–3.9 s (mean 3.58 s)** after the client receives the response — a deliberate window, filled by a Rive "3…2…1" countdown (`COUNTDOWN_TIMER_SECONDS`, `COUNTDOWN_TIMER_RIVE_CONSTANT` in the bundle).
- The client decrypts the **whole** question array (crypto-js AES-256-CBC) + `JSON.parse`, **synchronously on the JS thread**. Web (V8) measured ~652 ms; Hermes (no JIT) on low-end is expected to be materially higher.

**What we still need to prove:** on a low-end device, does the decrypt (a) jank the Rive countdown, and (b) finish *before* `startTime`, or overrun it so question #1 renders late (slow player starts the timed match behind)?

---

## Method A — native ground truth (Perfetto) · ~5 min · decisive
1. On the Exynos-850, open **Quick Settings → Record trace** (System Tracing; default categories include CPU scheduling).
2. Start a **Blitz/DMAS online** duel. Let the countdown play. **Stop the trace right after question #1 appears.**
3. `adb pull /data/local/traces/<newest>` and send it. I will measure, on the `mqt_v_js` thread:
   - the **longest contiguous on-CPU run** between JoinGameV2 receipt and `startTime` (= the decrypt),
   - whether the **first question frame is presented before or after `startTime`**,
   - **frame intervals during the countdown** (is the Rive "3…2…1" janking?).

## Method B — web proxy (Chrome, throttled) · ~5 min · fast
1. `matiks.com` web app → DevTools → **Performance**; set **CPU 6× slowdown** + **Network: Fast 4G** (emulates a budget phone).
2. **Record** from "finding opponent" through question #1; stop; **Save profile**.
3. Send it. I'll isolate the decrypt task duration during the countdown and whether Q1 paints before the countdown ends. Same crypto-js code path as native → a fair proxy.

## Method C — isolated micro-bench · no app/keys needed · bounding
Time pure-JS AES-256-CBC decrypt of a **synthetic** 75-question / ~50 KB payload at 1× and 6× CPU (touches none of Matiks' keys or data). Bounds the cost; multiply ~2–4× for Hermes-without-JIT. Gives a quick "could it possibly overrun 3.5 s?" sanity bound.

---

## Decision rule (stated up front, so the result decides — not the pitch)
- **If** decrypt + parse comfortably fits in ~3.5 s on low-end **and** the countdown stays smooth → the freeze is **benign**; we deprioritize it and say so plainly.
- **If** it overruns `startTime` **or** janks the countdown (the 90%-janky / 39.7%-JS-thread trace suggests it does) → off-thread/chunk the decrypt. **Keep the synchronized start**; just make the prep non-blocking so it's fair on every device.
