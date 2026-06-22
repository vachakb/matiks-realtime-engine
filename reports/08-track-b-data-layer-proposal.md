# 08 — Track B: Data-Layer Optimization Proposal (no native code)

**Goal:** cut cold-start round-trips, kill redundant payloads, and stop re-fetching unchanged data — via **Apollo-client config + a few server changes only**. No native module. High ROI, low risk; ship before/alongside the engine (Track A).

**Baseline (measured at launch; full numbers in `16-data-layer-measured`):** ~37 GraphQL round-trips in 1.4 s at launch · **0** `cache-control` headers · ~900 KB/session duplicate encrypted-question payload · home cluster re-fetched ~15× · analytics ≈ 1:1 with API.

| # | Change | Where | Effort | Impact |
|---|---|---|---|---|
| **B1** | **Batch the launch fan-out** — Apollo `BatchHttpLink` (batchMax ~10, ~10 ms window) on `/api`; better: a server `homeScreen` aggregate resolver. ~33-query burst → ~3 batched POSTs. | client (+server) | M | **HIGH** |
| **B2** | **Cache-control + client dedup.** Static-per-session → `cache-first`, long TTL: `GetFeaturedUnifiedContests` (byte-identical 15×), `GetUserSettings`, `GetReportUserConfig`, `GetLatestAppVersion`, `GetExploredFeatures`, `GetBlockedUsers`. Semi-static → 30–60 s TTL / refetch-on-focus: league board, `CheckUserStreakStatus`, `OnlineUsers`, weekly coins. | client+server | S-M | **HIGH** |
| **B3** | **Kill the triple question-fetch.** The ~51 KB encrypted blob ships 3×/duel (`UserMatchedEvent` + `GetGameByIdV2`×2 + `JoinGameV2`). Use the copy already in `UserMatchedEvent`; drop questions from the GraphQL responses. | client (+server trim) | S | **HIGH** |
| **B4** | **Drop redundant fetches.** `GetUsers` after match (opponent already in `UserMatchedEvent.opponent`); `GetCurrentUser` at launch (17×; identity already in `GoogleLogin`) — seed cache from login. | client | S | MED |
| **B5** | **Persisted queries (APQ)** — sha256 persisted-query link + server support. Stops shipping multi-KB query strings on ~422 POSTs/session; enables GET + CDN caching. | client+server | M | MED |
| **B6** | **Parallelize the head-of-line chain.** `GoogleLogin → Moderation → GetUserScene` is serial (~740 ms) before the burst — fire them together. | client | S | MED |
| **B7** | **Lazy-load eager heavy widgets** — `GetFriendRecommendation` (16 KB) + `GetUserContestAttemptStats` (57 KB) load at launch though off-screen; defer behind their tabs. | client | S | MED |
| **B8** | **Trim analytics** (optional) — 405 beacons ≈ 1:1 with API; batch/sample non-critical ones (a gzip util already exists). | client | S | LOW-MED |

## Rollout
- **Phase 1 (days, pure client Apollo config + 2 response trims):** B2, B3, B4, B6, B7 — biggest ROI, lowest risk, no schema changes.
- **Phase 2 (small server work):** B1 (batch link / `homeScreen` aggregate) + B5 (APQ).

## How we prove it (before/after, same method as the audit)
Re-run `capture.mjs` after each phase and compare: (a) # POSTs to `/api` in the first 2 s, (b) total bytes/session, (c) cold-start TTI (DevTools), (d) duplicate-payload count.
**Targets:** launch round-trips **37 → <5**; per-session bytes **−40 %+**; question payload **−66 %** (−~600 KB).

> Why this is the founder-friendly first move: it touches no native code, ships in days, has a clean before/after, and directly improves cold-start on the 32-bit low-end device where it hurts most. The engine (Track A) is the deeper, strategic build; this is the quick, high-confidence win.
