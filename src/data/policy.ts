// Caching policy: default 0 ms (never cache) — opt-in per-operation TTLs only, so live data
// (game state, scores) stays fresh while slow-changing re-polls get cached.

import type { CachePolicy, RequestSpec } from './types.ts';
import { gqlInfo } from './keys.ts';

// TTL by GraphQL operationName; everything else falls back to `defaultTtlMs`.
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

// TTLs from the capture (operations re-fetched often, changing on the order of minutes). Live data
// (e.g. GetGameByIdV2 duel state) is intentionally absent → falls through to 0 = no cache.
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
