/**
 * The game in progress, kept on disk so it outlives the terminal: quit, and
 * the next start carries on where it stopped. The file also lets other tools
 * see the board without asking the running game.
 *
 * There is one such file, and whichever window saved last wins it. A game
 * played in two windows at once keeps one name (its id), so however many of
 * them finish it, the statistics count it once.
 *
 * Only the deal and the moves since are stored, as steps that replay with the
 * game's own rules, so the file stays small and a damaged one is caught.
 */
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type App, playTime } from './app.ts';
import { GAME_ID, newGameId } from './stats.ts';
import { writeWhole } from './stats-file.ts';
import { type DrawMode, type KlondikeState, type PileId, type Step, FOUNDATIONS, TABLEAU_COLUMNS, deal, draw, move, steps } from './core/klondike.ts';

export type { Step };

export interface SavedGame {
  readonly version: 2;
  readonly savedAt: string;
  /** The game's name in the statistics; see {@link GameRecord.id}. */
  readonly id: string;
  /** When it started counting (its first card moved), if it has. */
  readonly at?: number;
  readonly seed: number;
  readonly drawMode: DrawMode;
  /** Redeals the deal started with; `null` for no limit (JSON has no Infinity). */
  readonly redeals: number | null;
  /** The deal was proven winnable. */
  readonly verified: boolean;
  /** Whether the game already counts in the statistics. */
  readonly play: 'fresh' | 'counted';
  /** Time on the clock so far. */
  readonly ms: number;
  /** From the deal to the current position. Undone moves are not in it. */
  readonly steps: readonly Step[];
  /** How many steps in the last position known to be winnable lies, for z after a loss. Absent: the deal. */
  readonly winnable?: number;
}

/** Where the game in progress lives: SOLITERMINAL_GAME if set, else next to the statistics. */
export function savedGamePath(env: NodeJS.ProcessEnv, statsFile: string): string {
  return env.SOLITERMINAL_GAME ?? join(dirname(statsFile), 'current.json');
}

// ---------------------------------------------------------------------------
// Steps

/** Every card where it lies, foundations in place: unlike positionKey, which foundation holds what matters here. */
const exact = (s: KlondikeState): string => JSON.stringify([s.redealsLeft, s.stock, s.waste, s.foundations, s.tableau]);

const samePosition = (a: KlondikeState, b: KlondikeState): boolean => exact(a) === exact(b);

/** The step that turns `before` into `after`, if one does. */
function stepBetween(before: KlondikeState, after: KlondikeState): Step | undefined {
  const want = exact(after);
  return steps(before).find((s) => exact(s.state) === want)?.step;
}

/** Steps found so far, by the position they lead to: each save only works out the new ones. */
const known = new WeakMap<KlondikeState, Step>();

/** The steps along a game's path, from `states[0]` (the deal) to its last. Undefined if any link is not one step. */
export function stepsOf(states: readonly KlondikeState[]): Step[] | undefined {
  const steps: Step[] = [];
  for (let i = 1; i < states.length; i++) {
    const after = states[i]!;
    const step = known.get(after) ?? stepBetween(states[i - 1]!, after);
    if (!step) return undefined;
    known.set(after, step);
    steps.push(step);
  }
  return steps;
}

/** Replays a saved game with the game's rules: every position from the deal on, or undefined if a step is not legal. */
export function replaySaved(saved: SavedGame): KlondikeState[] | undefined {
  let s = deal(saved.seed, saved.drawMode, saved.redeals ?? Infinity);
  const states = [s];
  for (const step of saved.steps) {
    const r = 'draw' in step ? draw(s) : move(s, step.from, step.to, step.count);
    if (!r.ok) return undefined;
    s = r.state;
    states.push(s);
  }
  return states;
}

/**
 * What to write for `app`, or undefined when there is nothing to keep: a
 * finished game, or one whose path cannot be put into steps.
 */
export function snapshot(app: App, now: number): SavedGame | undefined {
  if (app.finishedAt !== undefined || app.play === 'won') return undefined;
  const states = [...app.history, app.game];
  const first = states[0]!;
  const steps = stepsOf(states);
  if (!steps || !samePosition(first, deal(first.seed, first.drawMode, first.redealsLeft))) return undefined;
  const w = winnableAt(app, states);
  return {
    version: 2,
    savedAt: new Date(now).toISOString(),
    id: app.gameId,
    ...(app.gameAt === undefined ? {} : { at: app.gameAt }),
    seed: first.seed,
    drawMode: first.drawMode,
    redeals: Number.isFinite(first.redealsLeft) ? first.redealsLeft : null,
    verified: app.verified,
    play: app.play,
    ms: Math.round(playTime(app, now)),
    steps,
    ...(w === undefined ? {} : { winnable: w }),
  };
}

/** Where along `states` the app's last winnable position is, if it is on the path. */
function winnableAt(app: App, states: readonly KlondikeState[]): number | undefined {
  const at = app.lastWinnable?.history.length;
  return at !== undefined && states[at] === app.lastWinnable!.game ? at : undefined;
}

// ---------------------------------------------------------------------------
// Reading what is on disk

const isPile = (p: unknown): p is PileId => {
  if (typeof p !== 'object' || p === null) return false;
  const { kind, index } = p as { kind?: unknown; index?: unknown };
  if (kind === 'waste') return true;
  const limit = kind === 'foundation' ? FOUNDATIONS : kind === 'tableau' ? TABLEAU_COLUMNS : 0;
  return Number.isInteger(index) && (index as number) >= 0 && (index as number) < limit;
};

const isStep = (s: unknown): s is Step => {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  if (o.draw === true) return true;
  return isPile(o.from) && isPile(o.to) && Number.isInteger(o.count) && (o.count as number) >= 1 && (o.count as number) <= 13;
};

/** Checks the shape of what was read; anything odd means there is no saved game. */
export function parseSavedGame(data: unknown): SavedGame | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const o = data as Record<string, unknown>;
  // Version 1 also named the process that wrote it; that is no longer needed.
  if (o.version !== 1 && o.version !== 2) return undefined;
  if (!Number.isInteger(o.seed) || (o.drawMode !== 1 && o.drawMode !== 3)) return undefined;
  if (o.redeals !== null && !(Number.isInteger(o.redeals) && (o.redeals as number) >= 0)) return undefined;
  if (o.play !== 'fresh' && o.play !== 'counted') return undefined;
  if (!Array.isArray(o.steps) || !o.steps.every(isStep)) return undefined;
  return {
    version: 2,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
    id: typeof o.id === 'string' && GAME_ID.test(o.id) ? o.id : newGameId(),
    ...(Number.isInteger(o.at) && (o.at as number) > 0 ? { at: o.at as number } : {}),
    seed: o.seed as number,
    drawMode: o.drawMode,
    redeals: o.redeals as number | null,
    verified: o.verified === true,
    play: o.play,
    ms: typeof o.ms === 'number' && o.ms >= 0 ? o.ms : 0,
    steps: o.steps,
    ...(Number.isInteger(o.winnable) && (o.winnable as number) >= 0 && (o.winnable as number) <= o.steps.length ? { winnable: o.winnable as number } : {}),
  };
}

/** A missing, damaged or unreadable file means no saved game. */
export function loadSavedGame(path: string): SavedGame | undefined {
  try {
    return parseSavedGame(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Says whether the game was written; a crash never leaves half a game. Never throws. */
export function writeSavedGame(path: string, game: SavedGame): boolean {
  return writeWhole(path, JSON.stringify(game) + '\n');
}

export function removeSavedGame(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing to do: the next save or start sorts it out.
  }
}
