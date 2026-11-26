import { type Card, colorOf } from './card.ts';
import { createDeck, mulberry32, shuffle } from './deck.ts';

export type DrawMode = 1 | 3;
export const TABLEAU_COLUMNS = 7;
export const FOUNDATIONS = 4;

/** Face-down cards sit under face-up cards. The last element of each array is the top. */
export interface Column {
  readonly down: readonly Card[];
  readonly up: readonly Card[];
}

/**
 * The whole game, immutable. Every function here returns a new state, so undo
 * is just a stack of previous states.
 */
export interface KlondikeState {
  readonly seed: number;
  readonly drawMode: DrawMode;
  /** Face down. Last element is the top. */
  readonly stock: readonly Card[];
  /** Face up. Last element is the top, the only playable card. */
  readonly waste: readonly Card[];
  /** Four piles with no fixed suit. Any ace starts one; it then builds up in that suit to K. */
  readonly foundations: readonly (readonly Card[])[];
  readonly tableau: readonly Column[];
  readonly moves: number;
  /**
   * How many more times the waste may be turned back into the stock.
   * `Infinity` means no limit.
   */
  readonly redealsLeft: number;
}

/** Redeals allowed by default: the waste can be turned over three times. */
export const DEFAULT_REDEALS = 3;

export type PileId =
  | { readonly kind: 'waste' }
  | { readonly kind: 'foundation'; readonly index: number }
  | { readonly kind: 'tableau'; readonly index: number };

export const pile = {
  waste: { kind: 'waste' } as PileId,
  foundation: (index: number): PileId => ({ kind: 'foundation', index }),
  tableau: (index: number): PileId => ({ kind: 'tableau', index }),
};

export type MoveError =
  | 'no-redeals' // the stock is out and the waste may not be turned over again
  | 'empty-source' // nothing to take from that pile
  | 'same-pile' // source and destination are the same
  | 'bad-count' // that many cards cannot be taken from the source
  | 'not-allowed' // the destination does not accept those cards
  | 'wrong-foundation' // that foundation refuses the card, but another one takes it
  | 'stock-empty' // nothing left to draw or recycle
  | 'no-move'; // auto move found no legal destination

export type Result =
  | { readonly ok: true; readonly state: KlondikeState }
  | { readonly ok: false; readonly error: MoveError };

const ok = (state: KlondikeState): Result => ({ ok: true, state });
const fail = (error: MoveError): Result => ({ ok: false, error });
const top = <T>(cards: readonly T[]): T | undefined => cards[cards.length - 1];

// ---------------------------------------------------------------------------
// Setup

/** Deals a new game. Column n gets n+1 cards with only the last one face up. */
export function deal(seed: number, drawMode: DrawMode = 1, redeals: number = DEFAULT_REDEALS): KlondikeState {
  const cards = shuffle(createDeck(), mulberry32(seed));
  const columns = Array.from({ length: TABLEAU_COLUMNS }, () => ({ down: [] as Card[], up: [] as Card[] }));
  let next = 0;
  for (let row = 0; row < TABLEAU_COLUMNS; row++) {
    for (let col = row; col < TABLEAU_COLUMNS; col++) {
      const card = cards[next++]!;
      (col === row ? columns[col]!.up : columns[col]!.down).push(card);
    }
  }
  return {
    seed,
    drawMode,
    stock: cards.slice(next),
    waste: [],
    foundations: Array.from({ length: FOUNDATIONS }, () => []),
    tableau: columns,
    moves: 0,
    redealsLeft: redeals,
  };
}

// ---------------------------------------------------------------------------
// Stock

/**
 * Draws 1 or 3 cards (per `drawMode`) from the stock onto the waste.
 * When the stock is empty, turns the waste back over into the stock.
 */
export function draw(state: KlondikeState): Result {
  if (state.stock.length === 0) {
    if (state.waste.length === 0) return fail('stock-empty');
    if (state.redealsLeft <= 0) return fail('no-redeals');
    return ok({
      ...state,
      stock: [...state.waste].reverse(),
      waste: [],
      moves: state.moves + 1,
      redealsLeft: state.redealsLeft - 1,
    });
  }
  const n = Math.min(state.drawMode, state.stock.length);
  // Cards are turned one at a time, so the last one turned ends up on top.
  const turned = state.stock.slice(-n).reverse();
  return ok({
    ...state,
    stock: state.stock.slice(0, -n),
    waste: [...state.waste, ...turned],
    moves: state.moves + 1,
  });
}

// ---------------------------------------------------------------------------
// Moves

function checkPile(id: PileId): void {
  if (id.kind === 'foundation' && !(id.index >= 0 && id.index < FOUNDATIONS)) {
    throw new RangeError(`No foundation ${id.index}`);
  }
  if (id.kind === 'tableau' && !(id.index >= 0 && id.index < TABLEAU_COLUMNS)) {
    throw new RangeError(`No tableau column ${id.index}`);
  }
}

export function samePile(a: PileId, b: PileId): boolean {
  if (a.kind === 'waste' || b.kind === 'waste') return a.kind === b.kind;
  return a.kind === b.kind && a.index === b.index;
}

/** How many cards could be picked up from a pile at most. */
export function maxTake(state: KlondikeState, from: PileId): number {
  checkPile(from);
  switch (from.kind) {
    case 'waste':
      return state.waste.length > 0 ? 1 : 0;
    case 'foundation':
      return state.foundations[from.index]!.length > 0 ? 1 : 0;
    case 'tableau':
      return state.tableau[from.index]!.up.length;
  }
}

function take(state: KlondikeState, from: PileId, count: number): readonly Card[] | MoveError {
  const max = maxTake(state, from);
  if (max === 0) return 'empty-source';
  if (!Number.isInteger(count) || count < 1 || count > max) return 'bad-count';
  switch (from.kind) {
    case 'waste':
      return state.waste.slice(-1);
    case 'foundation':
      return state.foundations[from.index]!.slice(-1);
    case 'tableau':
      return state.tableau[from.index]!.up.slice(-count);
  }
}

/** Whether `cards` (bottom card first) may be placed on the destination pile. */
export function accepts(state: KlondikeState, to: PileId, cards: readonly Card[]): boolean {
  checkPile(to);
  const first = cards[0];
  if (!first) return false;
  switch (to.kind) {
    case 'waste':
      return false;
    case 'foundation': {
      if (cards.length !== 1) return false;
      const target = top(state.foundations[to.index]!);
      if (!target) return first.rank === 1;
      return first.suit === target.suit && first.rank === target.rank + 1;
    }
    case 'tableau': {
      const target = top(state.tableau[to.index]!.up);
      if (!target) return first.rank === 13;
      return colorOf(target) !== colorOf(first) && target.rank === first.rank + 1;
    }
  }
}

function remove(state: KlondikeState, from: PileId, count: number): KlondikeState {
  switch (from.kind) {
    case 'waste':
      return { ...state, waste: state.waste.slice(0, -1) };
    case 'foundation':
      return {
        ...state,
        foundations: state.foundations.map((f, i) => (i === from.index ? f.slice(0, -1) : f)),
      };
    case 'tableau':
      return {
        ...state,
        tableau: state.tableau.map((col, i) => {
          if (i !== from.index) return col;
          const up = col.up.slice(0, -count);
          // Turn over the next face-down card when the face-up run is gone.
          if (up.length === 0 && col.down.length > 0) {
            return { down: col.down.slice(0, -1), up: col.down.slice(-1) };
          }
          return { down: col.down, up };
        }),
      };
  }
}

function add(state: KlondikeState, to: PileId, cards: readonly Card[]): KlondikeState {
  switch (to.kind) {
    case 'waste':
      throw new Error('Cards cannot be placed on the waste');
    case 'foundation':
      return {
        ...state,
        foundations: state.foundations.map((f, i) => (i === to.index ? [...f, ...cards] : f)),
      };
    case 'tableau':
      return {
        ...state,
        tableau: state.tableau.map((col, i) => (i === to.index ? { down: col.down, up: [...col.up, ...cards] } : col)),
      };
  }
}

/**
 * The foundation a single card can go on: the pile of its suit, or for an ace
 * the first empty one. `undefined` if it fits nowhere yet.
 */
export function foundationFor(state: KlondikeState, card: Card): number | undefined {
  const i = state.foundations.findIndex((_, i) => accepts(state, pile.foundation(i), [card]));
  return i >= 0 ? i : undefined;
}

/** Moves the top `count` cards from one pile to another, if the rules allow it. */
export function move(state: KlondikeState, from: PileId, to: PileId, count = 1): Result {
  checkPile(from);
  checkPile(to);
  if (samePile(from, to)) return fail('same-pile');
  const cards = take(state, from, count);
  if (typeof cards === 'string') return fail(cards);
  if (!accepts(state, to, cards)) return fail('not-allowed');
  const next = add(remove(state, from, count), to, cards);
  return ok({ ...next, moves: state.moves + 1 });
}

/**
 * The number of cards that makes `from → to` legal, or `undefined` if none does.
 * In Klondike at most one count can work, so the UI never has to ask.
 */
export function fittingCount(state: KlondikeState, from: PileId, to: PileId): number | undefined {
  if (samePile(from, to)) return undefined;
  const max = maxTake(state, from);
  for (let n = 1; n <= max; n++) {
    const cards = take(state, from, n);
    if (typeof cards !== 'string' && accepts(state, to, cards)) return n;
  }
  return undefined;
}

/**
 * Source key then destination key: moves however many cards fit.
 * A foundation destination is exact. If the card belongs on a different
 * foundation the error is `wrong-foundation`, so the UI can point at F9.
 */
export function moveTo(state: KlondikeState, from: PileId, to: PileId): Result {
  checkPile(from);
  checkPile(to);
  if (samePile(from, to)) return fail('same-pile');
  if (maxTake(state, from) === 0) return fail('empty-source');
  const n = fittingCount(state, from, to);
  if (n !== undefined) return move(state, from, to, n);
  if (to.kind === 'foundation' && from.kind !== 'foundation') {
    const card = take(state, from, 1);
    if (typeof card !== 'string' && foundationFor(state, card[0]!) !== undefined) return fail('wrong-foundation');
  }
  return fail('not-allowed');
}

/**
 * F9: sends the top card of the waste or a column to the foundation of its suit,
 * or for an ace to the first empty foundation.
 */
export function moveToFoundation(state: KlondikeState, from: PileId): Result {
  checkPile(from);
  if (from.kind === 'foundation') return fail('same-pile');
  const card = take(state, from, 1);
  if (typeof card === 'string') return fail(card);
  const home = foundationFor(state, card[0]!);
  return home === undefined ? fail('not-allowed') : move(state, from, pile.foundation(home), 1);
}

/** Every legal destination for cards from `from`, in auto-move preference order. */
export function destinations(state: KlondikeState, from: PileId): PileId[] {
  // An ace fits every empty foundation; offer only the first so auto move is predictable.
  const card = from.kind === 'foundation' ? undefined : take(state, from, 1);
  const home = card === undefined || typeof card === 'string' ? undefined : foundationFor(state, card[0]!);
  const foundations = home === undefined ? [] : [pile.foundation(home)];
  const columns = state.tableau.map((_, i) => pile.tableau(i));
  const filled = columns.filter((c) => c.kind === 'tableau' && state.tableau[c.index]!.up.length > 0);
  const empty = columns.filter((c) => c.kind === 'tableau' && state.tableau[c.index]!.up.length === 0);
  return [...foundations, ...filled, ...empty].filter((to) => {
    const n = fittingCount(state, from, to);
    if (n === undefined) return false;
    // Moving a whole column that has nothing under it into an empty column changes nothing.
    if (from.kind === 'tableau' && to.kind === 'tableau') {
      const col = state.tableau[from.index]!;
      if (n === col.up.length && col.down.length === 0 && state.tableau[to.index]!.up.length === 0) return false;
    }
    return true;
  });
}

/**
 * Same key twice: sends cards from `from` to the best legal spot.
 * Preference: foundation, then a non-empty column, then an empty column.
 */
export function autoMove(state: KlondikeState, from: PileId): Result {
  checkPile(from);
  if (maxTake(state, from) === 0) return fail('empty-source');
  const to = destinations(state, from)[0];
  return to ? moveTo(state, from, to) : fail('no-move');
}

// ---------------------------------------------------------------------------
// End of game

export function isWon(state: KlondikeState): boolean {
  return state.foundations.every((f) => f.length === 13);
}

/** True once every card is face up and out of the stock, so the rest plays itself. */
export function canAutoComplete(state: KlondikeState): boolean {
  return (
    !isWon(state) &&
    state.stock.length === 0 &&
    state.waste.length === 0 &&
    state.tableau.every((col) => col.down.length === 0)
  );
}

/**
 * Plays the remaining cards onto the foundations, lowest rank first.
 * Returns every intermediate state so the UI can animate them.
 */
export function autoComplete(state: KlondikeState): KlondikeState[] {
  if (!canAutoComplete(state)) return [];
  const steps: KlondikeState[] = [];
  let current = state;
  while (!isWon(current)) {
    // Runs descend toward the top, so the lowest top card is always the next one
    // its foundation needs.
    let column = -1;
    let lowest: Card | undefined;
    current.tableau.forEach((col, i) => {
      const card = top(col.up);
      if (card && (!lowest || card.rank < lowest.rank)) {
        lowest = card;
        column = i;
      }
    });
    if (!lowest) break;
    const home = foundationFor(current, lowest);
    if (home === undefined) break;
    const result = move(current, pile.tableau(column), pile.foundation(home));
    if (!result.ok) break;
    current = result.state;
    steps.push(current);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Positions

const cardsKey = (cards: readonly Card[]) => cards.map((c) => c.suit + c.rank).join(',');

/**
 * A string that is the same for two states exactly when the same game goes
 * on from them. The move count is left out, and so is which foundation holds
 * which suit, since foundations have no fixed suit.
 */
export function positionKey(state: KlondikeState): string {
  const foundations = state.foundations.map(cardsKey).sort().join('/');
  const tableau = state.tableau.map((c) => `${cardsKey(c.down)}|${cardsKey(c.up)}`).join('/');
  return `${state.drawMode};${state.redealsLeft};${cardsKey(state.stock)};${cardsKey(state.waste)};${foundations};${tableau}`;
}

/** Every position one move away: a draw, or any legal move of any number of cards. */
export function successors(state: KlondikeState): KlondikeState[] {
  const out = new Map<string, KlondikeState>();
  const add = (r: Result) => {
    if (!r.ok) return;
    const key = positionKey(r.state);
    if (!out.has(key)) out.set(key, r.state);
  };
  add(draw(state));
  const tableau = state.tableau.map((_, i) => pile.tableau(i));
  const foundations = state.foundations.map((_, i) => pile.foundation(i));
  for (const from of [pile.waste, ...foundations, ...tableau]) {
    const max = maxTake(state, from);
    for (let n = 1; n <= max; n++) {
      for (const to of [...foundations, ...tableau]) if (!samePile(from, to)) add(move(state, from, to, n));
    }
  }
  return [...out.values()];
}
