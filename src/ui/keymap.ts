import { type PileId, pile } from '../core/klondike.ts';

/**
 * Hotkeys mirror the board on the keyboard. The top row of the board sits on
 * the top letter row (q stock, w waste, r t y u the foundations over columns
 * 4 to 7, with e over the gap at column 3), and the seven columns sit on the
 * home row straight below (a s d f g h j). i, the next key over from the
 * foundations, means "whichever foundation fits" and is the one to reach for.
 * Keys are lower-case names as Node's keypress events report them.
 */
export const STOCK_KEY = 'q';
export const WASTE_KEY = 'w';
export const TABLEAU_KEYS = ['a', 's', 'd', 'f', 'g', 'h', 'j'] as const;
export const FOUNDATION_KEYS = ['r', 't', 'y', 'u'] as const;
/** Destination only: whichever foundation the card belongs on. */
export const AUTO_FOUNDATION_KEY = 'i';

export type PileTarget = PileId | { readonly kind: 'stock' } | { readonly kind: 'auto-foundation' };

export function pileForKey(key: string): PileTarget | undefined {
  const k = key.toLowerCase();
  if (k === STOCK_KEY) return { kind: 'stock' };
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
      return STOCK_KEY;
    case 'waste':
      return WASTE_KEY;
    case 'auto-foundation':
      return AUTO_FOUNDATION_KEY;
    case 'tableau':
      return TABLEAU_KEYS[target.index]!;
    case 'foundation':
      return FOUNDATION_KEYS[target.index]!;
  }
}
