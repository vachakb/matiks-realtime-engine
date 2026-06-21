# 09 — Stability bugs found during testing (it's Matiks, not the tooling)

During a guided web session we hit: (a) a first duel that **"aborted instantly after matching, before it began"**, and (b) **two crash screens — "Cannot read properties of …"** — once after the daily puzzle, once on profile. **Verdict: both are client-side Matiks bugs.** Our capture is passive/read-only (it cannot cause a `TypeError`), and the server returned only 200s with no errors all session.

## Evidence (from the capture)
- **Zero** non-2xx HTTP responses and **zero** GraphQL `errors` across the entire session → no server/network failure.
- **6 `SearchOpponent` → 6 `JoinGameV2` → 6 `AbortSearching`**: every matchmaking search reached a game server-side (no server-side abort).

## Bug 1 — matchmaking abort race (instant bot-match)
`SearchOpponent` returns in **~1 ms** (instant *bot* match), and `AbortSearching` fires **2–4 ms later on the instant matches** (observed abort@+4 ms and abort@+2 ms) vs ~272–340 ms on slower matches. The always-fired `AbortSearching` colliding with an instant match is a classic race — consistent with the client rendering an "aborted" state even though the server created the game. **Matiks client logic bug.** Most likely on instant (bot) matches, which is what the first duel hit.

## Bug 2 — null-safety crashes ("Cannot read properties of undefined")
No server errors anywhere → these are pure client-side `TypeError`s (missing null guards) in Matiks' React code, around the **daily-puzzle** and **profile** screens (their ops ran and returned 200). The fresh-profile (empty-state) environment likely exposed an initial-state path — so **real new users (also empty state) can hit these**: an onboarding/retention bug. **Matiks code bug.**

## Bonus finding
**Zero Sentry beacons** appeared in the capture for these two crashes. Either Sentry isn't catching them, or an error boundary swallows them and surfaces the raw message to the user — either way **Matiks may be unaware of these bugs**. Worth confirming.

## How to pin the exact field (next step)
Reproduce with **DevTools Console open**; the error logs `Cannot read properties of undefined (reading 'X')` + a (minified) stack → names the exact field + screen. That's the precise repro to hand the founder.
