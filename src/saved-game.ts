/**
 * The game in progress, kept on disk so it outlives the terminal: quit, and
 * the next start carries on where it stopped. The file also lets other tools
 * see the board without asking the running game.
 *
 * Only the deal and the moves since are stored, as steps that replay with the
 * game's own rules, so the file stays small and a damaged one is caught.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type App, playTime } from './app.ts';
import type { Card } from './core/card.ts';
import {
  type DrawMode,
  type KlondikeState,
  type PileId,
  type Result,
  FOUNDATIONS,
  TABLEAU_COLUMNS,
  deal,
  draw,
  maxTake,
  move,
  pile,
  samePile,
} from './core/klondike.ts';

/** One step from a position to the next: a draw, or a move of `count` cards. */
export type Step = { readonly draw: true } | { readonly from: PileId; readonly to: PileId; readonly count: number };

export interface SavedGame {
  readonly version: 1;
  /** The process that wrote it, so a second game running at once leaves it alone. */
  readonly pid: number;
  readonly savedAt: string;
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

const cardsKey = (cards: readonly Card[]) => cards.map((c) => c.suit + c.rank).join(',');

/** Exact equality of positions, foundations in place: unlike positionKey, which foundation holds what matters here. */
function samePosition(a: KlondikeState, b: KlondikeState): boolean {
  if (a.redealsLeft !== b.redealsLeft || cardsKey(a.stock) !== cardsKey(b.stock) || cardsKey(a.waste) !== cardsKey(b.waste)) return false;
  for (let i = 0; i < FOUNDATIONS; i++) if (cardsKey(a.foundations[i]!) !== cardsKey(b.foundations[i]!)) return false;
  for (let i = 0; i < TABLEAU_COLUMNS; i++) {
    const x = a.tableau[i]!;
    const y = b.tableau[i]!;
    if (cardsKey(x.down) !== cardsKey(y.down) || cardsKey(x.up) !== cardsKey(y.up)) return false;
  }
  return true;
}

const PILES: PileId[] = [
  pile.waste,
  ...Array.from({ length: FOUNDATIONS }, (_, i) => pile.foundation(i)),
  ...Array.from({ length: TABLEAU_COLUMNS }, (_, i) => pile.tableau(i)),
];

/** The step that turns `before` into `after`, if one does. */
export function stepBetween(before: KlondikeState, after: KlondikeState): Step | undefined {
  const d = draw(before);
  if (d.ok && samePosition(d.state, after)) return { draw: true };
  for (const from of PILES) {
    const max = maxTake(before, from);
    for (let count = 1; count <= max; count++) {
      for (const to of PILES) {
        if (to.kind === 'waste' || samePile(from, to)) continue;
        const r = move(before, from, to, count);
        if (r.ok && samePosition(r.state, after)) return { from, to, count };
      }
    }
  }
  return undefined;
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
    const r: Result = 'draw' in step ? draw(s) : move(s, step.from, step.to, step.count);
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
export function snapshot(app: App, now: number, pid = process.pid): SavedGame | undefined {
  if (app.finishedAt !== undefined || app.play === 'won') return undefined;
  const states = [...app.history, app.game];
  const first = states[0]!;
  const steps = stepsOf(states);
  if (!steps || !samePosition(first, deal(first.seed, first.drawMode, first.redealsLeft))) return undefined;
  return {
    version: 1,
    pid,
    savedAt: new Date(now).toISOString(),
    seed: first.seed,
    drawMode: first.drawMode,
    redeals: Number.isFinite(first.redealsLeft) ? first.redealsLeft : null,
    verified: app.verified,
    play: app.play,
    ms: Math.round(playTime(app, now)),
    steps,
    ...(winnableAt(app, states) === undefined ? {} : { winnable: winnableAt(app, states) }),
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
  if (o.version !== 1) return undefined;
  if (!Number.isInteger(o.seed) || (o.drawMode !== 1 && o.drawMode !== 3)) return undefined;
  if (o.redeals !== null && !(Number.isInteger(o.redeals) && (o.redeals as number) >= 0)) return undefined;
  if (o.play !== 'fresh' && o.play !== 'counted') return undefined;
  if (!Array.isArray(o.steps) || !o.steps.every(isStep)) return undefined;
  return {
    version: 1,
    pid: Number.isInteger(o.pid) ? (o.pid as number) : 0,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
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

/** Writes through a temporary file, so a crash never leaves half a game. Never throws. */
export function writeSavedGame(path: string, game: SavedGame): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(game) + '\n');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export function removeSavedGame(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing to do: the next save or start sorts it out.
  }
}

/** Whether another live process wrote this game: then it is that game's, not ours. */
export function ownedElsewhere(saved: SavedGame, pid = process.pid): boolean {
  if (!saved.pid || saved.pid === pid) return false;
  try {
    process.kill(saved.pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
