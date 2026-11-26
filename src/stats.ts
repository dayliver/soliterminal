import type { DrawMode } from './core/klondike.ts';
import type { Level } from './core/solver.ts';

/**
 * Every game played, by seed: the statistics are worked out from these, so
 * each number can be traced to the deals behind it.
 */
export interface GameRecord {
  readonly seed: number;
  readonly drawMode: DrawMode;
  /** `playing` until it is won or given up; a game kept for later stays `playing`. */
  readonly result: 'won' | 'lost' | 'playing';
  /** Time on the clock and moves when it ended; 0 while playing. */
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
 * Where sharing stands. Results go out in batches of whole thousands of
 * games, and only when the player says yes when asked.
 */
export interface ShareState {
  /** A random name for this installation, so a batch sent twice is not counted twice. Nothing else about the player. */
  readonly id: string;
  /** Games sent so far. */
  readonly sent: number;
  /** Finished games (sent or not) when the player was last asked. */
  readonly asked: number;
  /** The player said yes and the batch has not gone through yet: it is sent on the next start. */
  readonly pending: boolean;
}

/** The record for one draw mode, worked out from the games. */
export interface ModeStats {
  /** Games in which at least one card was moved. */
  readonly played: number;
  readonly won: number;
  /** Wins in a row, up to now. */
  readonly streak: number;
  readonly bestStreak: number;
  readonly bestMs?: number;
  readonly fewestMoves?: number;
}

/** Plenty for years of play, while keeping the file small. */
export const MAX_GAMES = 10_000;

export const EMPTY_STATS: Stats = { games: [] };

/** Which game this is and when, for the record. */
export interface GameId {
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
    } else if (g.result === 'lost') {
      run = 0;
    }
    // A game still being played neither adds to the streak nor ends it.
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

const push = (stats: Stats, game: GameRecord): Stats => ({ ...stats, games: [game, ...stats.games].slice(0, MAX_GAMES) });

/** Marks the newest unfinished game with this deal as ended; one not on record is added. */
function finish(stats: Stats, drawMode: DrawMode, change: Pick<GameRecord, 'result' | 'ms' | 'moves' | 'redeals' | 'lostAt'>, game: GameId): Stats {
  const ended = (g: GameRecord): GameRecord => ({
    seed: g.seed,
    drawMode: g.drawMode,
    at: g.at,
    ...(g.limit === undefined ? {} : { limit: g.limit }),
    result: change.result,
    ms: change.ms,
    moves: change.moves,
    ...(change.redeals === undefined ? {} : { redeals: change.redeals }),
    ...(change.lostAt === undefined ? {} : { lostAt: change.lostAt }),
  });
  const i = stats.games.findIndex((g) => g.seed === game.seed && g.drawMode === drawMode && g.result === 'playing');
  if (i < 0) return push(stats, ended({ seed: game.seed, drawMode, result: 'playing', ms: 0, moves: 0, at: game.at, ...limitOf(game) }));
  const games = [...stats.games];
  games[i] = ended(games[i]!);
  return { ...stats, games };
}

/** A game counts as played from its first card moved. */
export function recordStart(stats: Stats, drawMode: DrawMode, game: GameId): Stats {
  return push(stats, { seed: game.seed, drawMode, result: 'playing', ms: 0, moves: 0, at: game.at, ...limitOf(game) });
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
): { stats: Stats; record: WinRecord } {
  const before = statsFor(stats, drawMode);
  // Not on the very first win: there is nothing to beat yet.
  const bestTime = before.bestMs !== undefined && ms < before.bestMs;
  const fewestMoves = before.fewestMoves !== undefined && moves < before.fewestMoves;
  const next = finish(stats, drawMode, { result: 'won', ms, moves, redeals: game.redeals }, game);
  return { stats: next, record: { ms, moves, redeals: game.redeals, bestTime, fewestMoves } };
}

/** A game left unfinished (a new deal, or replaced on start) is a loss: it ends the streak. */
export function recordLoss(stats: Stats, drawMode: DrawMode, end: GameEnd): Stats {
  return finish(stats, drawMode, { result: 'lost', ms: end.ms, moves: end.moves, lostAt: end.lostAt }, end);
}

/** The newest lost game not rated yet: the background rates them one at a time. */
export function unrated(stats: Stats): GameRecord | undefined {
  return stats.games.find((g) => g.result === 'lost' && g.level === undefined);
}

/** Sets the level of the game `game` (a record from `stats`, matched by deal and start). */
export function withLevel(stats: Stats, game: GameRecord, level: Level): Stats {
  const i = stats.games.findIndex((g) => g.seed === game.seed && g.drawMode === game.drawMode && g.at === game.at);
  if (i < 0) return stats;
  const games = [...stats.games];
  games[i] = { ...games[i]!, level };
  return { ...stats, games };
}

/** The newest game with this deal that ended `result`, if any. */
export function pastGame(stats: Stats, seed: number, drawMode: DrawMode, result: 'won' | 'lost'): GameRecord | undefined {
  return stats.games.find((g) => g.seed === seed && g.drawMode === drawMode && g.result === result);
}

export function winRate(m: ModeStats): number {
  return m.played === 0 ? 0 : Math.round((m.won / m.played) * 100);
}

/**
 * Accepts only games that look right; anything else is left out. Files from
 * before games were kept by seed held bare counts, which are dropped.
 */
export function parseStats(json: unknown): Stats {
  const o = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const games = (Array.isArray(o.games) ? o.games : []).flatMap((x): GameRecord[] => {
    if (typeof x !== 'object' || x === null) return [];
    const g = x as Record<string, unknown>;
    if (!Number.isInteger(g.seed) || (g.seed as number) < 0 || (g.drawMode !== 1 && g.drawMode !== 3)) return [];
    if (g.result !== 'won' && g.result !== 'lost' && g.result !== 'playing') return [];
    const redeals = g.result === 'won' && typeof g.redeals === 'number' ? { redeals: count(g.redeals) } : {};
    const limit = g.limit === null ? { limit: null } : Number.isInteger(g.limit) && (g.limit as number) >= 0 ? { limit: g.limit as number } : {};
    const lostAt = g.result === 'lost' && typeof g.lostAt === 'number' ? { lostAt: count(g.lostAt) } : {};
    const level = g.result === 'lost' && (g.level === 0 || g.level === 1 || g.level === 2 || g.level === 3) ? { level: g.level as Level } : {};
    const sent = g.sent === true && g.result !== 'playing' ? { sent: true as const } : {};
    return [{ seed: g.seed as number, drawMode: g.drawMode, result: g.result, ms: count(g.ms), moves: count(g.moves), at: count(g.at), ...redeals, ...limit, ...lostAt, ...level, ...sent }];
  });
  const sh = typeof o.share === 'object' && o.share !== null ? (o.share as Record<string, unknown>) : undefined;
  const share =
    sh && typeof sh.id === 'string' && /^[0-9a-f-]{36}$/.test(sh.id)
      ? { share: { id: sh.id, sent: count(sh.sent), asked: count(sh.asked), pending: sh.pending === true } }
      : {};
  return { games: games.slice(0, MAX_GAMES), ...share };
}
