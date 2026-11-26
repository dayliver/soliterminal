export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];

export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export const RANKS: readonly Rank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

export interface Card {
  readonly suit: Suit;
  readonly rank: Rank;
}

export type Color = 'red' | 'black';

export function colorOf(card: Card): Color {
  return card.suit === 'H' || card.suit === 'D' ? 'red' : 'black';
}

/** Compact notation, ten as `X`, so every label is two characters (used in tests and parsing). */
const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', 'X', 'J', 'Q', 'K'] as const;

const SUIT_SYMBOLS: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

export function rankLabel(rank: Rank): string {
  return RANK_LABELS[rank];
}

export function suitLabel(suit: Suit, ascii = false): string {
  return ascii ? suit : SUIT_SYMBOLS[suit];
}

/**
 * Suits as emoji (`♠` + U+FE0F). Plain ♠♥♦♣ are "ambiguous width" and most
 * fonts draw them in one narrow cell; the emoji form is drawn two cells wide
 * by terminals that support it (kitty, WezTerm, Ghostty, iTerm2, Windows Terminal).
 */
export function suitGlyph(suit: Suit): string {
  return SUIT_SYMBOLS[suit] + '\uFE0F';
}

/**
 * Ranks for drawing large cards, all two cells wide: fullwidth `Ａ`…`９`,
 * `Ｊ` `Ｑ` `Ｋ`, and ten as plain `10`, which is already two characters.
 */
const RANK_GLYPHS = ['', 'Ａ', '２', '３', '４', '５', '６', '７', '８', '９', '10', 'Ｊ', 'Ｑ', 'Ｋ'] as const;
const RANK_ASCII = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;

/** The rank as drawn on a card face. With `ascii`, plain `A`…`10`…`K`. */
export function rankGlyph(rank: Rank, ascii = false): string {
  return (ascii ? RANK_ASCII : RANK_GLYPHS)[rank];
}

/** `K♠`, `X♥`, or with `ascii` set, `KS`, `XH`. */
export function cardLabel(card: Card, ascii = false): string {
  return rankLabel(card.rank) + suitLabel(card.suit, ascii);
}

/** How messages name a card: `K♠`, `10♥`, or with `ascii` set, `KS`, `10H`. */
export function cardName(card: Card, ascii = false): string {
  return rankGlyph(card.rank, true) + suitLabel(card.suit, ascii);
}

export function sameCard(a: Card | undefined, b: Card): boolean {
  return a !== undefined && a.suit === b.suit && a.rank === b.rank;
}

/**
 * Parses `KS`, `K♠`, `XH`, `10H` and the like. Mostly for tests and debugging.
 * Throws on anything else.
 */
export function parseCard(text: string): Card {
  const match = /^(10|[A2-9XJQK])([SHDC♠♥♦♣])$/i.exec(text.trim());
  if (!match) throw new Error(`Not a card: "${text}"`);
  const rankText = match[1]!.toUpperCase();
  const rank = (rankText === '10' ? 10 : RANK_LABELS.indexOf(rankText as (typeof RANK_LABELS)[number])) as Rank;
  const suitText = match[2]!.toUpperCase();
  const suit = (Object.entries(SUIT_SYMBOLS).find(([, sym]) => sym === suitText)?.[0] ?? suitText) as Suit;
  return { suit, rank };
}
