import { ScreenBuffer } from './screen.ts';
import type { DrawMode } from '../core/klondike.ts';
import { type GameRecord, type ModeStats, type Stats, statsFor, winRate } from '../stats.ts';

const HELP: [string, string][] = [
  ['', 'Press where cards come from, then where they go.'],
  ['', ''],
  ['~ or `', 'draw from the stock'],
  ['1', 'the waste'],
  ['q w e r t y u', 'tableau columns 1 to 7'],
  ['F9', 'send to its foundation (the usual way)'],
  ['F5 F6 F7 F8', 'one particular foundation'],
  ['same key twice', 'move to the best spot'],
  ['', ''],
  ['arrows', 'move round the board; up and down change rows'],
  ['down in a column', 'choose cards from the top of the run, one fewer each time'],
  ['space', 'pick up / put down at the cursor; draw on the stock'],
  ['enter', 'move the cursor\'s cards to the best spot'],
  ['esc', 'put held cards back; otherwise large / compact cards'],
  ['', ''],
  ['z', 'undo'],
  ['h', 'hint, after a trip through the stock with no move'],
  ['n', 'new game (always a winnable deal)'],
  ['F2', 'start this deal over (asks first)'],
  ['d', 'switch Draw 1 / Draw 3'],
  ['s', 'statistics'],
  ['g', 'play a deal by its seed, or one of your recent games'],
  ['x', 'quit (asks first; the game is kept)'],
  ['ctrl+c', 'quit at once'],
  ['', ''],
  ['', 'Win ✓ in the header: this position can still be won.'],
  ['', 'Win 0%: it cannot. You will be offered a retry.'],
  ['', '↺3 under the stock: redeals left (turning the waste over).'],
];

export function renderHelp(width: number, height: number, ascii = false): ScreenBuffer {
  const buf = new ScreenBuffer(width, height);
  const sep = ascii ? '-' : '·';
  buf.put(1, 0, `soliterminal ${sep} Help`, { fg: 'header' });
  HELP.forEach(([key, text], i) => {
    const y = i + 2;
    if (!key) {
      buf.put(3, y, ascii ? text.replace('✓', 'ok').replace('↺', 'O') : text, { fg: 'text' });
      return;
    }
    buf.put(3, y, key, { fg: 'key' });
    buf.put(20, y, text, { fg: 'text' });
  });
  buf.put(1, Math.min(height - 1, HELP.length + 3), 'Press any key to go back to the game.', { fg: 'message' });
  return buf;
}

function formatTime(ms: number | undefined): string {
  if (ms === undefined) return '-';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Statistics for both draw modes, side by side. */
export function renderStats(width: number, height: number, stats: Stats, ascii = false): ScreenBuffer {
  const buf = new ScreenBuffer(width, height);
  buf.put(1, 0, `soliterminal ${ascii ? '-' : '·'} Statistics`, { fg: 'header' });
  const rows: [string, (m: ModeStats) => string][] = [
    ['Played', (m) => String(m.played)],
    ['Won', (m) => String(m.won)],
    ['Win rate', (m) => `${winRate(m)}%`],
    ['Streak', (m) => String(m.streak)],
    ['Longest streak', (m) => String(m.bestStreak)],
    ['Best time', (m) => formatTime(m.bestMs)],
    ['Fewest moves', (m) => (m.fewestMoves === undefined ? '-' : String(m.fewestMoves))],
  ];
  const col = [20, 32];
  buf.put(col[0]!, 2, 'Draw 1', { fg: 'key', bold: true });
  buf.put(col[1]!, 2, 'Draw 3', { fg: 'key', bold: true });
  rows.forEach(([label, value], i) => {
    const y = 4 + i;
    buf.put(3, y, label, { fg: 'text' });
    buf.put(col[0]!, y, value(statsFor(stats, 1)), { fg: 'text', bold: true });
    buf.put(col[1]!, y, value(statsFor(stats, 3)), { fg: 'text', bold: true });
  });
  buf.put(3, 5 + rows.length, 'A game counts from the first card moved.', { fg: 'dim' });
  buf.put(3, 6 + rows.length, 'A new deal before this one is done ends the streak.', { fg: 'dim' });
  buf.put(1, Math.min(height - 1, rows.length + 8), 'Press any key to go back to the game.', { fg: 'message' });
  return buf;
}

/** The game on screen, so its row in the list shows the clock as it runs. */
export interface CurrentGame {
  readonly seed: number;
  readonly drawMode: DrawMode;
  readonly ms: number;
  readonly moves: number;
  /** Under way: a card has moved and it is not finished. */
  readonly playing: boolean;
}

/** A date and time in the player's own time zone, like 11-26 14:02. */
export const formatWhen = (at: number): string => {
  if (at <= 0) return '';
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** The deals screen: a seed to type, and recent games to choose from. */
export function renderDeals(
  width: number,
  height: number,
  recent: readonly GameRecord[],
  screen: { readonly typed: string; readonly index: number; readonly drawMode: DrawMode; readonly note?: string },
  current: CurrentGame,
  ascii = false,
): ScreenBuffer {
  const buf = new ScreenBuffer(width, height);
  buf.put(1, 0, `soliterminal ${ascii ? '-' : '·'} Deals`, { fg: 'header' });
  let x = buf.put(3, 2, 'Seed  ', { fg: 'text' });
  x = buf.put(x, 2, screen.typed, { fg: 'key', bold: true });
  buf.put(x, 2, ' ', { bg: 'cursor' });
  buf.put(Math.max(x + 3, 24), 2, `Draw ${screen.drawMode}  (d switches)`, { fg: 'dim' });
  // What became of the typed deal before.
  if (screen.typed) {
    const seed = Number(screen.typed);
    const won = recent.find((g) => g.seed === seed && g.drawMode === screen.drawMode && g.result === 'won');
    const lost = recent.find((g) => g.seed === seed && g.drawMode === screen.drawMode && g.result === 'lost');
    if (won) buf.put(9, 3, `Won on ${formatWhen(won.at)}: won deals are not played again.`, { fg: 'red' });
    else if (lost) buf.put(9, 3, `Lost on ${formatWhen(lost.at)}.`, { fg: 'message' });
  }

  buf.put(3, 4, 'Your games', { fg: 'key', bold: true });
  const cols = [5, 17, 23, 34, 41, 48, 56, 64];
  ['Seed', 'Draw', 'Result', 'Time', 'Moves', 'Redeals', 'Level', 'When'].forEach((h, i) => buf.put(cols[i]!, 5, h, { fg: 'dim' }));
  const room = Math.max(1, height - 11);
  // Keep the chosen row in view.
  const first = Math.max(0, Math.min(screen.index - room + 1, recent.length - room));
  if (recent.length === 0) buf.put(5, 6, 'None yet: games are listed from the first card moved.', { fg: 'dim' });
  recent.slice(first, first + room).forEach((g, k) => {
    const i = first + k;
    const y = 6 + k;
    const chosen = screen.typed === '' && i === screen.index;
    // The newest unfinished entry for the game on screen is that game: show its clock as it runs.
    const live = g.result === 'playing' && current.playing && g.seed === current.seed && g.drawMode === current.drawMode && recent.findIndex((r) => r.result === 'playing' && r.seed === g.seed && r.drawMode === g.drawMode) === i;
    // A loss proven in play says at which move; one given up while it might still be won says so.
    const lost = g.lostAt === undefined ? (['gave up', 'message'] as const) : g.lostAt === 0 ? (['no win', 'red'] as const) : ([`lost @${g.lostAt}`, 'red'] as const);
    const [result, fg] =
      g.result === 'won' ? (['won', 'key'] as const) : g.result === 'lost' ? lost : live ? (['playing', 'message'] as const) : (['unfinished', 'dim'] as const);
    const ms = live ? current.ms : g.ms;
    const moves = live ? current.moves : g.moves;
    const shown = g.result !== 'playing' || live;
    if (chosen) buf.put(3, y, ascii ? '>' : '›', { fg: 'key', bold: true });
    buf.put(cols[0]!, y, String(g.seed), { fg: chosen ? 'key' : 'text', bold: chosen });
    buf.put(cols[1]!, y, String(g.drawMode), { fg: 'text' });
    buf.put(cols[2]!, y, result, { fg });
    buf.put(cols[3]!, y, shown ? formatTime(ms) : '-', { fg: 'text' });
    buf.put(cols[4]!, y, shown ? String(moves).padStart(5) : '    -', { fg: 'text' });
    buf.put(cols[7]!, y, formatWhen(g.at), { fg: 'dim' });
    // Lost deals are rated in the background: … until then, ? if no win was found to rate them by.
    if (g.result === 'lost') {
      const level = g.level === undefined ? (ascii ? '..' : '…') : (['?', 'easy', 'medium', 'hard'] as const)[g.level];
      buf.put(cols[6]!, y, level, { fg: g.level === 3 ? 'red' : g.level === undefined ? 'dim' : 'text' });
    }
    if (g.result === 'won' && g.redeals !== undefined) buf.put(cols[5]!, y, String(g.redeals).padStart(3), { fg: 'text' });
  });

  const foot = Math.min(height - 3, 7 + Math.min(room, Math.max(recent.length, 1)));
  const arrows = ascii ? 'up / down' : '↑ ↓';
  buf.put(1, foot, `Type a seed, or choose a game with ${arrows}. Enter plays it; esc goes back.`, { fg: 'message' });
  if (screen.note) buf.put(1, foot + 1, screen.note, { fg: 'red', bold: true });
  else if (current.playing) buf.put(1, foot + 1, 'Playing another deal gives up the game in progress.', { fg: 'dim' });
  return buf;
}

/** A centred notice, used when the window is too small to draw the board. */
export function renderNotice(width: number, height: number, lines: string[]): ScreenBuffer {
  const buf = new ScreenBuffer(Math.max(width, 1), Math.max(height, 1));
  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  lines.forEach((line, i) => {
    const x = Math.max(0, Math.floor((width - line.length) / 2));
    buf.put(x, top + i, line, { fg: i === 0 ? 'message' : 'text' });
  });
  return buf;
}
