import { type ScreenBuffer, isEmoji, sameCell } from './screen.ts';
import type { Theme } from './theme.ts';

export const ansi = {
  altScreenOn: '\x1b[?1049h',
  altScreenOff: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  /** Ask the terminal to report focus changes as ESC [ I and ESC [ O. */
  focusReportingOn: '\x1b[?1004h',
  focusReportingOff: '\x1b[?1004l',
  showCursor: '\x1b[?25h',
  clear: '\x1b[2J',
  reset: '\x1b[0m',
  /** Zero-based column and row. */
  moveTo: (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`,
  /** Zero-based column, same row. */
  column: (x: number) => `\x1b[${x + 1}G`,
  sgr: (params: string) => `\x1b[${params}m`,
};

function rowText(buf: ScreenBuffer, y: number, theme: Theme, from: number, to: number): string {
  let out = '';
  let last = '';
  for (let x = from; x < to; x++) {
    const cell = buf.get(x, y);
    if (cell.ch === '') continue; // right half of a wide character
    const sgr = theme.sgr(cell);
    if (sgr !== last) {
      out += ansi.sgr(sgr);
      last = sgr;
    }
    if (isEmoji(cell.ch)) {
      // Blank both cells, draw the emoji over them, then carry on from a known
      // column, whether this terminal drew it one cell wide or two.
      out += '  ' + ansi.column(x) + cell.ch + ansi.column(x + 2);
    } else {
      out += cell.ch;
    }
  }
  return out + ansi.reset;
}

/**
 * The whole buffer as lines for normal (scrolling) output.
 * Trailing blank cells are dropped so a narrow terminal does not wrap.
 */
export function paint(buf: ScreenBuffer, theme: Theme): string {
  const lines: string[] = [];
  for (let y = 0; y < buf.height; y++) {
    let end = buf.width;
    while (end > 0) {
      const c = buf.get(end - 1, y);
      if (c.ch !== ' ' || c.bg !== 'none') break;
      end--;
    }
    lines.push(end === 0 ? '' : rowText(buf, y, theme, 0, end));
  }
  return lines.join('\n');
}

/**
 * The escape sequence that turns the screen showing `prev` into `next`, touching
 * only cells that changed. With no `prev`, or a size change, redraws everything.
 * Positions are absolute, so this works in raw mode without relying on newlines.
 */
export function diff(prev: ScreenBuffer | undefined, next: ScreenBuffer, theme: Theme): string {
  if (!prev || prev.width !== next.width || prev.height !== next.height) {
    let out = ansi.reset + ansi.clear;
    for (let y = 0; y < next.height; y++) out += ansi.moveTo(0, y) + rowText(next, y, theme, 0, next.width);
    return out;
  }
  let out = '';
  for (let y = 0; y < next.height; y++) {
    let x = 0;
    while (x < next.width) {
      if (sameCell(prev.get(x, y), next.get(x, y))) {
        x++;
        continue;
      }
      // Start a run at the beginning of a wide character, never in its right half.
      let start = x;
      if (next.get(start, y).ch === '' && start > 0) start--;
      let end = x + 1;
      while (end < next.width && !sameCell(prev.get(end, y), next.get(end, y))) end++;
      if (end < next.width && next.get(end, y).ch === '') end++;
      out += ansi.moveTo(start, y) + rowText(next, y, theme, start, end);
      x = end;
    }
  }
  return out;
}
