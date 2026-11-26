import { type Card, colorOf, rankGlyph, rankLabel, suitGlyph, suitLabel } from '../core/card.ts';
import { type KlondikeState, type PileId, TABLEAU_COLUMNS, pile, samePile } from '../core/klondike.ts';
import { keyLabel } from './keymap.ts';
import { type Bg, ScreenBuffer, textWidth } from './screen.ts';
import { type ModeStats, winRate } from '../stats.ts';
import { formatWhen } from './help.ts';

/** UI-only state that sits next to the game state. */
/** Where the cursor can be: any pile, or the stock. */
export type CursorSpot = PileId | { readonly kind: 'stock' };

export interface View {
  readonly cursor: CursorSpot;
  /** Cards picked up and waiting for a destination. */
  readonly held?: { readonly from: PileId; readonly count?: number };
  /** Cards chosen in the cursor's column, counted from the top of the pile: the first of them is highlighted. */
  readonly selected?: number;
  readonly message?: string;
  readonly elapsedMs?: number;
  /** The terminal is out of focus and the clock is stopped. */
  readonly paused?: boolean;
  /** Whether the position can still be won, shown in the header. */
  readonly status?: 'checking' | 'winnable' | 'lost' | 'unclear';
  /**
   * The cards in hand have a place to go that loses: the header shows a warning
   * sign instead of the tick, and the message, when it is the warning, is red.
   */
  readonly danger?: { readonly message: boolean };
  /** Winnable, but it takes every redeal left: shown as a tick with a mark. */
  readonly tight?: boolean;
  /** A box drawn over the board that asks the player to choose. */
  readonly dialog?: Dialog;
  /** Milliseconds into the win ceremony, while it runs. */
  readonly celebration?: number;
  /** The record for this draw mode, shown in the divider above the status bar. */
  readonly record?: ModeStats;
  /** When this deal was last lost, if it was: shown in the divider. */
  readonly lostBefore?: number;
}

export interface Dialog {
  readonly title: string;
  readonly lines: readonly string[];
  /** What each choice does, one per row. */
  readonly choices: readonly string[];
  /** The highlighted choice: enter or space takes it. */
  readonly selected: number;
  /** Bad news, drawn in red. */
  readonly danger?: boolean;
}

export interface LayoutOptions {
  readonly ascii?: boolean;
  /** Small cards: ` K♠ ` with ten as `X`, for when the game should not stand out. */
  readonly compact?: boolean;
  /** Terminal columns. The board is centred in it. */
  readonly width?: number;
  /**
   * Terminal rows. The status bar sits on the last rows, and if the board would
   * not fit, face-down stacks fold into one row that shows their count.
   */
  readonly height?: number;
}

/**
 * Cards are one row tall; a white face is its own border. Large cards are six
 * cells wide with a two-cell rank and a two-cell emoji suit: ` Ｋ♠️ `, ` 10♠️ `.
 * Compact cards are four cells: ` K♠ `, ` X♥ `.
 */
export interface Geometry {
  readonly card: number;
  readonly pitch: number;
  readonly board: number;
}

function geometry(compact: boolean): Geometry {
  const card = compact ? 4 : 6;
  const pitch = card + 2;
  return { card, pitch, board: pitch * (TABLEAU_COLUMNS - 1) + card };
}

export const LARGE = geometry(false); // board 54 wide
export const COMPACT = geometry(true); // board 40 wide
export const CARD_WIDTH = LARGE.card;
export const COLUMN_PITCH = LARGE.pitch;
export const BOARD_WIDTH = LARGE.board;
export const MIN_WIDTH = 56;

const ROW = { header: 0, topKeys: 2, topCards: 3, tableauKeys: 5, tableau: 6 } as const;
const FOOTER_ROWS = 5; // blank, message, divider, two status lines

/** Box characters are only for dialogs and the divider; cards have none. */
interface Glyphs {
  tl: string; tr: string; bl: string; br: string; h: string; v: string;
  recycle: string; none: string; divider: string; sep: string; prompt: string; yes: string; wait: string; warn: string; updown: string;
}

const BOX: Glyphs = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│',
  recycle: '↺', none: '×', divider: '─', sep: '·', prompt: '›', yes: '✓', wait: '…', warn: '⚠', updown: '↑↓',
};

const ASCII: Glyphs = {
  tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|',
  recycle: 'O', none: 'x', divider: '-', sep: '-', prompt: '>', yes: 'ok', wait: '..', warn: '!', updown: 'up/down',
};

/** Rows a column of face-down cards takes: one each, or one in total when folded. */
const downRows = (down: number, fold: boolean) => (fold && down > 1 ? 1 : down);

/** Rows the tableau needs: one per card. */
function tableauHeight(state: KlondikeState, fold: boolean): number {
  return Math.max(1, ...state.tableau.map((c) => downRows(c.down.length, fold) + c.up.length));
}

/** Rows the screen needs, with face-down stacks drawn in full or folded. */
export function screenHeight(state: KlondikeState, fold = false): number {
  return ROW.tableau + tableauHeight(state, fold) + FOOTER_ROWS;
}

/** The fewest rows this position can be drawn in. */
export function minScreenHeight(state: KlondikeState): number {
  return screenHeight(state, true);
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function renderKlondike(state: KlondikeState, view: View, options: LayoutOptions = {}): ScreenBuffer {
  const ascii = options.ascii ?? false;
  const compact = options.compact ?? false;
  const geo = compact ? COMPACT : LARGE;
  const look: Look = { ascii, compact, card: geo.card };
  const g = ascii ? ASCII : BOX;
  const width = Math.max(options.width ?? MIN_WIDTH, MIN_WIDTH);
  const fold = options.height !== undefined && screenHeight(state) > options.height;
  const height = Math.max(screenHeight(state, fold), options.height ?? 0);
  const buf = new ScreenBuffer(width, height);
  const left = Math.floor((width - geo.board) / 2);
  const colX = (i: number) => left + i * geo.pitch;

  // --- card primitives -----------------------------------------------------
  const suitFg = (card: Card) => (colorOf(card) === 'red' ? 'red' : 'black');

  // A card is one row: a white face with its rank and suit in bold, or a grey back.
  // `edge` underlines a card that has another directly below it, which draws a
  // hairline between stacked cards without spending a row. The only highlight on
  // a card is `chosen`: the card the arrows are on.
  const card = (x: number, y: number, c: Card, edge = false, chosen = false) => {
    const style = { fg: suitFg(c), bg: chosen ? 'chosen' : 'card', bold: true, edge } as const;
    buf.put(x, y, faceText(c, look), style);
  };
  /** A face-down card, optionally labelled with a count (the stock, or a folded stack). */
  const back = (x: number, y: number, count?: number, edge = false) =>
    buf.put(x, y, count === undefined ? ' '.repeat(geo.card) : center(countText(count), geo.card), { fg: 'back', bg: 'back', edge });
  /** Large cards write a one-digit count fullwidth, so it is as big as the ranks. */
  const countText = (count: number) => (count < 10 && !compact && !ascii ? fullwidth(String(count)) : String(count).padStart(2));
  /** An empty place, e.g. `[ Ａ ]` (or compact `[A ]`) for a foundation waiting for an ace. */
  const slot = (x: number, y: number, mark: string) => {
    const inner = mark + ' '.repeat(Math.max(0, 2 - textWidth(mark)));
    buf.put(x, y, compact ? '[' + inner + ']' : '[ ' + inner + ' ]', { fg: 'dim' });
  };
  const markRank = (rank: 1 | 13) => (compact ? rankLabel(rank) : rankGlyph(rank, ascii));
  /** The key label above the pile at `x` shows where cards are held (strong) and the cursor (weak). */
  const key = (x: number, y: number, target: PileId | { readonly kind: 'stock' }) => {
    let bg: Bg = 'none';
    if (target.kind === 'stock') {
      if (view.cursor.kind === 'stock') bg = 'cursor';
    } else if (view.held && samePile(view.held.from, target)) {
      bg = 'hold';
    } else if (view.cursor.kind !== 'stock' && samePile(view.cursor, target)) {
      bg = 'cursor';
    }
    // Exact foundation keys stay quiet unless active; the status bar promotes i instead.
    const fg = target.kind === 'foundation' && bg === 'none' ? 'dim' : 'key';
    // With large cards, keys are fullwidth too (ｑ ｗ ａ…), as big as the ranks.
    const plain = keyLabel(target);
    const label = compact || ascii || plain.length > 1 ? plain : fullwidth(plain);
    buf.put(x + Math.floor((geo.card - textWidth(label)) / 2), y, label, { fg, bg });
  };
  /**
   * Which face-up card of column `i` is chosen, if any: the first of the cards
   * the arrows chose, or of the exact cards in hand.
   */
  const chosenIn = (i: number): number | undefined => {
    const col = state.tableau[i]!;
    const here = (p: PileId | { readonly kind: 'stock' }) => p.kind === 'tableau' && p.index === i;
    const n = view.held ? (here(view.held.from) ? view.held.count : undefined) : here(view.cursor) ? view.selected : undefined;
    return n === undefined ? undefined : col.up.length - n;
  };

  // --- header --------------------------------------------------------------
  buf.put(1, ROW.header, `soliterminal ${g.sep} Klondike ${g.sep} Draw ${state.drawMode}`, { fg: 'header' });
  const stats = `Moves ${state.moves}` + (view.elapsedMs === undefined ? '' : `  ${formatTime(view.elapsedMs)}`);
  // Winnability: ✓ proven, … still checking, ? could not tell in time, 0% proven lost.
  let verdict =
    view.status === undefined
      ? undefined
      : {
          winnable: { text: g.yes, fg: 'key' as const },
          checking: { text: g.wait, fg: 'dim' as const },
          unclear: { text: '?', fg: 'message' as const }, // a warning: it may be lost
          lost: { text: '0%', fg: 'red' as const },
        }[view.status];
  if (verdict && view.status === 'winnable') {
    if (view.danger) verdict = { text: g.warn, fg: 'red' };
    else if (view.tight) verdict = { text: `${g.yes}!`, fg: 'message' };
  }
  const tail = verdict ? `  Win ${verdict.text}` : '';
  let hx = buf.put(width - 1 - textWidth(stats + tail), ROW.header, stats, { fg: 'dim' });
  if (verdict) {
    hx = buf.put(hx, ROW.header, '  Win ', { fg: 'dim' });
    buf.put(hx, ROW.header, verdict.text, { fg: verdict.fg, bold: view.status === 'lost' || view.danger !== undefined || view.tight === true });
  }

  // --- top row: stock, waste, foundations ----------------------------------
  key(colX(0), ROW.topKeys, { kind: 'stock' });
  if (state.stock.length > 0) back(colX(0), ROW.topCards, state.stock.length);
  else slot(colX(0), ROW.topCards, state.waste.length > 0 ? redealMark(state.redealsLeft, g) : ' ');
  // Redeals left, always in view just under the stock: ↺3, red once none are left.
  if (Number.isFinite(state.redealsLeft)) {
    const left = g.recycle + Math.min(state.redealsLeft, 99);
    const none = state.redealsLeft <= 0;
    buf.put(colX(0) + Math.floor((geo.card - textWidth(left)) / 2), ROW.topCards + 1, left, { fg: none ? 'red' : 'dim', bold: none });
  }

  key(colX(1), ROW.topKeys, pile.waste);
  const fan = state.waste.slice(state.drawMode === 3 ? -3 : -1);
  if (fan.length === 0) slot(colX(1), ROW.topCards, ' ');
  let fx = colX(1);
  fanPieces(fan, look, colX(3) - colX(1) - 1).forEach((text, i) => {
    fx = buf.put(fx, ROW.topCards, text, { fg: suitFg(fan[i]!), bg: 'card', bold: true });
  });

  state.foundations.forEach((foundation, i) => {
    const x = colX(3 + i);
    key(x, ROW.topKeys, pile.foundation(i));
    const top = foundation.at(-1);
    if (top) card(x, ROW.topCards, top);
    else slot(x, ROW.topCards, markRank(1));
  });

  // --- tableau -------------------------------------------------------------
  state.tableau.forEach((col, i) => {
    const x = colX(i);
    key(x, ROW.tableauKeys, pile.tableau(i));
    let y = ROW.tableau;
    if (col.down.length === 0 && col.up.length === 0) {
      slot(x, y, markRank(13));
      return;
    }
    // Face-down cards always have something below them: more backs, or the face-up run.
    if (downRows(col.down.length, fold) === 1 && col.down.length > 1) back(x, y++, col.down.length, true);
    else for (let d = 0; d < col.down.length; d++) back(x, y++, undefined, true);
    const chosen = chosenIn(i);
    col.up.forEach((c, j) => card(x, y++, c, j < col.up.length - 1, j === chosen));
  });

  // --- footer --------------------------------------------------------------
  const footer = height - FOOTER_ROWS;
  if (view.paused) buf.put(1, footer + 1, `${g.prompt} Paused. The clock waits until you come back.`, { fg: 'dim' });
  else if (view.message && view.danger?.message) buf.put(1, footer + 1, `${g.warn} ${view.message}`, { fg: 'red', bold: true });
  else if (view.message) buf.put(1, footer + 1, `${g.prompt} ${view.message}`, { fg: 'message' });
  buf.put(0, footer + 2, g.divider.repeat(width), { fg: 'dim' });
  if (view.record) drawRecord(buf, footer + 2, state.drawMode, view.record, view.lostBefore);
  // The first items of each row fit MIN_WIDTH; the last one shows when the window has room.
  const status: [string, string][][] = [
    [['q', 'draw'], ['w', 'waste'], ['a-j', 'columns'], ['i', 'to foundation'], ['z', 'undo'], ['?', 'hint']],
    [['arrows', 'select'], ['space', 'pick/drop'], ['tab', 'card size'], ['esc', 'menu'], ['x', 'quit']],
  ];
  status.forEach((items, row) => {
    let x = 1;
    items.forEach(([k, label], i) => {
      if (i === items.length - 1 && x + k.length + 1 + label.length > width - 1) return;
      x = buf.put(x, footer + 3 + row, k, { fg: 'key' });
      x = buf.put(x, footer + 3 + row, ` ${label}  `, { fg: 'dim' });
    });
  });

  if (view.celebration !== undefined) drawConfetti(buf, view.celebration, height - FOOTER_ROWS, ascii);
  if (view.dialog) drawDialog(buf, view.dialog, g, left, geo.board, height - FOOTER_ROWS);
  return buf;
}

/**
 * The record for this draw mode, set into the divider line:
 * `── Draw 1  won 12/20 (60%)  streak 3  longest 5  best 03:10 ──`.
 * Items drop off the end when the line is too narrow.
 */
function drawRecord(buf: ScreenBuffer, y: number, drawMode: number, m: ModeStats, lostBefore?: number): void {
  const items: [string, string][] = [
    ['Draw', String(drawMode)],
    // A deal lost before says so first after the mode, so it survives a narrow window.
    ...(lostBefore === undefined ? [] : [['lost before', formatWhen(lostBefore)] as [string, string]]),
    ['won', `${m.won}/${m.played} (${winRate(m)}%)`],
    ['streak', String(m.streak)],
    ['longest', String(m.bestStreak)],
  ];
  if (m.bestMs !== undefined) items.push(['best', formatTime(m.bestMs)]);
  const room = buf.width - 6;
  const widthOf = (n: number) => items.slice(0, n).reduce((w, [k, v]) => w + k.length + v.length + 3, 0) - 2;
  let n = items.length;
  while (n > 1 && widthOf(n) > room) n--;
  let x = buf.put(2, y, ' ', { fg: 'dim' });
  items.slice(0, n).forEach(([k, v], i) => {
    if (i > 0) x = buf.put(x, y, '  ', { fg: 'dim' });
    x = buf.put(x, y, k + ' ', { fg: 'dim' });
    x = buf.put(x, y, v, { fg: 'text' });
  });
  buf.put(x, y, ' ', { fg: 'dim' });
}

/** The empty stock: `↺` to redeal (with how many are left, if limited), or `×` when none are. */
function redealMark(left: number, g: Glyphs): string {
  if (!Number.isFinite(left)) return g.recycle;
  return left > 0 ? g.recycle + Math.min(left, 9) : g.none;
}

/**
 * The win ceremony: suits rain down over the board, each from its own column
 * at its own speed, so the screen fills and then clears. `ms` is how far in
 * it is. Purely a function of time, so every frame can be drawn on its own.
 */
function drawConfetti(buf: ScreenBuffer, ms: number, bottom: number, ascii: boolean): void {
  const glyphs = ascii ? ['S', 'H', 'D', 'C', '*'] : ['♠', '♥', '♦', '♣', '✦'];
  const count = Math.round(buf.width * 0.9);
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) >>> 0;
    seed = (seed + 0x6d2b79f5) >>> 0;
    return seed / 2 ** 32;
  };
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rand() * buf.width);
    const delay = rand() * 1_200;
    const speed = bottom / (0.8 + rand() * 0.8); // rows per second: 0.8-1.6 s to cross, whatever the height
    const kind = Math.floor(rand() * glyphs.length);
    // Each piece falls, pauses out of sight for a moment, and falls again: it keeps raining.
    const cycle = (bottom / speed) * 1000 + 300 + rand() * 1_200;
    const t = ms - delay;
    if (t < 0) continue;
    const y = Math.floor((((t % cycle) / 1000) * speed));
    if (y < 1 || y >= bottom) continue;
    const red = kind === 1 || kind === 2;
    // Over a card, keep the card and use its ink; elsewhere use the theme's colors.
    const under = buf.get(x, y);
    if (under.ch === '') continue; // the right half of a wide character
    const onCard = under.bg === 'card' || under.bg === 'back';
    const fg = onCard ? (under.bg === 'back' ? 'back' : red ? 'red' : 'black') : red ? 'red' : kind === 4 ? 'message' : 'key';
    buf.put(x, y, glyphs[kind]!, { fg, bg: onCard ? under.bg : 'none', bold: true });
    // A faint trail just above.
    if (y - 1 >= 1 && buf.get(x, y - 1).bg === 'none') buf.put(x, y - 1, ascii ? '.' : '·', { fg: 'dim' });
  }
}

interface Look {
  readonly ascii: boolean;
  readonly compact: boolean;
  readonly card: number;
}

/** ASCII to its fullwidth form: `q` → `ｑ`, `1` → `１`, `` ` `` → `｀`. */
function fullwidth(text: string): string {
  return text.replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
}

function center(text: string, width: number): string {
  const pad = Math.max(0, width - textWidth(text));
  return ' '.repeat(Math.ceil(pad / 2)) + text + ' '.repeat(Math.floor(pad / 2));
}

/** The rank alone, as this look draws it. */
function rankText(c: Card, look: Look): string {
  return look.compact ? rankLabel(c.rank) : rankGlyph(c.rank, look.ascii);
}

/**
 * What a card face says, padded to the card width: ` Ｋ♠️ `, ` 10♠️ `, compact
 * ` K♠ `, or in ascii `  KS  ` / ` KS `.
 */
function faceText(c: Card, look: Look): string {
  let text: string;
  if (look.compact) text = rankLabel(c.rank) + suitLabel(c.suit, look.ascii);
  else if (look.ascii) text = rankGlyph(c.rank, true).padStart(2) + c.suit + ' ';
  else text = rankGlyph(c.rank) + suitGlyph(c.suit);
  return center(text, look.card);
}

/**
 * The visible part of each Draw 3 waste card, left to right. Covered cards show
 * their leading gap, rank and suit; the top card shows in full. To keep a blank
 * cell before the foundations, padding goes first: the top card's trailing
 * space, then the leftmost card's leading space, and as a last resort the
 * leftmost card shows its rank alone.
 */
function fanPieces(fan: readonly Card[], look: Look, room: number): string[] {
  const pieces = fan.map((c, i) => (i < fan.length - 1 ? faceText(c, look).trimEnd() : faceText(c, look)));
  const total = () => pieces.reduce((w, p) => w + textWidth(p), 0);
  const last = pieces.length - 1;
  if (total() > room && last > 0 && pieces[last]!.endsWith(' ')) pieces[last] = pieces[last]!.slice(0, -1);
  if (total() > room && pieces[0]!.startsWith(' ')) pieces[0] = pieces[0]!.slice(1);
  if (total() > room && last > 0) pieces[0] = rankText(fan[0]!, look);
  return pieces;
}

/**
 * A box over the tableau, exactly as wide as the board so no card peeks out
 * beside it, with a blank row under it so none peeks out below either.
 */
function drawDialog(buf: ScreenBuffer, d: Dialog, g: Glyphs, left: number, board: number, bottom: number): void {
  const hint = `${g.updown} or letter choose  enter select  esc back`;
  // Each choice shows the letter that picks it: (N)ew game.
  const rows = [...d.lines, ...(d.lines.length > 0 ? [''] : []), ...d.choices.map((label) => `${g.prompt} (${label[0]})${label.slice(1)}`), '', hint];
  const needed = Math.max(textWidth(d.title) + 6, ...rows.map((r) => textWidth(r) + 4));
  const boxWidth = Math.min(buf.width - 2, Math.max(board, needed));
  const x = Math.max(1, Math.min(left - Math.floor((boxWidth - board) / 2), buf.width - 1 - boxWidth));
  const y = Math.max(1, Math.min(ROW.tableauKeys, bottom - rows.length - 3));
  const edge = { fg: d.danger ? 'red' : 'text' } as const;
  const first = d.lines.length > 0 ? d.lines.length + 1 : 0;

  const titled = `${g.h} ${d.title} `;
  buf.put(x, y, g.tl, edge);
  buf.put(x + 1, y, g.h, edge);
  const tx = buf.put(x + 2, y, ` ${d.title} `, { fg: d.danger ? 'red' : 'header', bold: true });
  buf.put(tx, y, g.h.repeat(Math.max(0, boxWidth - 1 - textWidth(titled) - 1)), edge);
  buf.put(x + boxWidth - 1, y, g.tr, edge);

  rows.forEach((text, i) => {
    const ry = y + 1 + i;
    buf.put(x, ry, g.v + ' '.repeat(boxWidth - 2) + g.v, edge);
    const choice = i - first;
    if (choice >= 0 && choice < d.choices.length) {
      const on = choice === d.selected;
      // The chosen row is a bar across the box, its marker in the key color.
      if (on) buf.put(x + 1, ry, ' '.repeat(boxWidth - 2), { bg: 'cursor' });
      const bg = on ? 'cursor' : 'none';
      const mx = buf.put(x + 2, ry, on ? g.prompt : ' ', { fg: 'key', bold: true, bg });
      const label = d.choices[choice]!;
      let cx = buf.put(mx + 1, ry, '(', { fg: 'dim', bg });
      cx = buf.put(cx, ry, label[0]!, { fg: 'key', bold: true, bg });
      cx = buf.put(cx, ry, ')', { fg: 'dim', bg });
      buf.put(cx, ry, label.slice(1), { fg: 'text', bold: on, bg });
    } else {
      buf.put(x + 2, ry, text, { fg: i === rows.length - 1 ? 'dim' : 'text' });
    }
  });
  buf.put(x, y + rows.length + 1, g.bl + g.h.repeat(boxWidth - 2) + g.br, edge);
  if (y + rows.length + 2 < bottom) buf.put(x, y + rows.length + 2, ' '.repeat(boxWidth));
}
