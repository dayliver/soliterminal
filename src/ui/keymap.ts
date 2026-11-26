import { type PileId, pile } from '../core/klondike.ts';

/**
 * Hotkeys mirror the keyboard: the board's top row sits on ` 1 and F5–F8,
 * the tableau on the letter row below. F5–F8 are exact; F9, the next key over,
 * means "whichever foundation fits" and is the one to reach for. F1–F4 are left
 * alone because many terminals claim F1 for themselves. Keys are lower-case names as Node's
 * keypress events report them (`f1`, `q`, …), plus `` ` `` for the stock.
 */
export const STOCK_KEY = '`';
/** Shown for the stock: `~` is easier to read than a backtick, and either key draws. */
export const STOCK_LABEL = '~';
export const WASTE_KEY = '1';
export const TABLEAU_KEYS = ['q', 'w', 'e', 'r', 't', 'y', 'u'] as const;
export const FOUNDATION_KEYS = ['f5', 'f6', 'f7', 'f8'] as const;
/** Destination only: whichever foundation the card belongs on. */
export const AUTO_FOUNDATION_KEY = 'f9';

export type PileTarget = PileId | { readonly kind: 'stock' } | { readonly kind: 'auto-foundation' };

export function pileForKey(key: string): PileTarget | undefined {
  const k = key.toLowerCase();
  if (k === STOCK_KEY || k === STOCK_LABEL) return { kind: 'stock' };
  if (k === WASTE_KEY) return pile.waste;
  if (k === AUTO_FOUNDATION_KEY) return { kind: 'auto-foundation' };
  const t = (TABLEAU_KEYS as readonly string[]).indexOf(k);
  if (t >= 0) return pile.tableau(t);
  const f = (FOUNDATION_KEYS as readonly string[]).indexOf(k);
  if (f >= 0) return pile.foundation(f);
  return undefined;
}

/** The label drawn above a pile on screen. */
export function keyLabel(target: PileTarget): string {
  switch (target.kind) {
    case 'stock':
      return STOCK_LABEL;
    case 'waste':
      return WASTE_KEY;
    case 'auto-foundation':
      return AUTO_FOUNDATION_KEY.toUpperCase();
    case 'tableau':
      return TABLEAU_KEYS[target.index]!;
    case 'foundation':
      return FOUNDATION_KEYS[target.index]!.toUpperCase();
  }
}
