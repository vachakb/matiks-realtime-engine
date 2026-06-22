// Caching policy. The default is conservative — 0 ms (never cache) — so nothing is cached
// unless explicitly allowed. Per-operation TTLs are opt-in, which keeps live data (game
// state, scores) always fresh while collapsing the slow-changing re-polls we measured.

import type { CachePolicy, RequestSpec } from './types.ts';
import { gqlInfo } from './keys.ts';

/** TTL by GraphQL operationName; everything else falls back to `defaultTtlMs`. */
export class OperationTtlPolicy implements CachePolicy {
  private readonly rules: Readonly<Record<string, number>>;
  private readonly defaultTtlMs: number;

  constructor(rules: Readonly<Record<string, number>>, defaultTtlMs = 0) {
    this.rules = rules;
    this.defaultTtlMs = defaultTtlMs;
  }

  ttlMs(spec: RequestSpec): number {
    const info = gqlInfo(spec.body);
    if (info) {
      const ttl = this.rules[info.op];
      if (ttl !== undefined) return ttl;
    }
    return this.defaultTtlMs;
  }
}

// TTLs derived from the real Matiks capture: operations re-fetched many times
// per session whose data changes on the order of minutes, not seconds. Deliberately EXCLUDES
// live data — e.g. GetGameByIdV2 (duel state) is absent, so it falls through to 0 = no cache.
// These are starting points a team would tune against their own freshness requirements.
export const MATIKS_QUERY_TTL_MS: Readonly<Record<string, number>> = {
  GetCurrentUser: 30_000,
  GetUserTodayQuest: 60_000,
  CheckUserStreakStatus: 60_000,
  GetUsersWeeklyStatikCoinsV2: 30_000,
  GetFeaturedUnifiedContests: 60_000,
  GetAllUnifiedContests: 60_000,
  GetRewardsByIDs: 300_000,
  GetActiveOrLastActivatedXPBoosterStatus: 60_000,
  GetDailyChallenges: 300_000,
  GetTodaysPuzzleProgress: 30_000,
  GetUserLeagueGroupLeaderboard: 15_000,
  OnlineUsers: 10_000,
  GetUserScene: 120_000,
};
