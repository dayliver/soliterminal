import type { Bg, Cell, Fg } from './screen.ts';

/** Turns a cell's style into SGR parameters, e.g. `"0;31;107"`. */
export interface Theme {
  readonly name: string;
  sgr(cell: Cell): string;
}

/**
 * Everything except the cards uses the 16 basic ANSI colors, so it follows the
 * terminal's palette. One color family sets the theme: its strong (bright)
 * shade for keys, held cards and the ✓, its weak (normal) shade for the
 * header, messages and the cursor. Red stays red for bad news.
 *
 * Cards use fixed colors so they always look like cards.
 */
export const ACCENTS = { green: 2, cyan: 6, blue: 4, magenta: 5, yellow: 3, red: 1, white: 7 } as const;
export type Accent = keyof typeof ACCENTS;
export const DEFAULT_ACCENT: Accent = 'green';

function palette(accent: Accent): { fg: Record<Fg, string>; bg: Record<Bg, string> } {
  const n = ACCENTS[accent];
  const weak = String(30 + n);
  const strong = String(90 + n);
  return {
    fg: {
      text: '39', // the terminal's own text color
      black: '30',
      red: '31',
      border: '90', // bright black, usually grey
      back: '37',
      dim: '90',
      key: strong,
      header: weak,
      message: weak,
    },
    bg: {
      none: '',
      card: '107',
      back: '100',
      hold: String(100 + n), // strong: cards in hand
      cursor: String(40 + n), // weak: where the cursor is
      chosen: String(100 + n), // strong: a card face the arrows have chosen
    },
  };
}

/**
 * Fixed card colors, as truecolor and as the matching 256-color cube entries.
 *
 * Card edges are underlines. Truecolor terminals almost all support a separate
 * underline color (SGR 58, written with colons so terminals that do not know it
 * skip it whole), which makes the edge a faint grey hairline. Elsewhere the
 * underline takes the text color.
 */
const BACK = {
  truecolor: { back: '48;2;108;108;108', backText: '38;2;198;198;198', backEdge: '4;58:2::70:70:70' },
  // 242 = #6c6c6c, 251 = #c6c6c6
  '256': { back: '48;5;242', backText: '38;5;251', backEdge: '4' },
} as const;

/**
 * Card faces to choose from with SOLITERMINAL_CARD. `ddd` (the default) is a
 * soft grey-white that glares less, so the text reads bolder, with a darker red
 * and edge so hearts and diamonds keep their contrast; `fff` is pure white
 * with pure red.
 */
const FACES = {
  fff: {
    // 231 = #ffffff, 16 = #000000, 196 = #ff0000
    truecolor: { face: '48;2;255;255;255', black: '38;2;0;0;0', red: '38;2;255;0;0', faceEdge: '4;58:2::170:170:170' },
    '256': { face: '48;5;231', black: '38;5;16', red: '38;5;196', faceEdge: '4' },
  },
  ddd: {
    // 253 = #dadada, 160 = #d70000
    truecolor: { face: '48;2;221;221;221', black: '38;2;0;0;0', red: '38;2;204;0;0', faceEdge: '4;58:2::153:153:153' },
    '256': { face: '48;5;253', black: '38;5;16', red: '38;5;160', faceEdge: '4' },
  },
} as const;

export type ColorDepth = keyof typeof BACK;
export type CardFace = keyof typeof FACES;
export const CARD_FACES = Object.keys(FACES) as CardFace[];

export function makeColorTheme(depth: ColorDepth, face: CardFace = 'ddd', accent: Accent = DEFAULT_ACCENT): Theme {
  const card = { ...FACES[face][depth], ...BACK[depth] };
  const { fg: FG, bg: BG } = palette(accent);
  return {
    name: `color-${depth}-${face}-${accent}`,
    sgr(cell) {
      let fg = FG[cell.fg];
      let bg = BG[cell.bg];
      let bold = cell.bold;
      let edge = cell.edge ? '4' : '';
      if (cell.bg === 'card' || cell.bg === 'chosen') {
        // A chosen card keeps the face's suit colors; only its background takes the theme.
        if (cell.bg === 'card') bg = card.face;
        fg = cell.fg === 'red' ? card.red : card.black;
        if (cell.edge) edge = card.faceEdge;
      } else if (cell.bg === 'back') {
        bg = card.back;
        fg = card.backText;
        if (cell.edge) edge = card.backEdge;
      } else if (cell.bg === 'hold' || cell.bg === 'cursor') {
        fg = '30';
        bold = true;
      }
      return ['0', fg, bg, bold ? '1' : '', edge].filter(Boolean).join(';');
    },
  };
}

export const colorTheme: Theme = makeColorTheme('256');
export const truecolorTheme: Theme = makeColorTheme('truecolor');

/** Reads SOLITERMINAL_CARD (`ddd` or `fff`, with or without `#`); anything else means `ddd`. */
export function cardFaceFrom(env: NodeJS.ProcessEnv): CardFace {
  const want = (env.SOLITERMINAL_CARD ?? '').trim().toLowerCase().replace(/^#/, '');
  return (CARD_FACES as string[]).includes(want) ? (want as CardFace) : 'ddd';
}

/**
 * No color at all, for NO_COLOR or dumb terminals. Card faces are reversed,
 * backs are reversed and faint, the cursor is reversed, held cards reversed,
 * bold and underlined. A chosen card is the one face not reversed.
 */
export const monoTheme: Theme = {
  name: 'mono',
  sgr(cell) {
    const codes = ['0'];
    if (cell.fg === 'dim') codes.push('2');
    if (cell.bold || cell.fg === 'header') codes.push('1');
    if (cell.bg === 'card' || cell.bg === 'cursor') codes.push('7');
    if (cell.bg === 'back') codes.push('7', '2');
    if (cell.bg === 'hold') codes.push('7', '1', '4');
    // Every other card face is reversed; the chosen one stands out by not being.
    if (cell.bg === 'chosen') codes.push('4');
    if (cell.edge) codes.push('4');
    return codes.join(';');
  },
};

export function isAccent(name: string | undefined): name is Accent {
  return name !== undefined && Object.hasOwn(ACCENTS, name);
}

/**
 * Follows https://no-color.org, falls back to mono when output is not a
 * terminal, uses truecolor for the cards when the terminal says it can, picks
 * the card face from SOLITERMINAL_CARD, and the color family from `accent`
 * (the --theme option), else SOLITERMINAL_THEME, else green.
 */
export function pickTheme(env: NodeJS.ProcessEnv, isTTY: boolean, accent?: Accent): Theme {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return monoTheme;
  if (!isTTY || env.TERM === 'dumb') return monoTheme;
  const depth = env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' ? 'truecolor' : '256';
  const face = cardFaceFrom(env);
  const fromEnv = env.SOLITERMINAL_THEME?.trim().toLowerCase();
  const chosen = accent ?? (isAccent(fromEnv) ? fromEnv : DEFAULT_ACCENT);
  if (face === 'ddd' && chosen === DEFAULT_ACCENT) return depth === 'truecolor' ? truecolorTheme : colorTheme;
  return makeColorTheme(depth, face, chosen);
}
