# 11 — Bug reports (reproducible) + recommended fixes

Two user-facing defects hit during testing. **Both are Matiks app-layer bugs** (matchmaking + UI), a different layer than the real-time engine — so they're documented + reproduced here, not "fixed in the engine." BUG-1 + the GraphQL waste are auto-detected by `tools/scan-capture.ts`.

---

## BUG-1 — Matchmaking abort race (a duel "aborts instantly after matching")
**Severity:** High (bad first impression on the core action).
**Signature (auto-detected):** on instant (bot) matches, `SearchOpponent` returns in ~1 ms and `AbortSearching` fires **2–4 ms** later (vs ~300 ms on slower matches). In the captured session, **2/6 matches were race-prone**. The always-fired `AbortSearching` colliding with an instant match can leave the UI in an "aborted" state even though the server created the game (capture shows **6 search → 6 join → 0 server-side aborts**).
**Repro:** start duels repeatedly — instant bot-matches are most likely to glitch. Verify: `node tools/scan-capture.ts <capture.jsonl>` → look for `⚠ RACE-PRONE`.
**Fix (Matiks-side):** make join idempotent + guard the abort — once `UserMatchedEvent`/`JoinGameV2` has fired for a search, skip the `AbortSearching`; or collapse `Search → Abort → Join` into one call (the abort is redundant on an instant match).
**Engine relation:** if the real-time engine owns the match lifecycle, it can enforce exactly this (idempotent join, drop a late abort) — a clean home for the guard.

---

## BUG-2 — Null-safety crashes ("Cannot read properties of undefined")
**Severity:** High (full error screen; hit on daily-puzzle exit and on profile).
**Evidence:** zero non-2xx, zero GraphQL errors all session → a pure client-side `TypeError` (missing null guard). The fresh-profile (empty/new-user state) likely exposed an unguarded initial-state path → **real new users can hit it**. **Zero Sentry beacons** were captured for the crashes → Matiks may be unaware.
**Repro to capture the EXACT field (the smoking gun for the founder):**
1. matiks.com Chrome → DevTools → **Sources** → enable **"Pause on uncaught exceptions"** (tick "caught" too).
2. Reproduce (finish a daily puzzle; open profile).
3. On pause: the **Console** shows `Cannot read properties of undefined (reading 'X')` — note **X**; the **Sources** pane highlights the exact (minified) line + the undefined variable; the **Call Stack** names the component.
4. Screenshot the Console error + the paused line → an undeniable, specific bug report.
**Fix (Matiks-side):** null-guard the access (optional chaining / defaults) + handle the empty/new-user state on that screen; add an **error boundary that reports to Sentry** (so they see these) instead of surfacing the raw message.
**Engine relation:** N/A (their UI). Our engine's state is null-safe by construction (typed reducers + frozen default state), so this class doesn't arise on the realtime path — a useful contrast to cite.

---

## Tooling
`tools/scan-capture.ts` turns any `capture.mjs` JSONL into a bug & waste report (BUG-1 race, GraphQL errors, duplicate question payloads, redundant fetches):
```
node tools/scan-capture.ts <capture.jsonl>
```
BUG-2 (a client `TypeError`) is **not** visible in a network capture — use the DevTools repro above to name the field.
