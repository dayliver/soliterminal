/** What a cell's text is for. The theme turns these into actual colors. */
export type Fg = 'text' | 'border' | 'red' | 'black' | 'back' | 'dim' | 'key' | 'header' | 'message';
/**
 * Background of a cell: a card face, a card back, or a highlight. `hold` and
 * `cursor` go on key labels only. `chosen` is the one highlight on a card: the
 * card the arrows have chosen in a column, its face tinted but its suit color kept.
 */
export type Bg = 'none' | 'card' | 'back' | 'hold' | 'cursor' | 'chosen';

export interface Style {
  readonly fg?: Fg;
  readonly bg?: Bg;
  readonly bold?: boolean;
  /** A hairline along the bottom of the cell: the edge between stacked cards. */
  readonly edge?: boolean;
}

/** `ch` is `''` for the right half of a double-width character. */
export interface Cell {
  readonly ch: string;
  readonly fg: Fg;
  readonly bg: Bg;
  readonly bold: boolean;
  readonly edge: boolean;
}

const BLANK: Cell = { ch: ' ', fg: 'text', bg: 'none', bold: false, edge: false };

/** U+FE0F asks for emoji presentation; it joins the character before it. */
export const EMOJI = '\uFE0F';

/**
 * A character drawn as emoji takes two cells here. Terminals disagree about
 * that, so the renderer paints both cells and positions the cursor absolutely
 * after it; see `ansi.ts`.
 */
export function isEmoji(ch: string): boolean {
  return ch.length > 1 && ch.endsWith(EMOJI);
}

/** Hangul, CJK, fullwidth forms and emoji take two cells. Plain ♠♥♦♣ take one. */
export function charWidth(ch: string): 1 | 2 {
  return isEmoji(ch) || /[ᄀ-ᅟ⺀-〾ぁ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(ch)
    ? 2
    : 1;
}

/** Splits text into cells' worth of characters, keeping U+FE0F with the one before it. */
export function units(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    if (ch === EMOJI && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

export function textWidth(text: string): number {
  let w = 0;
  for (const ch of units(text)) w += charWidth(ch);
  return w;
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.ch === b.ch && a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.edge === b.edge;
}

/** A grid of styled cells. The layout draws into it and the renderer turns it into ANSI. */
export class ScreenBuffer {
  readonly width: number;
  readonly height: number;
  #cells: Cell[];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.#cells = new Array<Cell>(width * height).fill(BLANK);
  }

  get(x: number, y: number): Cell {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return BLANK;
    return this.#cells[y * this.width + x]!;
  }

  #set(x: number, y: number, cell: Cell): void {
    const i = y * this.width + x;
    // Writing over half of a wide character blanks the other half.
    if (this.#cells[i]!.ch === '' && x > 0) this.#cells[i - 1] = { ...this.#cells[i - 1]!, ch: ' ' };
    if (x + 1 < this.width && this.#cells[i + 1]!.ch === '' && cell.ch !== '') {
      this.#cells[i + 1] = { ...this.#cells[i + 1]!, ch: ' ' };
    }
    this.#cells[i] = cell;
  }

  /** Writes text starting at (x, y), clipped to the buffer. Returns the x after the text. */
  put(x: number, y: number, text: string, style: Style = {}): number {
    const base = { fg: style.fg ?? 'text', bg: style.bg ?? 'none', bold: style.bold ?? false, edge: style.edge ?? false };
    for (const ch of units(text)) {
      const w = charWidth(ch);
      if (y >= 0 && y < this.height && x >= 0 && x + w <= this.width) {
        this.#set(x, y, { ch, ...base });
        if (w === 2) this.#set(x + 1, y, { ch: '', ...base });
      }
      x += w;
    }
    return x;
  }

  /** Plain text, one line per row, trailing spaces trimmed. Handy for tests and logs. */
  toText(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let line = '';
      for (let x = 0; x < this.width; x++) line += this.get(x, y).ch;
      lines.push(line.trimEnd());
    }
    return lines.join('\n');
  }
}
