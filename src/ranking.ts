import type { Mode } from './sim';
import type { RunRecord } from './storage';

/**
 * Ranking interface (Gate 03 §6). Only the data contract and a local implementation exist; nothing in the UI shows a
 * rank or a top-percent until a server that stores and verifies real user runs provides one.
 *
 * Contract for a future server:
 *   POST /runs            body: RunRecord            → { accepted: boolean; runId: string }
 *   GET  /leaderboard?mode=A&gameVersion=gate03&difficultyVersion=g3.1&limit=100 → LeaderboardEntry[]
 *   GET  /rank?mode=A&gameVersion=gate03&difficultyVersion=g3.1&participantId=P01 → RankResult | null
 * Rules: one entry per participant (their best valid run), survivalTimeMs descending, ties share a rank
 * (competition ranking: 1, 1, 3). Different gameVersion/difficultyVersion are never pooled. reachedLevel is a
 * function of survival time and is not a tie-breaker. The server must not trust the client clock blindly.
 */
export interface LeaderboardQuery { mode: Mode; gameVersion: string; difficultyVersion: string }
export interface LeaderboardEntry { rank: number; participantId: string; survivalTimeMs: number; reachedLevel: number; createdAt: string }
export interface RankResult { rank: number; total: number; topPercent: number }

export interface RankingProvider {
  readonly source: 'local' | 'remote';
  top(q: LeaderboardQuery, limit: number): Promise<LeaderboardEntry[]>;
  /** null when the provider cannot rank (no server, participant unknown, no valid run). */
  rankOf(q: LeaderboardQuery, participantId: string): Promise<RankResult | null>;
}

/** Best valid run per participant, ranked. Pure, so it can be unit-tested and reused server-side. */
export function rankRuns(runs: RunRecord[], q: LeaderboardQuery): LeaderboardEntry[] {
  const best = new Map<string, RunRecord>();
  for (const r of runs) {
    if (r.mode !== q.mode || r.gameVersion !== q.gameVersion || r.difficultyVersion !== q.difficultyVersion) continue;
    if (r.runValidity !== 'valid' || r.deathReason === 'abandoned' || !r.participantId) continue;
    const cur = best.get(r.participantId);
    if (!cur || r.survivalTimeMs > cur.survivalTimeMs) best.set(r.participantId, r);
  }
  const sorted = [...best.values()].sort((a, b) => b.survivalTimeMs - a.survivalTimeMs || a.createdAt.localeCompare(b.createdAt));
  const out: LeaderboardEntry[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const rank = i > 0 && sorted[i - 1].survivalTimeMs === r.survivalTimeMs ? out[i - 1].rank : i + 1;
    out.push({ rank, participantId: r.participantId, survivalTimeMs: r.survivalTimeMs, reachedLevel: r.reachedLevel, createdAt: r.createdAt });
  }
  return out;
}

/** Runs on this device that count for a board: finished, valid, same mode and rules version (participant may be blank). */
function countable(runs: RunRecord[], q: LeaderboardQuery): RunRecord[] {
  return runs.filter((r) =>
    r.mode === q.mode && r.gameVersion === q.gameVersion && r.difficultyVersion === q.difficultyVersion &&
    r.runValidity === 'valid' && r.deathReason !== 'abandoned');
}

/** The device board (home "RANKING"): best runs stored in this browser, one row per run, competition-ranked. */
export function topRuns(runs: RunRecord[], q: LeaderboardQuery, limit: number): LeaderboardEntry[] {
  const sorted = countable(runs, q).sort((a, b) => b.survivalTimeMs - a.survivalTimeMs || a.createdAt.localeCompare(b.createdAt));
  const out: LeaderboardEntry[] = [];
  for (let i = 0; i < sorted.length && out.length < limit; i++) {
    const r = sorted[i];
    const rank = i > 0 && sorted[i - 1].survivalTimeMs === r.survivalTimeMs ? out[i - 1].rank : i + 1;
    out.push({ rank, participantId: r.participantId, survivalTimeMs: r.survivalTimeMs, reachedLevel: r.reachedLevel, createdAt: r.createdAt });
  }
  return out;
}

/** Arcade initials: up to 3 characters, letters and digits, upper-cased; '' when nothing usable was typed. */
export const BOARD_SIZE = 10;
export function normalizeInitials(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
}

/** Where a survival time stands among the countable runs on this device: competition rank and field size; null with no runs. */
export function deviceRank(runs: RunRecord[], q: LeaderboardQuery, survivalTimeMs: number): { rank: number; total: number } | null {
  const rs = countable(runs, q);
  if (!rs.length) return null;
  return { rank: 1 + rs.filter((r) => r.survivalTimeMs > survivalTimeMs).length, total: rs.length };
}

/** Ranks the runs stored on this device. Useful for tests and facilitator exports; not a public ranking. */
export class LocalRankingProvider implements RankingProvider {
  readonly source = 'local' as const;
  constructor(private readonly runs: () => RunRecord[]) {}
  async top(q: LeaderboardQuery, limit: number) { return rankRuns(this.runs(), q).slice(0, limit); }
  async rankOf(q: LeaderboardQuery, participantId: string) {
    const board = rankRuns(this.runs(), q);
    const me = board.find((e) => e.participantId === participantId);
    return me ? { rank: me.rank, total: board.length, topPercent: +((me.rank / board.length) * 100).toFixed(1) } : null;
  }
}
