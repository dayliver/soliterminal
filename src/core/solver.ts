/**
 * Klondike solver. It sees every card, face-down ones included, so "solved"
 * means the deal can be won with perfect play.
 *
 * Search is best-first with a transposition table. The game's own immutable
 * state is too slow to copy millions of times, so the solver keeps a compact
 * mutable copy with cards as integers.
 *
 * Stock handling: the stock and waste form one sequence ("talon") with a
 * pointer to how many cards are turned. Drawing on its own never helps, so the
 * solver instead plays any talon card it could reach by drawing, as one move.
 */
import { type Card, type Rank, SUITS, sameCard } from './card.ts';
import {
  type DrawMode,
  type KlondikeState,
  type PileId,
  type Result,
  deal as dealFor,
  draw,
  isWon,
  move,
  moveToFoundation,
  pile,
  positionKey,
  successors,
} from './klondike.ts';

// ---------------------------------------------------------------------------
// Public types

export type MoveSource =
  | { readonly kind: 'talon' }
  | { readonly kind: 'tableau'; readonly index: number }
  | { readonly kind: 'foundation' };

export type MoveTarget = { readonly kind: 'foundation' } | { readonly kind: 'tableau'; readonly index: number };

/** One step of a solution. `card` is the lead card: the bottom of the run that moves. */
export interface SolverMove {
  readonly from: MoveSource;
  readonly to: MoveTarget;
  readonly card: Card;
  readonly count: number;
}

/**
 * A last guard on memory, checked with the clock: a search stops, unanswered,
 * once this says there is no room left. Node caps a worker's heap by itself;
 * Bun does not, so its workers set this (see solver-worker.ts).
 */
let outOfRoom: () => boolean = () => false;
export function limitMemory(check: () => boolean): void {
  outOfRoom = check;
}

export interface SolveOptions {
  /** Give up after visiting this many positions. */
  readonly maxNodes?: number;
  /** Give up after this many milliseconds. */
  readonly timeLimitMs?: number;
  /**
   * Turn off the pruning that is only a heuristic, so `unsolvable` becomes a
   * proof. Slower; used to confirm a loss before telling the player.
   */
  readonly exhaustive?: boolean;
}

export type SolveResult =
  | { readonly status: 'solved'; readonly moves: readonly SolverMove[]; readonly nodes: number; readonly ms: number }
  /**
   * The search ran out of positions without a win. Pruning skips moves that
   * look pointless, so this is a strong hint rather than a proof.
   */
  | { readonly status: 'unsolvable'; readonly nodes: number; readonly ms: number }
  /** The budget ran out first. */
  | { readonly status: 'unknown'; readonly nodes: number; readonly ms: number };

// ---------------------------------------------------------------------------
// Compact state

/** Cards are 0..51: suit index × 13 + rank − 1, with suits in `SUITS` order. */
const suitOf = (c: number) => (c / 13) | 0;
const rankOf = (c: number) => (c % 13) + 1;
const isRed = (c: number) => {
  const s = suitOf(c);
  return s === 1 || s === 2;
};
const toInt = (card: Card) => SUITS.indexOf(card.suit) * 13 + card.rank - 1;
const toCard = (c: number): Card => ({ suit: SUITS[suitOf(c)]!, rank: rankOf(c) as Rank });

interface S {
  /** Bottom to top. The first `down[i]` cards of column i are face down. */
  cols: number[][];
  down: number[];
  /** Cards on the foundation of each suit, 0..13. */
  found: number[];
  /** Waste (bottom to top) followed by the stock in the order it will be turned. */
  talon: number[];
  /** How many talon cards are turned; `talon[pos - 1]` is the playable top. */
  pos: number;
  /** Redeals left, or {@link UNLIMITED}. */
  left: number;
}

/** Marks a game with no redeal limit. Fits the byte the queue stores it in. */
const UNLIMITED = 255;

function fromGame(state: KlondikeState): S {
  const found = [0, 0, 0, 0];
  for (const f of state.foundations) if (f.length > 0) found[SUITS.indexOf(f[0]!.suit)] = f.length;
  return {
    cols: state.tableau.map((c) => [...c.down, ...c.up].map(toInt)),
    down: state.tableau.map((c) => c.down.length),
    found,
    talon: [...state.waste, ...[...state.stock].reverse()].map(toInt),
    pos: state.waste.length,
    left: Number.isFinite(state.redealsLeft) ? Math.min(Math.max(0, state.redealsLeft), UNLIMITED - 1) : UNLIMITED,
  };
}

const clone = (s: S): S => ({
  cols: s.cols.map((c) => c.slice()),
  down: s.down.slice(),
  found: s.found.slice(),
  talon: s.talon.slice(),
  pos: s.pos,
  left: s.left,
});

const canStack = (card: number, onto: number) => rankOf(onto) === rankOf(card) + 1 && isRed(onto) !== isRed(card);
const fitsFoundation = (s: S, c: number) => s.found[suitOf(c)] === rankOf(c) - 1;
const faceUp = (s: S, i: number) => s.cols[i]!.length - s.down[i]!;

/**
 * Every talon position reachable by drawing from `pos`, as the number of
 * turned cards (≥ 1), with how many redeals reaching it takes. Mirrors the
 * game: draw `n`, and once the stock is out, redeal if any are `left`.
 */
function reach(length: number, pos: number, n: DrawMode, left: number): { at: number[]; redeals: number[] } {
  const at: number[] = [];
  const redeals: number[] = [];
  if (length === 0) return { at, redeals };
  const seen = new Set<number>();
  let p = pos;
  let used = 0;
  for (let guard = 0; guard < 2 * length + 4; guard++) {
    if (p >= 1 && !seen.has(p)) {
      seen.add(p);
      at.push(p);
      redeals.push(used);
    }
    if (p === length) {
      if (used >= left) break;
      p = 0;
      used++;
    } else {
      p = Math.min(p + n, length);
    }
    if (p === pos) break; // round the whole talon: nothing new from here
  }
  return { at, redeals };
}

/** The talon positions reachable from `pos`; see {@link reach}. */
export function reachablePositions(length: number, pos: number, n: DrawMode, redealsLeft = Infinity): number[] {
  return reach(length, pos, n, redealsLeft).at;
}

/**
 * Moving a card home can never lose the game when nothing still on the
 * tableau could need it: both opposite-color cards one rank lower are home,
 * and so is the other same-color card two ranks lower.
 */
function safeToFoundation(s: S, c: number): boolean {
  const r = rankOf(c);
  if (r <= 2) return true;
  const suit = suitOf(c);
  const [oppA, oppB] = isRed(c) ? [0, 3] : [1, 2];
  const sameOther = suit === 1 ? 2 : suit === 2 ? 1 : suit === 0 ? 3 : 0;
  return s.found[oppA]! >= r - 1 && s.found[oppB]! >= r - 1 && s.found[sameOther]! >= r - 2;
}

function flip(s: S, i: number): void {
  if (s.down[i]! > 0 && s.down[i]! >= s.cols[i]!.length) s.down[i] = s.cols[i]!.length - 1;
}

// ---------------------------------------------------------------------------
// Moves

type M =
  | { t: 'tf'; from: number } // tableau → foundation
  | { t: 'xf'; p: number; r: number } // talon card at position p → foundation, after r redeals
  | { t: 'xt'; p: number; r: number; to: number } // talon → tableau
  | { t: 'tt'; from: number; to: number; count: number } // tableau → tableau
  | { t: 'ft'; suit: number; to: number }; // foundation → tableau

function describe(s: S, m: M): SolverMove {
  switch (m.t) {
    case 'tf':
      return { from: { kind: 'tableau', index: m.from }, to: { kind: 'foundation' }, card: toCard(s.cols[m.from]!.at(-1)!), count: 1 };
    case 'xf':
      return { from: { kind: 'talon' }, to: { kind: 'foundation' }, card: toCard(s.talon[m.p - 1]!), count: 1 };
    case 'xt':
      return { from: { kind: 'talon' }, to: { kind: 'tableau', index: m.to }, card: toCard(s.talon[m.p - 1]!), count: 1 };
    case 'tt': {
      const col = s.cols[m.from]!;
      return { from: { kind: 'tableau', index: m.from }, to: { kind: 'tableau', index: m.to }, card: toCard(col[col.length - m.count]!), count: m.count };
    }
    case 'ft':
      return { from: { kind: 'foundation' }, to: { kind: 'tableau', index: m.to }, card: toCard(m.suit * 13 + s.found[m.suit]! - 1), count: 1 };
  }
}

function apply(s: S, m: M): void {
  switch (m.t) {
    case 'tf': {
      const c = s.cols[m.from]!.pop()!;
      s.found[suitOf(c)]!++;
      flip(s, m.from);
      return;
    }
    case 'xf':
    case 'xt': {
      const [c] = s.talon.splice(m.p - 1, 1);
      s.pos = m.p - 1;
      if (s.left !== UNLIMITED) s.left -= m.r;
      if (m.t === 'xf') s.found[suitOf(c!)]!++;
      else s.cols[m.to]!.push(c!);
      return;
    }
    case 'tt': {
      const col = s.cols[m.from]!;
      const run = col.splice(col.length - m.count, m.count);
      s.cols[m.to]!.push(...run);
      flip(s, m.from);
      return;
    }
    case 'ft': {
      s.found[m.suit]!--;
      s.cols[m.to]!.push(m.suit * 13 + s.found[m.suit]!);
      return;
    }
  }
}

/**
 * Candidate moves, most promising first.
 *
 * Some moves are always left out because they provably change nothing: a
 * second empty column, a king already at the bottom moving to an empty column,
 * an ace leaving its foundation, or drawing without playing. Unless
 * `exhaustive`, moves that merely look pointless are dropped too; that costs
 * coverage but never correctness, since every solution is replayed.
 */
function generate(s: S, drawMode: DrawMode, exhaustive: boolean): M[] {
  const scored: { m: M; score: number }[] = [];
  const add = (m: M, score: number) => scored.push({ m, score });
  const talon = reach(s.talon.length, s.pos, drawMode, s.left === UNLIMITED ? Infinity : s.left);
  const reachable = talon.at;
  // Redeals a move costs. Without a limit they are free, but solutions that
  // spend few still replay under one, so they are tried first either way.
  const redeals = (i: number) => talon.redeals[i]!;
  const n = s.cols.length;

  // Cards that could be picked up and moved somewhere: face-up tableau cards and reachable talon cards.
  const usable = new Array<boolean>(52).fill(false);
  let kingWaiting = false; // a king that would like an empty column
  for (let i = 0; i < n; i++) {
    const col = s.cols[i]!;
    for (let k = s.down[i]!; k < col.length; k++) {
      usable[col[k]!] = true;
      if (rankOf(col[k]!) === 13 && k > 0) kingWaiting = true;
    }
  }
  for (const p of reachable) {
    usable[s.talon[p - 1]!] = true;
    if (rankOf(s.talon[p - 1]!) === 13) kingWaiting = true;
  }
  // Only the first empty column is offered: empty columns are interchangeable.
  const firstEmpty = s.cols.findIndex((c) => c.length === 0);

  for (let i = 0; i < n; i++) {
    const top = s.cols[i]!.at(-1);
    if (top !== undefined && faceUp(s, i) > 0 && fitsFoundation(s, top)) add({ t: 'tf', from: i }, 100 + s.down[i]!);
  }
  reachable.forEach((p, i) => {
    // Reaching a card by redealing spends something scarce, so those moves come later.
    if (fitsFoundation(s, s.talon[p - 1]!)) add({ t: 'xf', p, r: redeals(i) }, 90 - 30 * redeals(i));
  });
  for (let i = 0; i < n; i++) {
    const col = s.cols[i]!;
    const up = faceUp(s, i);
    for (let k = 1; k <= up; k++) {
      const lead = col[col.length - k]!;
      const whole = k === up;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dest = s.cols[j]!;
        if (dest.length === 0) {
          // A king run already at the bottom of its column gains nothing from moving.
          if (j !== firstEmpty || rankOf(lead) !== 13 || (whole && s.down[i] === 0)) continue;
        } else if (!canStack(lead, dest.at(-1)!)) continue;
        if (!exhaustive) {
          if (!whole) {
            // Splitting a run usually only helps if the card it uncovers can then go home.
            if (!fitsFoundation(s, col[col.length - k - 1]!)) continue;
          } else if (s.down[i] === 0 && dest.length > 0 && !kingWaiting) {
            continue; // emptying a column is usually only worth it if a king needs the space
          }
        }
        const score = whole ? (s.down[i]! > 0 ? 60 + s.down[i]! : 20) : 10;
        add({ t: 'tt', from: i, to: j, count: k }, score);
      }
    }
  }
  reachable.forEach((p, i) => {
    const c = s.talon[p - 1]!;
    for (let j = 0; j < n; j++) {
      const dest = s.cols[j]!;
      if (dest.length === 0 ? j === firstEmpty && rankOf(c) === 13 : canStack(c, dest.at(-1)!)) {
        add({ t: 'xt', p, r: redeals(i), to: j }, 40 - 30 * redeals(i));
      }
    }
  });
  for (let suit = 0; suit < 4; suit++) {
    if (s.found[suit]! < 2) continue; // an ace back on the tableau never helps
    const c = suit * 13 + s.found[suit]! - 1;
    // Worth bringing back only if a card that could sit on it is in play.
    const below = (isRed(c) ? [0, 3] : [1, 2]).map((t) => t * 13 + (c % 13) - 1);
    if (!exhaustive && !below.some((x) => usable[x])) continue;
    for (let j = 0; j < n; j++) {
      const top = s.cols[j]!.at(-1);
      if (top !== undefined && canStack(c, top)) add({ t: 'ft', suit, to: j }, 0);
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.m);
}

function key(s: S, drawMode: DrawMode): string {
  // Column order does not matter for whether a position can be won.
  const cols = s.cols.map((c, i) => String.fromCharCode(65 + s.down[i]!, ...c.map((x) => 48 + x))).sort();
  // With no redeal limit, every Draw 1 talon card is always reachable, so the pointer is
  // irrelevant. With a limit, cards behind the pointer cost a redeal, so it matters.
  // Redeals left are not part of the key: see `better` in `solve`.
  const pos = s.left === UNLIMITED && drawMode === 1 ? '' : String.fromCharCode(48 + s.pos);
  return String.fromCharCode(...s.found.map((f) => 48 + f)) + pos + String.fromCharCode(...s.talon.map((x) => 48 + x)) + '|' + cols.join('|');
}

// ---------------------------------------------------------------------------
// Search

/** Positions waiting in the queue are packed into bytes to keep memory small. */
function pack(s: S): Uint8Array {
  const size = 7 + s.talon.length + s.cols.reduce((n, c) => n + 2 + c.length, 0);
  const b = new Uint8Array(size);
  let i = 0;
  for (const f of s.found) b[i++] = f;
  b[i++] = s.pos;
  b[i++] = s.left;
  b[i++] = s.talon.length;
  for (const c of s.talon) b[i++] = c;
  s.cols.forEach((col, k) => {
    b[i++] = s.down[k]!;
    b[i++] = col.length;
    for (const c of col) b[i++] = c;
  });
  return b;
}

function unpack(b: Uint8Array, columns: number): S {
  let i = 0;
  const found = [b[i++]!, b[i++]!, b[i++]!, b[i++]!];
  const pos = b[i++]!;
  const left = b[i++]!;
  const talonLength = b[i++]!;
  const talon = Array.from(b.subarray(i, i + talonLength));
  i += talonLength;
  const cols: number[][] = [];
  const down: number[] = [];
  for (let k = 0; k < columns; k++) {
    down.push(b[i++]!);
    const len = b[i++]!;
    cols.push(Array.from(b.subarray(i, i + len)));
    i += len;
  }
  return { cols, down, found, talon, pos, left };
}

/** Moves are stored as small integers until a solution is rebuilt. */
function encode(m: SolverMove): number {
  const fk = m.from.kind === 'talon' ? 0 : m.from.kind === 'tableau' ? 1 : 2;
  const fi = m.from.kind === 'tableau' ? m.from.index : 0;
  const tk = m.to.kind === 'foundation' ? 0 : 1;
  const ti = m.to.kind === 'tableau' ? m.to.index : 0;
  return fk | (fi << 2) | (tk << 5) | (ti << 6) | (toInt(m.card) << 9) | (m.count << 15);
}

function decode(x: number): SolverMove {
  const fk = x & 3;
  const fi = (x >> 2) & 7;
  const ti = (x >> 6) & 7;
  const from: MoveSource = fk === 0 ? { kind: 'talon' } : fk === 1 ? { kind: 'tableau', index: fi } : { kind: 'foundation' };
  const to: MoveTarget = (x >> 5) & 1 ? { kind: 'tableau', index: ti } : { kind: 'foundation' };
  return { from, to, card: toCard((x >> 9) & 63), count: x >> 15 };
}

/** How promising a position looks. Hidden cards are the main obstacle. */
function score(s: S): number {
  let home = 0;
  let hidden = 0;
  for (const f of s.found) home += f;
  for (const d of s.down) hidden += d;
  // Redeals still in hand are worth keeping.
  const spare = s.left === UNLIMITED ? 0 : s.left * 3;
  return home * 2 - hidden * 6 - s.talon.length + spare;
}

/** Max-heap on score; among equals the newest position wins, which keeps lines of play going. */
class Queue {
  #ids: number[] = [];
  #scores: number[] = [];
  get size() {
    return this.#ids.length;
  }
  #above(a: number, b: number) {
    const sa = this.#scores[a]!;
    const sb = this.#scores[b]!;
    return sa > sb || (sa === sb && this.#ids[a]! > this.#ids[b]!);
  }
  #swap(a: number, b: number) {
    [this.#ids[a], this.#ids[b]] = [this.#ids[b]!, this.#ids[a]!];
    [this.#scores[a], this.#scores[b]] = [this.#scores[b]!, this.#scores[a]!];
  }
  push(id: number, sc: number) {
    this.#ids.push(id);
    this.#scores.push(sc);
    for (let i = this.#ids.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!this.#above(i, parent)) break;
      this.#swap(i, parent);
      i = parent;
    }
  }
  pop(): number {
    const top = this.#ids[0]!;
    const lastId = this.#ids.pop()!;
    const lastScore = this.#scores.pop()!;
    if (this.#ids.length > 0) {
      this.#ids[0] = lastId;
      this.#scores[0] = lastScore;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < this.#ids.length && this.#above(l, best)) best = l;
        if (r < this.#ids.length && this.#above(r, best)) best = r;
        if (best === i) break;
        this.#swap(i, best);
        i = best;
      }
    }
    return top;
  }
}

/** The budget of a search that is not given one. */
const MAX_NODES = 300_000;
const TIME_LIMIT_MS = 5_000;

/**
 * Solves a position.
 *
 * With a redeal limit and `exhaustive` set (proving a loss), the game is first
 * searched as if there were no limit, which is much smaller: if it cannot be
 * won even then, it cannot be won with the limit either. Solutions found that
 * way are not used, since they typically turn the deck over many times; only
 * a search that counts redeals can find one that stays within the limit.
 */
export function solve(state: KlondikeState, options: SolveOptions = {}): SolveResult {
  if (!Number.isFinite(state.redealsLeft) || !options.exhaustive) return search(state, options);
  const start = Date.now();
  const maxNodes = options.maxNodes ?? MAX_NODES;
  const timeLimitMs = options.timeLimitMs ?? TIME_LIMIT_MS;
  const relaxed = search({ ...state, redealsLeft: Infinity }, { ...options, maxNodes: maxNodes / 2, timeLimitMs: timeLimitMs / 2 });
  if (relaxed.status === 'unsolvable') return { ...relaxed, ms: Date.now() - start };
  const exact = search(state, {
    ...options,
    maxNodes: Math.max(1, maxNodes - relaxed.nodes),
    timeLimitMs: Math.max(1, timeLimitMs - (Date.now() - start)),
  });
  return { ...exact, nodes: exact.nodes + relaxed.nodes, ms: Date.now() - start };
}

/**
 * Best-first search: always expands the most promising position seen so far,
 * so one bad early choice cannot swallow the whole budget the way it can in a
 * plain depth-first search.
 */
function search(state: KlondikeState, options: SolveOptions): SolveResult {
  const maxNodes = options.maxNodes ?? MAX_NODES;
  const start = Date.now();
  const deadline = start + (options.timeLimitMs ?? TIME_LIMIT_MS);
  const drawMode = state.drawMode;
  const columns = state.tableau.length;
  /**
   * Positions already queued, with the most redeals any of them had left. The
   * same position with more redeals left can do everything one with fewer can,
   * so it is only worth another look with more.
   */
  const seen = new Map<string, number>();
  const better = (k: string, left: number) => {
    const had = seen.get(k);
    if (had !== undefined && had >= left) return false;
    seen.set(k, left);
    return true;
  };
  const parents: number[] = [];
  const steps: number[][] = [];
  const packed: (Uint8Array | undefined)[] = [];
  const queue = new Queue();

  const step = (s: S, m: M, out: number[]) => {
    out.push(encode(describe(s, m)));
    apply(s, m);
  };

  /** Plays every safe tableau card home. Talon cards are left alone: in Draw 3 they shift the pointer. */
  const playSafe = (s: S, out: number[]) => {
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = 0; i < s.cols.length; i++) {
        const top = s.cols[i]!.at(-1);
        if (top !== undefined && faceUp(s, i) > 0 && fitsFoundation(s, top) && safeToFoundation(s, top)) {
          step(s, { t: 'tf', from: i }, out);
          changed = true;
        }
      }
    }
  };

  /** True once the game is won or trivially winnable; in the latter case plays it out. */
  const finished = (s: S, out: number[]): boolean => {
    if (s.found.every((f) => f === 13)) return true;
    if (s.talon.length > 0 || s.down.some((d) => d > 0)) return false;
    // Only a full deck plays itself out; hand-built test boards may hold fewer cards.
    if (s.found.reduce((a, b) => a + b, 0) + s.cols.reduce((n, c) => n + c.length, 0) !== 52) return false;
    // Everything is face up in valid runs: the lowest top card always goes home next.
    while (s.found.some((f) => f < 13)) {
      let best = -1;
      for (let i = 0; i < s.cols.length; i++) {
        const top = s.cols[i]!.at(-1);
        if (top !== undefined && (best < 0 || rankOf(top) < rankOf(s.cols[best]!.at(-1)!))) best = i;
      }
      step(s, { t: 'tf', from: best }, out);
    }
    return true;
  };

  const solution = (id: number, last: number[]): SolverMove[] => {
    const chain: number[][] = [last];
    for (let n = id; n >= 0; n = parents[n]!) chain.push(steps[n]!);
    return chain.reverse().flat().map(decode);
  };

  const done = (status: 'unsolvable' | 'unknown'): SolveResult => ({ status, nodes: parents.length, ms: Date.now() - start });

  const root = fromGame(state);
  const rootSteps: number[] = [];
  playSafe(root, rootSteps);
  if (finished(root, rootSteps)) return { status: 'solved', moves: rootSteps.map(decode), nodes: 1, ms: Date.now() - start };
  better(key(root, drawMode), root.left);
  parents.push(-1);
  steps.push(rootSteps);
  packed.push(pack(root));
  queue.push(0, score(root));

  while (queue.size > 0) {
    const id = queue.pop();
    const s = unpack(packed[id]!, columns);
    packed[id] = undefined; // expanded positions are only needed for their path
    for (const m of generate(s, drawMode, options.exhaustive ?? false)) {
      const child = clone(s);
      const out: number[] = [];
      step(child, m, out);
      playSafe(child, out);
      if (finished(child, out)) {
        return { status: 'solved', moves: solution(id, out), nodes: parents.length, ms: Date.now() - start };
      }
      if (!better(key(child, drawMode), child.left)) continue;
      if (parents.length >= maxNodes || ((parents.length & 1023) === 0 && (Date.now() > deadline || outOfRoom()))) return done('unknown');
      parents.push(id);
      steps.push(out);
      packed.push(pack(child));
      queue.push(parents.length - 1, score(child));
    }
  }
  return done('unsolvable');
}

// ---------------------------------------------------------------------------
// Replay through the real rules

/**
 * Plays a solution with the game's own `draw` and `move` and returns the final
 * state. Throws if any step is illegal, so a buggy solution can never pass.
 */
export function replay(state: KlondikeState, moves: readonly SolverMove[]): KlondikeState {
  let s = state;
  const step = (r: Result, what: string) => {
    if (!r.ok) throw new Error(`Solution step failed (${r.error}): ${what}`);
    s = r.state;
  };
  moves.forEach((m, i) => {
    const what = `#${i} ${m.card.rank}${m.card.suit} ${m.from.kind} → ${m.to.kind}`;
    let from: PileId;
    if (m.from.kind === 'talon') {
      for (let guard = 0; !sameCard(s.waste.at(-1), m.card); guard++) {
        if (guard > 4 * 52) throw new Error(`Talon card never turned up: ${what}`);
        step(draw(s), what);
      }
      from = pile.waste;
    } else if (m.from.kind === 'tableau') {
      from = pile.tableau(m.from.index);
    } else {
      const f = s.foundations.findIndex((p) => sameCard(p.at(-1), m.card));
      if (f < 0) throw new Error(`Card not on a foundation: ${what}`);
      from = pile.foundation(f);
    }
    if (m.to.kind === 'foundation') step(moveToFoundation(s, from), what);
    else step(move(s, from, pile.tableau(m.to.index), m.count), what);
  });
  return s;
}

/** Solves and double-checks the answer against the real rules. */
export function isSolvable(state: KlondikeState, options?: SolveOptions): SolveResult {
  const result = solve(state, options);
  if (result.status === 'solved' && !isWon(replay(state, result.moves))) {
    throw new Error('Solver produced a solution that does not win');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Verdicts for live play

export type Verdict = 'winnable' | 'lost' | 'unclear';

export interface JudgeOptions {
  /** Budget for the quick, pruned search. */
  readonly quick?: SolveOptions;
  /** Budget for the exhaustive search that must confirm a loss. */
  readonly confirm?: SolveOptions;
  /**
   * Also try the exhaustive search when the quick one runs out of budget,
   * not only when it finds nothing. Slower, but settles more positions.
   */
  readonly thorough?: boolean;
}

export interface Judgement {
  readonly verdict: Verdict;
  readonly ms: number;
  /** With `winnable`: the first move of the win that was found, for a hint. */
  readonly next?: SolverMove;
}

/**
 * Whether a position can still be won. `lost` is only returned when an
 * exhaustive search proves it, so the player is never told they lost when
 * they have not. `winnable` is backed by a replayed solution.
 */
export function judge(state: KlondikeState, options: JudgeOptions = {}): Judgement {
  const start = Date.now();
  const quick = isSolvable(state, { maxNodes: 50_000, timeLimitMs: 1_000, ...options.quick });
  if (quick.status === 'solved') return { verdict: 'winnable', ms: Date.now() - start, next: quick.moves[0] };
  if (quick.status === 'unknown' && !options.thorough) return { verdict: 'unclear', ms: Date.now() - start };
  const sure = isSolvable(state, { maxNodes: 300_000, timeLimitMs: 3_000, ...options.confirm, exhaustive: true });
  if (sure.status === 'solved') return { verdict: 'winnable', ms: Date.now() - start, next: sure.moves[0] };
  return { verdict: sure.status === 'unsolvable' ? 'lost' : 'unclear', ms: Date.now() - start };
}

/**
 * A much longer look at a position live judging could not settle. Run in the
 * background: a loss found here also holds for every position played since.
 */
export function judgeDeeply(state: KlondikeState): Judgement {
  return judge(state, {
    quick: { maxNodes: 400_000, timeLimitMs: 6_000 },
    confirm: { maxNodes: 800_000, timeLimitMs: 12_000 },
    thorough: true,
  });
}

/**
 * Draws seeds until one deals a game the solver can win, or `maxTries` runs
 * out. Each try uses a small budget: most winnable deals solve in a few ms,
 * and an undecided one is simply skipped.
 */
export function findWinnableSeed(
  drawMode: DrawMode,
  nextSeed: () => number,
  options: { readonly maxTries?: number; readonly perTry?: SolveOptions; readonly redeals?: number } = {},
): number | undefined {
  const tries = options.maxTries ?? 40;
  for (let i = 0; i < tries; i++) {
    const seed = nextSeed();
    const r = isSolvable(dealFor(seed, drawMode, options.redeals), { maxNodes: 20_000, timeLimitMs: 500, ...options.perTry });
    if (r.status === 'solved') return seed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// How hard a deal is

/** 1 easy, 2 medium, 3 hard; 0 when no win was found to rate it by. */
export type Level = 0 | 1 | 2 | 3;

export interface Rating {
  readonly level: Level;
  /** Places on a winning line where some move loses (or no win is found after it). */
  readonly traps: number;
  /** Places where only one move keeps the game winnable. */
  readonly forced: number;
}

/**
 * Rates a deal the way a player meets it: follows a winning line and counts
 * the places along it where a move goes wrong, and the places with just one
 * way on. Search effort says little, since the solver sees the face-down
 * cards; traps are what make a deal hard for someone who does not. Each move
 * gets a short look, so a move counted as a trap may only be hard to win
 * from. Deterministic: only node budgets limit the looks, with time limits as
 * a backstop. Takes a few seconds.
 */
export function rateDeal(state: KlondikeState): Rating {
  const sol = isSolvable(state, { maxNodes: 300_000, timeLimitMs: 30_000 });
  if (sol.status !== 'solved') return { level: 0, traps: 0, forced: 0 };
  const looked = new Map<string, boolean>();
  const wins = (g: KlondikeState) => {
    const k = positionKey(g);
    let w = looked.get(k);
    if (w === undefined) looked.set(k, (w = isSolvable(g, { maxNodes: 8_000, timeLimitMs: 2_000 }).status === 'solved'));
    return w;
  };
  let traps = 0;
  let forced = 0;
  let s = state;
  for (let i = 0; i <= sol.moves.length; i++) {
    const options = successors(s);
    if (options.length >= 2) {
      const good = options.filter(wins).length;
      if (good < options.length) traps++;
      if (good <= 1) forced++;
    }
    if (i < sol.moves.length) s = replay(s, [sol.moves[i]!]);
  }
  // Tuned on real deals: ordinary dealt ones score about 0 to 17, ones players found hard 11 to 72.
  const score = traps + 3 * forced;
  return { level: score >= 30 ? 3 : score >= 10 ? 2 : 1, traps, forced };
}
