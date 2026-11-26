import { randomBytes } from 'node:crypto';
import type { DrawMode } from './core/klondike.ts';
import type { Level } from './core/solver.ts';

/**
 * Every game finished, by seed: the statistics are worked out from these, so
 * each number can be traced to the deals behind it. A game goes on record
 * when it ends, won or given up; one still being played is not on record.
 */
export interface GameRecord {
  /** Names this play of the deal, so the same game is never counted twice (two windows, say). */
  readonly id: string;
  readonly seed: number;
  readonly drawMode: DrawMode;
  readonly result: 'won' | 'lost';
  /** Time on the clock and moves when it ended. */
  readonly ms: number;
  readonly moves: number;
  /** When it started (its first card moved), in ms since the epoch. */
  readonly at: number;
  /** For a win: how many times the waste was turned over. */
  readonly redeals?: number;
  /** Redeals the deal allowed, `null` for no limit; together with seed and mode it makes the deal. */
  readonly limit?: number | null;
  /**
   * For a loss proven while playing: the move that lost it (1 is the first
   * move; 0 means the deal could not be won at all). Absent when the game was
   * given up while it might still have been won.
   */
  readonly lostAt?: number;
  /** For a loss: how hard the deal is, rated in the background once it is over. */
  readonly level?: Level;
  /** Sent for research already. */
  readonly sent?: true;
}

export interface Stats {
  /** Most recent first. */
  readonly games: readonly GameRecord[];
  /** Sharing results for research; absent until the first question. */
  readonly share?: ShareState;
}

/**
 * Where sharing stands. Results go out in batches of whole hundreds of games,
 * and only when the player says yes when asked.
 */
export interface ShareState {
  /** A random name for this installation, so a batch sent twice is not counted twice. Nothing else about the player. */
  readonly id: string;
  /** Finished games when the player was last asked. */
  readonly asked: number;
  /** The player said yes and the batch has not gone through yet: it is sent on the next start. */
  readonly pending: boolean;
}

/**
 * One line of the statistics log. The log is only ever appended to, so games
 * finished in two windows at once both land: a finished game, a level found
 * for one later, or a batch of games sent for research.
 */
export type StatEvent = { readonly game: GameRecord } | { readonly level: { readonly id: string; readonly level: Level } } | { readonly sent: readonly string[] };

/** The record for one draw mode, worked out from the games. */
export interface ModeStats {
  /** Games finished, won or given up. */
  readonly played: number;
  readonly won: number;
  /** Wins in a row, up to now. */
  readonly streak: number;
  readonly bestStreak: number;
  readonly bestMs?: number;
  readonly fewestMoves?: number;
}

export const EMPTY_STATS: Stats = { games: [] };

/** A fresh name for a game. */
export const newGameId = (): string => randomBytes(8).toString('hex');

/** Which game this is and when, for the record. */
export interface GameId {
  readonly id: string;
  readonly seed: number;
  readonly at: number;
  /** Redeals the deal allows (`Infinity` for no limit). */
  readonly limit?: number;
}

const limitOf = (game: GameId): { limit?: number | null } =>
  game.limit === undefined ? {} : { limit: Number.isFinite(game.limit) ? game.limit : null };

/** How a game ended. */
export interface GameEnd extends GameId {
  readonly ms: number;
  readonly moves: number;
  /** See {@link GameRecord.lostAt}. */
  readonly lostAt?: number;
}

export function statsFor(stats: Stats, drawMode: DrawMode): ModeStats {
  // Oldest first, so runs of wins can be counted as they happened.
  const games = stats.games.filter((g) => g.drawMode === drawMode).reverse();
  let won = 0;
  let run = 0;
  let bestStreak = 0;
  let bestMs: number | undefined;
  let fewestMoves: number | undefined;
  for (const g of games) {
    if (g.result === 'won') {
      won++;
      run++;
      bestStreak = Math.max(bestStreak, run);
      if (bestMs === undefined || g.ms < bestMs) bestMs = g.ms;
      if (fewestMoves === undefined || g.moves < fewestMoves) fewestMoves = g.moves;
    } else {
      run = 0;
    }
  }
  return {
    played: games.length,
    won,
    streak: run,
    bestStreak,
    ...(bestMs === undefined ? {} : { bestMs }),
    ...(fewestMoves === undefined ? {} : { fewestMoves }),
  };
}

/** Adds a finished game, unless a game with its id is on record already. */
export function addGame(stats: Stats, game: GameRecord): Stats {
  if (stats.games.some((g) => g.id === game.id)) return stats;
  return { ...stats, games: [game, ...stats.games] };
}

/** What a win changed, for the win dialog. */
export interface WinRecord {
  readonly ms: number;
  readonly moves: number;
  readonly redeals: number;
  readonly bestTime: boolean;
  readonly fewestMoves: boolean;
}

export function recordWin(
  stats: Stats,
  drawMode: DrawMode,
  ms: number,
  moves: number,
  game: GameId & { readonly redeals: number },
): { stats: Stats; record: WinRecord; game: GameRecord } {
  const before = statsFor(stats, drawMode);
  // Not on the very first win: there is nothing to beat yet.
  const bestTime = before.bestMs !== undefined && ms < before.bestMs;
  const fewestMoves = before.fewestMoves !== undefined && moves < before.fewestMoves;
  const record: GameRecord = { id: game.id, seed: game.seed, drawMode, result: 'won', ms, moves, at: game.at, redeals: game.redeals, ...limitOf(game) };
  return { stats: addGame(stats, record), record: { ms, moves, redeals: game.redeals, bestTime, fewestMoves }, game: record };
}

/** A game given up (a new deal, or the saved game replaced) is a loss: it ends the streak. */
export function recordLoss(stats: Stats, drawMode: DrawMode, end: GameEnd): { stats: Stats; game: GameRecord } {
  const record: GameRecord = {
    id: end.id,
    seed: end.seed,
    drawMode,
    result: 'lost',
    ms: end.ms,
    moves: end.moves,
    at: end.at,
    ...limitOf(end),
    ...(end.lostAt === undefined ? {} : { lostAt: end.lostAt }),
  };
  return { stats: addGame(stats, record), game: record };
}

/** The newest lost game not rated yet: the background rates them one at a time. */
export function unrated(stats: Stats): GameRecord | undefined {
  return stats.games.find((g) => g.result === 'lost' && g.level === undefined);
}

/** Sets the level of the game with this id. */
export function withLevel(stats: Stats, id: string, level: Level): Stats {
  const i = stats.games.findIndex((g) => g.id === id);
  if (i < 0) return stats;
  const games = [...stats.games];
  games[i] = { ...games[i]!, level };
  return { ...stats, games };
}

/** Marks these games sent. */
export function withSent(stats: Stats, ids: readonly string[]): Stats {
  const done = new Set(ids);
  return { ...stats, games: stats.games.map((g) => (done.has(g.id) && !g.sent ? { ...g, sent: true as const } : g)) };
}

/** The newest game with this deal that ended `result`, if any. */
export function pastGame(stats: Stats, seed: number, drawMode: DrawMode, result: 'won' | 'lost'): GameRecord | undefined {
  return stats.games.find((g) => g.seed === seed && g.drawMode === drawMode && g.result === result);
}

export function winRate(m: ModeStats): number {
  return m.played === 0 ? 0 : Math.round((m.won / m.played) * 100);
}

// ---------------------------------------------------------------------------
// The log on disk

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const isLevel = (v: unknown): v is Level => v === 0 || v === 1 || v === 2 || v === 3;
/** What a game's id looks like: see {@link newGameId}. */
export const GAME_ID = /^[0-9a-f]{8,32}$/;

/** One game as read back, or undefined if anything about it is off. `id` stands in for a record without one (old files). */
export function parseGame(x: unknown, id?: string): GameRecord | undefined {
  if (typeof x !== 'object' || x === null) return undefined;
  const g = x as Record<string, unknown>;
  const gid = typeof g.id === 'string' && GAME_ID.test(g.id) ? g.id : id;
  if (gid === undefined) return undefined;
  if (!Number.isInteger(g.seed) || (g.seed as number) < 0 || (g.drawMode !== 1 && g.drawMode !== 3)) return undefined;
  if (g.result !== 'won' && g.result !== 'lost') return undefined;
  const redeals = g.result === 'won' && typeof g.redeals === 'number' ? { redeals: count(g.redeals) } : {};
  const limit = g.limit === null ? { limit: null } : Number.isInteger(g.limit) && (g.limit as number) >= 0 ? { limit: g.limit as number } : {};
  const lostAt = g.result === 'lost' && typeof g.lostAt === 'number' ? { lostAt: count(g.lostAt) } : {};
  const level = g.result === 'lost' && isLevel(g.level) ? { level: g.level } : {};
  const sent = g.sent === true ? { sent: true as const } : {};
  return { id: gid, seed: g.seed as number, drawMode: g.drawMode, result: g.result, ms: count(g.ms), moves: count(g.moves), at: count(g.at), ...redeals, ...limit, ...lostAt, ...level, ...sent };
}

/** The line written for an event. */
export function eventLine(e: StatEvent): string {
  return JSON.stringify(e) + '\n';
}

/**
 * Works the games out from the log, oldest line first. A game is counted
 * once, by the first line that finished it; damaged lines (a crash halfway
 * through a write, say) are skipped.
 */
export function foldLog(text: string): Stats {
  const games: GameRecord[] = [];
  const at = new Map<string, number>();
  const levels = new Map<string, Level>();
  const sent = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof e !== 'object' || e === null) continue;
    if ('game' in e) {
      const g = parseGame(e.game);
      if (g && !at.has(g.id)) {
        at.set(g.id, games.length);
        games.push(g);
      }
    } else if ('level' in e && typeof e.level === 'object' && e.level !== null) {
      const { id, level } = e.level as Record<string, unknown>;
      if (typeof id === 'string' && isLevel(level)) levels.set(id, level);
    } else if ('sent' in e && Array.isArray(e.sent)) {
      for (const id of e.sent) if (typeof id === 'string') sent.add(id);
    }
  }
  const done = games.map((g) => {
    const level = levels.get(g.id);
    return {
      ...g,
      ...(g.result === 'lost' && level !== undefined ? { level } : {}),
      ...(sent.has(g.id) ? { sent: true as const } : {}),
    };
  });
  return { games: done.reverse() };
}

/** The share state as read back, or undefined if it is missing or odd. */
export function parseShare(json: unknown): ShareState | undefined {
  const sh = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : undefined;
  if (!sh || typeof sh.id !== 'string' || !/^[0-9a-f-]{36}$/.test(sh.id)) return undefined;
  return { id: sh.id, asked: count(sh.asked), pending: sh.pending === true };
}

/**
 * The statistics file from before the log (`stats.json`): games newest
 * first, unfinished ones left out. Each game is given an id as it moves over.
 */
export function parseLegacyStats(json: unknown): { games: GameRecord[]; share?: ShareState } {
  const o = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const games = (Array.isArray(o.games) ? o.games : []).flatMap((x) => {
    const g = parseGame(x, newGameId());
    return g ? [g] : [];
  });
  const share = parseShare(o.share);
  return { games, ...(share ? { share } : {}) };
}
