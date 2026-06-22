# 12 — Rich session deep-mine (extends 05 + 08)

Second capture session (app **v1.23.103**; 6 duels across BLITZ/PUZZLE/MEMORY, **league joined, contest registered, daily challenge played**, 986 s). Confirms the data-layer findings with hard numbers and surfaces new ones.

## Confirmed, with numbers
- **27 GraphQL POSTs in 466 ms at home, unbatched.** A `getHomeScreen` aggregate or a batch link → ~27 round-trips become 1–3.
- **Triple question-fetch = 693 KB/session** (18 responses × ~52 KB; `JoinGameV2` once + `GetGameByIdV2` **twice** per duel). One `GetGameByIdV2` is 52.7 KB and **96% is `encryptedQuestions`** — 75 ciphertexts shipped for a 60 s game where ≤30 are answered (also over-provisioned).
- **105 redundant identical calls** (same op+vars); **no `cache-control`** on any of 305 responses. Worst: `GetUsersWeeklyStatikCoinsV2` ×11, `GetCurrentUser` ×10, XP-booster ×10, `GetUserLeagueGroupLeaderboard` ×10 (5.6 KB identical each), `GetUserTodayQuest` ×9.

## New findings
- **Rate-limit budget (new reason to batch):** every `/api` response carries `x-ratelimit-limit: 1000` + `x-ratelimit-remaining` + `x-ratelimit-reset`. The 27-POST home bursts + ~305 POSTs/session eat a 1000/window budget → batching isn't only faster, it protects against rate-limiting under heavy use.
- **🔒 Privacy / PII fan-out (new category):** **333 analytics requests > 305 API requests.** Full PII (`email`, `name`, Google avatar, all ratings, ranks, streaks, signup date) is shipped to **6 trackers** — WebEngage (124 req / 148 KB), Amplitude (52) + Amplitude-Experiment (21), Mixpanel (36), GA (38), Ahrefs (31), and **first-party `api.sakshi.matiks.org` (31 req / 380 KB)**. Leaderboard/league responses also expose **other users' raw Gmail + avatar + `_id`**. → data-minimization; stop broadcasting full PII to every vendor.
- **Per-keystroke telemetry on the GraphQL gateway:** `SubmitGameQuestionActions` ×62, each carrying full cursor-movement + keystroke-timeline arrays + the **question expression and answer in plaintext**, returning only `true`. Batch at game-end (the daily challenge already does this via one `SubmitChallengeResult`) or move off the gateway to the analytics pipeline.
- **Stale WS re-subscription:** on reconnect the client re-subscribes to `GAME_EVENT`/`GROUP_CHAT` channels for 6 already-ended games. Prune to the active game.
- **`GetUnifiedContestParticipants` N+1:** opening the league participant list fired **4 identical queries** differing only by `sortKey` (the 4 rating sub-types). Fetch once, sort client-side.
- **App v1.23.103 model shift:** this build logs answers via the GraphQL mutation `SubmitGameQuestionActions` + server pushes `GAME_EVENT` over WS — not the earlier build's WS `submitAnswerV2`. The realtime submit path is **version/mode-dependent**; the engine thesis (off-thread transport + prediction) is unaffected, but cite the path per version.
- **`betInfo` null all session** — coin-staking not exercised; the wager/economy flow still needs a staked duel to capture.

## Latency (statistically solid, n=58)
PING_PONG is the trustworthy real-time signal: **server-delta (uplink) p50 196 / p95 217 ms**; **full client RTT p50 268 / p95 481 / max 937 ms** (steady-state ≈ 265 ms). `syncServerTime` reports `serverOffset: 0` (clocks aligned → these are real network legs). **Do NOT cite `SubmitGameQuestionActions` latency (p50 1 ms) as gameplay latency** — it's a fire-and-forget telemetry ack, not the scoring path.

## New Track-B items (extend reports/08)
- **B9** — data-minimization / stop PII fan-out to 6 trackers (privacy + bytes).
- **B10** — batch `SubmitGameQuestionActions` at game-end (off the hot path / off the gateway).
- **B11** — prune stale WS subscriptions on reconnect.
- **B12** — collapse `GetUnifiedContestParticipants` N+1 (sort client-side).
