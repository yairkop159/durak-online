import {
  LEADERBOARD_SIZE,
  RECENT_GAMES_LIMIT,
  type GameEndReason,
  type GameMode,
  type LeaderboardResponse,
  type PlayerResult,
  type PublicProfile,
  type RecentGame,
} from '@durak/shared';
import type { PrismaClient } from '../db/database.js';
import { RatingsUnavailableError, type HistoryStore } from './ports.js';

/** Read side of the match history: public profiles (with rank and recent games) and the leaderboard. */
export class PrismaHistoryStore implements HistoryStore {
  constructor(private readonly client: () => PrismaClient | null) {}

  private db(): PrismaClient {
    const client = this.client();
    if (!client) throw new RatingsUnavailableError();
    return client;
  }

  async publicProfile(profileId: string): Promise<PublicProfile | null> {
    const db = this.db();
    const profile = await db.profile.findUnique({ where: { id: profileId } });
    if (!profile) return null;

    // Same order as the leaderboard: rating desc, then id (a stable tie-break).
    const rank =
      profile.ratedGames > 0
        ? 1 +
          (await db.profile.count({
            where: {
              ratedGames: { gt: 0 },
              OR: [{ rating: { gt: profile.rating } }, { rating: profile.rating, id: { lt: profile.id } }],
            },
          }))
        : null;

    const seats = await db.gamePlayer.findMany({
      where: { profileId },
      orderBy: [{ game: { endedAt: 'desc' } }, { gameId: 'desc' }],
      take: RECENT_GAMES_LIMIT,
      include: { game: { include: { players: { orderBy: { seat: 'asc' } } } } },
    });
    const recent: RecentGame[] = seats.map((mine) => ({
      gameId: mine.gameId,
      endedAt: mine.game.endedAt.getTime(),
      mode: mine.game.mode as GameMode,
      teams: mine.game.teams,
      endReason: mine.game.endReason as GameEndReason,
      rated: mine.game.rated,
      result: mine.result as PlayerResult,
      ratingBefore: mine.ratingBefore,
      ratingAfter: mine.ratingAfter,
      botAssisted: mine.botAssisted,
      others: mine.game.players
        .filter((p) => p.seat !== mine.seat)
        .map((p) => ({ nickname: p.nickname, isBot: p.isBot, profileId: p.profileId, result: p.result as PlayerResult })),
    }));

    return {
      profileId: profile.id,
      nickname: profile.nickname,
      rating: profile.rating,
      games: profile.games,
      ratedGames: profile.ratedGames,
      wins: profile.wins,
      duraks: profile.duraks,
      forfeits: profile.forfeits,
      rank,
      recent,
    };
  }

  async leaderboard(): Promise<LeaderboardResponse> {
    const rows = await this.db().profile.findMany({
      where: { ratedGames: { gt: 0 } },
      orderBy: [{ rating: 'desc' }, { id: 'asc' }],
      take: LEADERBOARD_SIZE,
      select: { id: true, nickname: true, rating: true, ratedGames: true, wins: true, duraks: true },
    });
    return {
      entries: rows.map((r, i) => ({
        rank: i + 1,
        profileId: r.id,
        nickname: r.nickname,
        rating: r.rating,
        ratedGames: r.ratedGames,
        wins: r.wins,
        duraks: r.duraks,
      })),
    };
  }
}
