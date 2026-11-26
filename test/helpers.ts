import { type Card, parseCard } from '../src/core/card.ts';
import type { DrawMode, KlondikeState } from '../src/core/klondike.ts';

/** `"KS QH JC"` → cards, bottom first. */
export const cards = (text = ''): Card[] => text.split(/\s+/).filter(Boolean).map(parseCard);

export interface Layout {
  stock?: string;
  waste?: string;
  /** Four piles in ♠ ♥ ♦ ♣ order. */
  foundations?: [string?, string?, string?, string?];
  /** Up to seven columns as `"down | up"`, e.g. `"2C 5D | 9H 8S"`. */
  tableau?: string[];
  drawMode?: DrawMode;
  /** Defaults to no limit, so hand-built positions are not cut short. */
  redealsLeft?: number;
}

/** Builds a hand-written position. It need not contain all 52 cards. */
export function board(layout: Layout): KlondikeState {
  const tableau = Array.from({ length: 7 }, (_, i) => {
    const [down = '', up = ''] = (layout.tableau?.[i] ?? '|').split('|');
    return { down: cards(down), up: cards(up) };
  });
  return {
    seed: 0,
    drawMode: layout.drawMode ?? 1,
    stock: cards(layout.stock),
    waste: cards(layout.waste),
    foundations: [0, 1, 2, 3].map((i) => cards(layout.foundations?.[i])),
    tableau,
    moves: 0,
    redealsLeft: layout.redealsLeft ?? Infinity,
  };
}

export const label = (c: Card | undefined): string =>
  c ? `${'_A23456789XJQK'[c.rank]}${c.suit}` : '-';

export const labels = (cs: readonly Card[]): string => cs.map(label).join(' ');

/** Every card in the state, wherever it is. */
export function allCards(s: KlondikeState): Card[] {
  return [
    ...s.stock,
    ...s.waste,
    ...s.foundations.flat(),
    ...s.tableau.flatMap((c) => [...c.down, ...c.up]),
  ];
}
