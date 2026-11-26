import { cardName } from './core/card.ts';
import {
  type DrawMode,
  type KlondikeState,
  type MoveError,
  type PileId,
  type Result,
  autoComplete,
  autoMove,
  canAutoComplete,
  deal,
  destinations,
  draw,
  foundationFor,
  isWon,
  maxTake,
  move,
  moveTo,
  moveToFoundation,
  pile,
  positionKey,
  samePile,
  TABLEAU_COLUMNS,
} from './core/klondike.ts';
import type { Level, SolverMove, Verdict } from './core/solver.ts';
import { EMPTY_STATS, type StatEvent, type Stats, type WinRecord, newGameId, pastGame, recordLoss, recordWin, statsFor, winRate, withLevel } from './stats.ts';
import { formatWhen } from './ui/help.ts';
import { MAX_BATCH, SHARE_EVERY, acceptShare, declineShare, finishedGames, markShared, shareDue, unsent } from './share.ts';
import { STOCK_KEY, keyLabel, pileForKey } from './ui/keymap.ts';
import type { CursorSpot, Dialog, View } from './ui/layout.ts';

/**
 * Cards picked up and waiting for a destination. Without a `count`, how many
 * is worked out on the drop: in Klondike at most one count fits any
 * destination. With one, exactly that many move.
 */
export interface Held {
  readonly from: PileId;
  readonly count?: number;
}

/**
 * Where the talon stood at the last move that was not a draw, and what
 * drawing has done since. Once every talon card has come round again with
 * nothing played, the player is going in circles: that is when a hint opens up.
 */
export interface Stall {
  /** Waste size at that move. */
  readonly waste: number;
  /** The waste has been turned over since. */
  readonly redealt: boolean;
}

const stallFrom = (game: KlondikeState): Stall => ({ waste: game.waste.length, redealt: false });

/** A settled answer about one position, kept for the rest of the deal. */
export interface Known {
  readonly verdict: 'winnable' | 'lost';
  /** With `winnable`: the first move of the win found, for hints. */
  readonly next?: SolverMove;
}

/** What is known about winning from the current position. */
export type Status = 'checking' | Verdict;

/** Hands out deals. `verified` means a solver has proven the deal winnable. */
export type Dealer = (drawMode: DrawMode) => { readonly seed: number; readonly verified: boolean };

/**
 * Everything the running game knows. `handleKey`, `tick` and `applyVerdict`
 * are pure, so the whole app can be driven from tests without a terminal.
 */
export interface App {
  readonly game: KlondikeState;
  /** Earlier game states, most recent last. Undo pops from here. */
  readonly history: readonly KlondikeState[];
  /** Bumped whenever the position changes, so late solver answers can be ignored. */
  readonly version: number;
  readonly status: Status;
  /**
   * Every position of this deal the solver has settled, by `positionKey`: the
   * ones played, and the ones a move away that it looked at in the meantime.
   * Coming back to one needs no wait, and a move into a known loss is caught
   * before it is made.
   */
  readonly known: ReadonlyMap<string, Known>;
  /** The latest position the solver proved winnable, to go back to after a loss. */
  readonly lastWinnable?: { readonly game: KlondikeState; readonly history: readonly KlondikeState[] };
  /**
   * The first position since the last winnable one that quick judging could
   * not settle, with its place in the history. It gets a long look in the
   * background: a game lost there is lost in every position played since.
   */
  readonly suspect?: { readonly game: KlondikeState; readonly at: number };
  /** The deal itself was proven winnable, so a restart starts out winnable. */
  readonly verified: boolean;
  /**
   * A box of choices on screen: the menu (esc), a question before giving up
   * a game, the choices after a loss or a win, sharing, or a seed asked for
   * while a game was kept. Other keys wait until it is answered.
   */
  readonly dialog?: DialogKind;
  /** The highlighted choice in the dialog; up and down move it, enter or space takes it. */
  readonly choice: number;
  /** When the dialog came up, so a key already on its way is not taken as the answer. */
  readonly dialogAt?: number;
  /** The deal asked for with --seed while a game was kept: the `seed` dialog offers it. */
  readonly seedOffer?: { readonly seed: number; readonly drawMode: DrawMode };
  /** The player chose to play on after a loss; do not ask again until it is winnable. */
  readonly playingOn: boolean;
  readonly cursor: CursorSpot;
  /** The column the cursor left for the top row (stock and waste), to go back down to. */
  readonly cameFrom?: number;
  /**
   * Cards chosen with down and up in the cursor's column, counted from the
   * top of the pile: the run from that card on. Unset means the whole run,
   * worked out on the drop.
   */
  readonly selected?: number;
  readonly held?: Held;
  readonly message: string;
  readonly stall: Stall;
  /** The player went through the whole stock without a move: `h` gives a hint. */
  readonly stalled: boolean;
  /** The first move of a win the solver found from position `version`. */
  readonly hint?: { readonly version: number; readonly move: SolverMove };
  readonly ascii: boolean;
  /** Small cards (tab switches); kept across deals. */
  readonly compact: boolean;
  /** Draw mode for the next deal. */
  readonly nextDrawMode: DrawMode;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  /** Set while the terminal does not have focus: the clock is stopped. */
  readonly pausedAt?: number;
  /** Time spent away so far in this game, left out of the clock. */
  readonly pausedMs: number;
  readonly showHelp: boolean;
  readonly showStats: boolean;
  /**
   * The deals screen (g): a seed being typed, the recent game chosen in the
   * list (0 is the newest), and the draw mode a typed seed is played in.
   */
  readonly deals?: DealsScreen;
  /** Redeals each new deal allows (`Infinity` for no limit). */
  readonly redeals: number;
  /** A server takes shared results, so the player may be asked to send them. */
  readonly canShare: boolean;
  readonly stats: Stats;
  /**
   * Lines for the statistics log, made since the runner last wrote them out.
   * The runner appends them and empties this.
   */
  readonly outbox: readonly StatEvent[];
  /**
   * Where this play of the deal stands: not yet counted (no card moved),
   * under way (it goes on record when it ends), or already on record as a win.
   */
  readonly play: 'fresh' | 'counted' | 'won';
  /** This play's name in the statistics; a restart keeps it, a new deal makes a new one. */
  readonly gameId: string;
  /** When this play started counting: its first card moved. */
  readonly gameAt?: number;
  /** The win just recorded, for the win dialog. */
  readonly lastWin?: WinRecord;
  /** The win ceremony is running; it ends on a `tick` or any key. */
  readonly celebrating: boolean;
  /** Auto-complete steps still to be shown, one per `tick`. */
  readonly autoQueue: readonly KlondikeState[];
  readonly quit: boolean;
}

export type DialogKind = 'menu' | 'restart' | 'new' | 'lost' | 'won' | 'share' | 'seed' | 'quit' | 'hint';

export interface DealsScreen {
  readonly typed: string;
  readonly index: number;
  readonly drawMode: DrawMode;
  /** Why Enter did nothing, until the next key. */
  readonly note?: string;
}

/** Seeds are 32-bit. */
const MAX_SEED = 0xffff_ffff;

const WELCOME = 'Press a pile key, then where it goes. Esc for the menu.';

const STALLED = 'This game can still be won, there is a move you have not tried. ? shows it.';

/**
 * Enter or space this soon after a dialog comes up on its own was meant for
 * the board, not the dialog. Dialogs the player opens are answered at once.
 */
export const DIALOG_GUARD_MS = 700;

/** Dialogs that come up without the player asking: a loss found, sharing after a win, a seed at start. */
const UNPROMPTED: ReadonlySet<DialogKind> = new Set(['lost', 'share', 'seed']);

/**
 * After any change: a dialog that has just come up starts on its first
 * choice, and one that came up on its own notes when, for the guard.
 */
export function stampDialog(before: App, after: App, now: number): App {
  if (after.dialog === undefined || after.dialog === before.dialog) return after;
  const { dialogAt: _, ...rest } = after;
  return UNPROMPTED.has(after.dialog) ? { ...rest, choice: 0, dialogAt: now } : { ...rest, choice: 0 };
}

/** How long the win ceremony runs before the results come up. */
export const CEREMONY_MS = 2_500;

export interface AppOptions {
  readonly ascii?: boolean;
  readonly compact?: boolean;
  readonly verified?: boolean;
  /** Redeals for new deals; defaults to what `game` started with. */
  readonly redeals?: number;
  readonly stats?: Stats;
  /** See {@link App.canShare}. */
  readonly canShare?: boolean;
  /** Carries on a play already named: see {@link App.gameId}. */
  readonly gameId?: string;
  readonly gameAt?: number;
}

export function createApp(game: KlondikeState, options: AppOptions = {}): App {
  const verified = options.verified ?? false;
  return {
    game,
    history: [],
    version: 0,
    status: verified ? 'winnable' : 'checking',
    known: new Map(),
    lastWinnable: verified ? { game, history: [] } : undefined,
    verified,
    playingOn: false,
    cursor: pile.tableau(0),
    message: WELCOME,
    stall: stallFrom(game),
    stalled: false,
    ascii: options.ascii ?? false,
    compact: options.compact ?? false,
    nextDrawMode: game.drawMode,
    showHelp: false,
    showStats: false,
    pausedMs: 0,
    redeals: options.redeals ?? game.redealsLeft,
    stats: options.stats ?? EMPTY_STATS,
    outbox: [],
    canShare: options.canShare ?? false,
    play: 'fresh',
    gameId: options.gameId ?? newGameId(),
    ...(options.gameAt === undefined ? {} : { gameAt: options.gameAt }),
    choice: 0,
    celebrating: false,
    autoQueue: [],
    quit: false,
  };
}

/** What a saved game brings back, beyond its positions. */
export interface ResumeOptions extends AppOptions {
  readonly play: 'fresh' | 'counted';
  /** Time on the clock when it was saved. */
  readonly ms: number;
  readonly now: number;
  /** Index into `states` of the last position known to be winnable, if one was saved. */
  readonly winnable?: number;
}

/**
 * A game picked up again from its positions, the deal first: undo reaches
 * back to the deal, the clock carries on from where it stopped, and the
 * position is judged afresh.
 */
export function resumeApp(states: readonly KlondikeState[], options: ResumeOptions): App {
  const start = createApp(states[0]!, options);
  const game = states[states.length - 1]!;
  const clock = options.ms > 0 ? { startedAt: options.now - options.ms } : {};
  if (states.length === 1) return { ...start, ...clock, play: options.play, message: 'Welcome back. Your game is where you left it.' };
  let app: App = {
    ...start,
    game,
    history: states.slice(0, -1),
    version: 1,
    status: 'checking',
    stall: stallFrom(game),
    play: options.play,
    startedAt: options.now - options.ms,
    message: 'Welcome back. Your game is where you left it.',
  };
  // Where z goes back to after a loss: saved with the game, else the deal.
  const w = options.winnable;
  if (w !== undefined && Number.isInteger(w) && w >= 0 && w < states.length) app = { ...app, lastWinnable: { game: states[w]!, history: states.slice(0, w) } };
  // Quit in the middle of finishing: finish now.
  if (canAutoComplete(game)) app = { ...app, status: 'winnable', autoQueue: autoComplete(game) };
  return app;
}

/** One row of a dialog: what it says, and what taking it does. */
interface Choice {
  readonly label: string;
  readonly act: (app: App, now: number, dealer: Dealer) => App;
}

/** What a dialog shows and offers. `cancel` is what esc does. */
interface DialogSpec {
  readonly title: string;
  readonly lines: readonly string[];
  readonly choices: readonly Choice[];
  readonly cancel: (app: App, now: number, dealer: Dealer) => App;
  readonly danger?: boolean;
}

const close = (app: App): App => ({ ...app, dialog: undefined });
const carryOn = (app: App): App => ({ ...close(app), message: 'Carry on.' });
const keepPlaying: Choice = { label: 'Keep playing', act: carryOn };

/** Nothing to give up while no card has moved, or once the game is over. */
const untouched = (app: App): boolean => app.play !== 'counted' || app.finishedAt !== undefined;

/** The menu that esc brings up: everything that is not a move. */
function menuSpec(app: App): DialogSpec {
  const other: DrawMode = app.nextDrawMode === 1 ? 3 : 1;
  return {
    title: 'Menu',
    lines: [],
    choices: [
      { label: 'Resume', act: close },
      { label: 'New game', act: (a, now, dealer) => (untouched(a) ? newGame(close(a), dealer, undefined, now) : { ...a, held: undefined, dialog: 'new' }) },
      { label: 'Restart this deal', act: (a) => askRestart(close(a)) },
      { label: `Switch to Draw ${other}`, act: (a, now, dealer) => switchDraw(close(a), dealer, now) },
      { label: 'Hint', act: (a) => showHint(close(a)) },
      { label: 'Play a seed or a recent game', act: (a) => openDeals(close(a)) },
      { label: 'Statistics', act: (a) => ({ ...close(a), held: undefined, showStats: true }) },
      { label: 'Help', act: (a) => ({ ...close(a), showHelp: true }) },
      { label: 'Quit (your game is kept)', act: (a) => ({ ...a, quit: true }) },
    ],
    cancel: close,
  };
}

/** The results after a win: this game, then the record for its draw mode. */
function wonSpec(app: App): DialogSpec {
  const win = app.lastWin;
  const m = statsFor(app.stats, app.game.drawMode);
  const lines: string[] = [];
  if (win) {
    const turns = win.redeals === 0 ? 'no redeals' : win.redeals === 1 ? '1 redeal' : `${win.redeals} redeals`;
    lines.push(`${win.moves} moves in ${formatTime(win.ms)}, ${turns}.`);
    const best = [win.bestTime && 'best time', win.fewestMoves && 'fewest moves'].filter(Boolean);
    if (best.length > 0) lines.push(`New record: ${best.join(' and ')}!`);
  }
  lines.push(`Draw ${app.game.drawMode}: won ${m.won} of ${m.played} (${winRate(m)}%).`);
  lines.push(`Streak ${m.streak}, longest ${m.bestStreak}.`);
  const look = (a: App): App => ({ ...close(a), message: 'Esc for the menu: a new deal, or choose one.' });
  return {
    title: 'You won!',
    lines,
    choices: [
      { label: 'New deal', act: (a, now, dealer) => newGame(a, dealer, undefined, now) },
      { label: 'Choose a deal', act: (a) => openDeals(close(a)) },
      { label: 'Statistics', act: (a) => ({ ...close(a), showStats: true }) },
      { label: 'Look at the board', act: look },
      // Nothing to keep: the next start deals a new game.
      { label: 'Quit', act: (a) => ({ ...a, quit: true }) },
    ],
    cancel: look,
  };
}

/** The question at each hundred games. */
function shareSpec(app: App): DialogSpec {
  const total = finishedGames(app.stats);
  const n = (x: number) => x.toLocaleString('en-US');
  // Asked after a win: either answer goes on to the results.
  const results = (a: App): App => (a.finishedAt !== undefined ? { ...a, dialog: 'won' } : close(a));
  const notNow = (a: App): App => {
    const next = (Math.floor(finishedGames(a.stats) / SHARE_EVERY) + 1) * SHARE_EVERY;
    return say({ ...results(a), stats: declineShare(a.stats) }, `Not sent. You will be asked again at ${n(next)} games.`);
  };
  const next = (Math.floor(total / SHARE_EVERY) + 1) * SHARE_EVERY;
  return {
    title: `You won, and that makes ${n(total)} games!`,
    lines: [
      'Send your results to Klondike research?',
      `${n(Math.min(unsent(app.stats).length, MAX_BATCH))} games: seed, mode, result, time, moves.`,
      'Nothing about you or your computer is sent.',
      `Not now asks again at ${n(next)}, with all games.`,
    ],
    choices: [
      { label: 'Send', act: (a) => say({ ...results(a), stats: acceptShare(a.stats) }, 'Thank you! Sending your results...') },
      { label: 'Not now', act: notNow },
    ],
    cancel: notNow,
  };
}

/** The choices after a proven loss, saying how far back it may have been lost when that is more than one move. */
function lostSpec(app: App): DialogSpec {
  const since = app.history.length - (app.lastWinnable?.history.length ?? 0);
  const playOn = (a: App): App => ({ ...close(a), playingOn: true, message: 'Playing on. This deal can no longer be won.' });
  return {
    title: 'No way to win from here',
    lines: since <= 1 ? ['Win chance is now 0%. Try again?'] : [`It was lost within the last ${since} moves.`, 'Going back goes to just before them.'],
    choices: [
      { label: 'Back to the last winnable spot', act: (a) => backToWinnable(a) },
      { label: 'Restart this deal', act: (a) => restart(a) },
      { label: 'New deal', act: (a, now, dealer) => newGame(a, dealer, undefined, now) },
      { label: 'Play on', act: playOn },
      { label: 'Quit (your game is kept)', act: (a) => ({ ...a, quit: true }) },
    ],
    cancel: playOn,
    danger: true,
  };
}

/** A seed was asked for on the command line while a game was kept. */
function seedSpec(app: App): DialogSpec {
  const offer = app.seedOffer;
  const keep = (a: App): App => ({ ...close(a), seedOffer: undefined, message: 'Welcome back. Your game is where you left it.' });
  return {
    title: 'A game is in progress',
    lines: offer ? [`You asked for seed ${offer.seed}, Draw ${offer.drawMode}.`, 'Giving up the kept game counts as a loss.'] : [],
    choices: [
      { label: 'Carry on with the kept game', act: keep },
      { label: offer ? `Give up and play seed ${offer.seed}` : 'Give up', act: (a, now) => (a.seedOffer ? playSeed({ ...close(a), seedOffer: undefined }, a.seedOffer.seed, a.seedOffer.drawMode, now) : keep(a)) },
    ],
    cancel: keep,
  };
}

function confirmSpec(kind: 'restart' | 'new'): DialogSpec {
  return kind === 'restart'
    ? {
        title: 'Restart this deal?',
        lines: ['Every move so far will be undone.'],
        choices: [{ label: 'Restart', act: (a) => restart(a) }, keepPlaying],
        cancel: carryOn,
      }
    : {
        title: 'Give up this game?',
        lines: ['A new deal replaces this one. It counts as a loss.'],
        choices: [{ label: 'Give up and deal a new game', act: (a, now, dealer) => newGame(a, dealer, undefined, now) }, keepPlaying],
        cancel: carryOn,
      };
}

/** ? when a hint is there to give: asked first, since seeing it is a choice. */
function hintSpec(): DialogSpec {
  return {
    title: 'Show a hint?',
    lines: ['The solver knows a move you have not tried.'],
    choices: [{ label: 'Show the hint', act: (a) => showHint(close(a)) }, keepPlaying],
    cancel: carryOn,
  };
}

/** The question x asks; a finished game has nothing to keep. */
function quitSpec(app: App): DialogSpec {
  return {
    title: 'Quit soliterminal?',
    lines: [app.finishedAt === undefined ? 'Your game is kept: run soliterminal to carry on.' : 'See you next time.'],
    choices: [{ label: 'Quit', act: (a) => ({ ...a, quit: true }) }, keepPlaying],
    cancel: carryOn,
  };
}

function specOf(app: App): DialogSpec | undefined {
  switch (app.dialog) {
    case undefined:
      return undefined;
    case 'quit':
      return quitSpec(app);
    case 'hint':
      return hintSpec();
    case 'menu':
      return menuSpec(app);
    case 'won':
      return wonSpec(app);
    case 'share':
      return shareSpec(app);
    case 'lost':
      return lostSpec(app);
    case 'seed':
      return seedSpec(app);
    case 'restart':
    case 'new':
      return confirmSpec(app.dialog);
  }
}

/** The dialog as the screen draws it. */
function dialogView(app: App): Dialog | undefined {
  const spec = specOf(app);
  if (!spec) return undefined;
  const choice = Math.min(app.choice, spec.choices.length - 1);
  return { title: spec.title, lines: spec.lines, choices: spec.choices.map((c) => c.label), selected: choice, ...(spec.danger ? { danger: true } : {}) };
}

export function viewOf(app: App, now: number): View {
  const elapsedMs = playTime(app, now);
  const warning = app.dialog ? undefined : heldWarning(app);
  return {
    danger: warning === undefined ? undefined : { message: app.message.includes(warning) },
    tight: noSlack(app) || undefined,
    cursor: app.cursor,
    selected: app.selected,
    held: app.held && { from: app.held.from, count: app.held.count },
    message: app.message,
    elapsedMs,
    paused: app.pausedAt !== undefined,
    record: statsFor(app.stats, app.game.drawMode),
    lostBefore: pastGame(app.stats, app.game.seed, app.game.drawMode, 'lost')?.at,
    status: app.status,
    dialog: dialogView(app),
    // The confetti keeps falling behind the results until they are put away.
    celebration: (app.celebrating || afterWin(app)) && app.finishedAt !== undefined ? now - app.finishedAt : undefined,
  };
}

// ---------------------------------------------------------------------------
// Words

const pileName = (p: PileId): string =>
  p.kind === 'waste' ? 'the waste' : p.kind === 'tableau' ? `column ${p.index + 1}` : keyLabel(p);

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The card that leads a move from `from`: the bottom of the run being moved. */
function leadCard(app: App, from: PileId, count = 1): string {
  const g = app.game;
  const cards = from.kind === 'waste' ? g.waste : from.kind === 'foundation' ? g.foundations[from.index]! : g.tableau[from.index]!.up;
  const card = cards[cards.length - Math.max(1, count)];
  return card ? cardName(card, app.ascii) : pileName(from);
}

function explain(app: App, error: MoveError, from: PileId, to?: PileId): string {
  const held = app.held;
  const lead = leadCard(app, from);
  switch (error) {
    case 'empty-source':
      return from.kind === 'waste' ? `The waste is empty. Press ${STOCK_KEY} to draw.` : `Nothing to move from ${pileName(from)}.`;
    case 'stock-empty':
      return 'The stock and the waste are both empty.';
    case 'no-redeals':
      return 'No redeals left: the waste cannot be turned over again.';
    case 'bad-count':
      return 'Those cards cannot move together.';
    case 'same-pile':
    case 'no-move':
      return `${lead} has nowhere to go right now.`;
    case 'wrong-foundation': {
      const card = cardAt(app, from);
      const home = card === undefined ? undefined : foundationFor(app.game, card);
      const where = home === undefined ? 'another foundation' : keyLabel(pile.foundation(home));
      return `${lead} goes on ${where}. Press ${keyLabel({ kind: 'auto-foundation' })} to send it there.`;
    }
    case 'not-allowed':
      if (to?.kind === 'tableau' && from.kind === 'tableau' && held) {
        return `Nothing in ${pileName(from)} fits on ${pileName(to)}.`;
      }
      if (to === undefined || to.kind === 'foundation') return `${lead} cannot go to a foundation yet.`;
      return `${lead} cannot go on ${pileName(to)}.`;
  }
}

function cardAt(app: App, from: PileId) {
  const g = app.game;
  if (from.kind === 'waste') return g.waste.at(-1);
  if (from.kind === 'foundation') return g.foundations[from.index]!.at(-1);
  return g.tableau[from.index]!.up.at(-1);
}

// ---------------------------------------------------------------------------
// State changes

const say = (app: App, message: string): App => ({ ...app, message });

/** On the winning move: stop the clock, count the win once, and start the ceremony. */
function winIfDone(app: App, now: number): App {
  if (!isWon(app.game) || app.finishedAt !== undefined) return app;
  const ms = playTime(app, now);
  let { stats, play, lastWin, outbox } = app;
  if (play !== 'won') {
    const id = { id: app.gameId, seed: app.game.seed, at: app.gameAt ?? now, limit: dealLimit(app) };
    const r = recordWin(stats, app.game.drawMode, ms, app.game.moves, { ...id, redeals: redealsUsed([...app.history, app.game]) });
    stats = r.stats;
    lastWin = r.record;
    outbox = [...outbox, { game: r.game }];
    play = 'won';
  }
  return {
    ...app,
    finishedAt: now,
    status: 'winnable',
    stats,
    outbox,
    play,
    lastWin,
    celebrating: true,
    held: undefined,
    message: `You won! ${app.game.moves} moves in ${formatTime(ms)}.`,
  };
}

/** Redeals the deal allowed: what it started with, before any were used. */
const dealLimit = (app: App): number => (app.history[0] ?? app.game).redealsLeft;

/** The background's rating of a finished game's deal. */
export function applyRating(app: App, id: string, level: Level): App {
  return { ...app, stats: withLevel(app.stats, id, level), outbox: [...app.outbox, { level: { id, level } }] };
}

/** How many times the waste was turned over along the way: undone redeals do not count. */
export function redealsUsed(states: readonly KlondikeState[]): number {
  let n = 0;
  for (let i = 1; i < states.length; i++) if (states[i - 1]!.stock.length === 0 && states[i]!.stock.length > 0) n++;
  return n;
}

/** Time on the clock: from the first move, less any time the terminal was out of focus. */
export function playTime(app: App, now: number): number {
  if (app.startedAt === undefined) return 0;
  const end = app.finishedAt ?? app.pausedAt ?? now;
  return Math.max(0, end - app.startedAt - app.pausedMs);
}

/** The terminal lost focus: stop the clock. */
function blur(app: App, now: number): App {
  return app.pausedAt === undefined ? { ...app, pausedAt: now } : app;
}

/** Focus is back: start the clock again, leaving out the time away. */
function focus(app: App, now: number): App {
  if (app.pausedAt === undefined) return app;
  // Before the first move there is no clock running yet to make up for.
  const away = app.startedAt === undefined ? 0 : now - Math.max(app.pausedAt, app.startedAt);
  return { ...app, pausedAt: undefined, pausedMs: app.pausedMs + away };
}

/**
 * Ends the ceremony and shows the results; first, when a new hundred games
 * is reached and a server takes them, the question about sharing them. A win
 * is the time to ask, never the middle of a game or the start of one.
 */
function endCeremony(app: App): App {
  const ask = app.canShare && shareDue(app.stats);
  return { ...app, celebrating: false, dialog: ask ? 'share' : 'won' };
}

/** Right after a win: the results, or the question before them. The confetti keeps falling behind both. */
const afterWin = (app: App): boolean => app.finishedAt !== undefined && (app.dialog === 'won' || app.dialog === 'share');

/**
 * Leaving this play of the deal unfinished ends the win streak. New deals
 * call this themselves; the runner calls it on quit only when the game cannot
 * be kept for later.
 */
export function abandon(app: App, now = Date.now()): App {
  if (app.play !== 'counted') return app;
  // A loss proven while playing says which move lost it: the one after the last winnable position.
  const lostAt = app.status === 'lost' ? (app.lastWinnable ? app.lastWinnable.history.length + 1 : 0) : undefined;
  const end = { id: app.gameId, seed: app.game.seed, ms: Math.round(playTime(app, now)), moves: app.game.moves, at: app.gameAt ?? now, limit: dealLimit(app), lostAt };
  const r = recordLoss(app.stats, app.game.drawMode, end);
  return { ...app, stats: r.stats, outbox: [...app.outbox, { game: r.game }], play: 'fresh' };
}

/** A new position: the solver's earlier answer no longer applies. */
function moved(app: App, game: KlondikeState, history: readonly KlondikeState[]): App {
  return recall({
    ...app,
    game,
    history,
    version: app.version + 1,
    status: 'checking',
    dialog: undefined,
    held: undefined,
    stall: stallFrom(game),
    stalled: false,
  });
}

/** Adds a settled answer to what is known. `unclear` settles nothing. */
function remember(app: App, game: KlondikeState, verdict: Verdict, next?: SolverMove): App {
  if (verdict === 'unclear') return app;
  const known = new Map(app.known);
  known.set(positionKey(game), { verdict, next });
  return { ...app, known };
}

/** The same position with one redeal fewer: if that cannot be won, the win needs every redeal left. */
function oneRedealLess(game: KlondikeState): KlondikeState | undefined {
  return Number.isFinite(game.redealsLeft) && game.redealsLeft > 0 ? { ...game, redealsLeft: game.redealsLeft - 1 } : undefined;
}

/**
 * The position to judge to find out whether a winnable game has any redeal to
 * spare, while that is not known yet. Its answer goes in through `applyAhead`.
 */
export function slackCheck(app: App): KlondikeState | undefined {
  if (app.status !== 'winnable') return undefined;
  const less = oneRedealLess(app.game);
  return less && !app.known.has(positionKey(less)) ? less : undefined;
}

/** Winnable, but only by using every redeal left: one more wasted trip through the stock loses. */
function noSlack(app: App): boolean {
  const less = app.status === 'winnable' ? oneRedealLess(app.game) : undefined;
  return less !== undefined && app.known.get(positionKey(less))?.verdict === 'lost';
}

/** A position already settled is answered at once: no solver, no wait. */
function recall(app: App): App {
  const k = app.known.get(positionKey(app.game));
  if (!k) return app;
  return k.verdict === 'winnable' ? settleWinnable(app, k.next) : lose({ ...app, suspect: undefined });
}

/** The current position is proven winnable. */
function settleWinnable(app: App, next?: SolverMove): App {
  return {
    ...app,
    status: 'winnable',
    playingOn: false,
    // Winnable now means winnable at every step on the way here: nothing left to suspect.
    suspect: undefined,
    lastWinnable: { game: app.game, history: app.history },
    hint: next && { version: app.version, move: next },
    message: app.stalled ? STALLED : app.message,
  };
}

/**
 * A warning when the cards in hand have a known losing place to go. Which
 * place is not said: the choice stays the player's.
 */
function heldWarning(app: App): string | undefined {
  const held = app.held;
  if (!held) return undefined;
  const results =
    held.count === undefined ? destinations(app.game, held.from).map((to) => moveTo(app.game, held.from, to)) : exactMoves(app.game, held.from, held.count);
  const ends = results.flatMap((r) => (r.ok ? [app.known.get(positionKey(r.state))?.verdict] : []));
  const lost = ends.filter((v) => v === 'lost').length;
  if (lost === 0) return undefined;
  if (lost === ends.length) return 'Careful: wherever it goes, the game is lost.';
  return ends.length === 2 ? 'Careful: one of its two places loses the game.' : 'Careful: one place it can go loses the game.';
}

/**
 * Applies a game result. On success the old state goes on the undo stack and
 * the held cards are dropped. On failure the cards stay in hand so the player
 * can try another destination, or F9, straight away.
 */
function commit(app: App, result: Result, now: number, onError: (e: MoveError) => string, isDraw = false): App {
  if (!result.ok) return say(app, onError(result.error));
  let next: App = {
    ...moved(app, result.state, [...app.history, app.game]),
    message: '',
    startedAt: app.startedAt ?? now,
  };
  // The cursor stays where the cards came from: the card turned up there, or the next one in the waste, is usually what comes next.
  // The first card moved makes this a played game. Drawing alone only looks through the stock.
  if (next.play === 'fresh' && !isDraw) next = { ...next, play: 'counted', gameAt: now };
  if (canAutoComplete(next.game)) {
    next = {
      ...next,
      status: 'winnable',
      autoQueue: autoComplete(next.game),
      message: 'Every card is face up. Finishing the game...',
    };
  }
  return winIfDone(next, now);
}

const TABLEAU_TARGETS = Array.from({ length: TABLEAU_COLUMNS }, (_, i) => pile.tableau(i));

/** Puts held cards on `to`: exactly `count` of them if set, otherwise the count that fits. */
function place(game: KlondikeState, held: Held, to: PileId): Result {
  if (held.count === undefined || (held.count === 1 && to.kind === 'foundation')) return moveTo(game, held.from, to);
  return move(game, held.from, to, held.count);
}

/** Every result of putting exactly `count` cards from `from` somewhere, best first, as autoMove orders them. */
function exactMoves(game: KlondikeState, from: PileId, count: number): Result[] {
  const filled = TABLEAU_TARGETS.filter((t) => t.kind === 'tableau' && game.tableau[t.index]!.up.length > 0);
  const empty = TABLEAU_TARGETS.filter((t) => t.kind === 'tableau' && game.tableau[t.index]!.up.length === 0);
  const home = count === 1 ? [moveToFoundation(game, from)] : [];
  const columns = [...filled, ...empty].filter((to) => !samePile(from, to)).map((to) => move(game, from, to, count));
  return [...home, ...columns].filter((r) => r.ok);
}

/** "7♥", or "7♥ and the 2 cards on it". */
function runName(app: App, from: PileId, count: number): string {
  const lead = leadCard(app, from, count);
  return count <= 1 ? lead : `${lead} and the ${count === 2 ? 'card' : `${count - 1} cards`} on it`;
}

function pick(app: App, from: PileId, count?: number): App {
  const max = maxTake(app.game, from);
  if (max === 0) return say(app, explain(app, 'empty-source', from));
  // A foundation key leaves the cursor where it is; the arrows may have put it on the foundation already.
  const cursor = from.kind === 'foundation' ? app.cursor : from;
  const exact = count !== undefined && from.kind === 'tableau' ? Math.min(count, max) : undefined;
  const what = exact !== undefined ? runName(app, from, exact) : max > 1 ? pileName(from) : leadCard(app, from);
  const next: App = { ...app, cursor, held: { from, count: exact } };
  return { ...next, message: `Holding ${what}. ${heldWarning(next) ?? 'Where does it go?'}` };
}

function drop(app: App, to: PileId, now: number): App {
  const held = app.held!;
  if (samePile(held.from, to)) return autoFrom(app, held.from, now, held.count);
  return commit(app, place(app.game, held, to), now, (e) => explain(app, e, held.from, to));
}

function drawCard(app: App, now: number): App {
  const cleared = { ...app, held: undefined };
  const next = commit(cleared, draw(app.game), now, (e) => explain(cleared, e, pile.waste), true);
  // A freshly turned card is usually the next thing to play, so the cursor follows it.
  // Recycling the waste leaves nothing there, so the cursor stays put. Drawing
  // with the cursor on the stock keeps it there, so space can draw again.
  const turned = next.game !== app.game && next.game.waste.length > 0;
  if (!turned) return next;
  const g = next.game;
  const out = g.stock.length === 0 && Number.isFinite(g.redealsLeft);
  const left = g.redealsLeft === 1 ? '1 redeal left' : `${g.redealsLeft} redeals left`;
  return {
    ...next,
    cursor: app.cursor.kind === 'stock' ? app.cursor : pile.waste,
    message: out ? `The stock is out. ${g.redealsLeft === 0 ? 'No redeals left.' : `${left}.`}` : next.message,
  };
}

/**
 * Keeps track of drawing since the last real move. The player is stalled once
 * the waste has been turned over and has grown back to where it was, so every
 * talon card has been on top since, or once a draw fails: the stock is out and
 * cannot be turned again, so it has nothing left to show.
 */
function watchStall(before: App, after: App): App {
  if (after.finishedAt !== undefined || after.autoQueue.length > 0) return after;
  const s = before.stall;
  let stall = s;
  let stalled = before.stalled;
  if (after.game !== before.game) {
    stall = { ...s, redealt: s.redealt || before.game.stock.length === 0 };
    stalled ||= stall.redealt && after.game.waste.length >= s.waste;
  } else {
    stalled = true;
  }
  const next = { ...after, stall, stalled };
  // Said as soon as the solver agrees there is a way on; see applyVerdict.
  if (stalled && !before.stalled && next.status === 'winnable') return { ...next, message: STALLED };
  return next;
}

/** `h`: the solver's next move, but only once the player has gone round the stock without one. */
function showHint(app: App): App {
  if (!app.stalled) return say(app, 'Hints open up once you go through the whole stock without a move.');
  if (app.status === 'checking') return say(app, 'Still checking this position. Ask again in a moment.');
  const move = app.hint?.version === app.version ? app.hint.move : undefined;
  if (app.status !== 'winnable' || !move) return say(app, 'No hint here: a win from this position is not confirmed.');
  const g = app.game;
  const card = cardName(move.card, app.ascii);
  const to =
    move.to.kind === 'foundation'
      ? `its foundation (${keyLabel({ kind: 'auto-foundation' })})`
      : `${pileName(pile.tableau(move.to.index))} (${keyLabel(pile.tableau(move.to.index))})`;
  const base = { ...app, held: undefined };
  switch (move.from.kind) {
    case 'talon': {
      const top = g.waste.at(-1);
      const onTop = top !== undefined && top.suit === move.card.suit && top.rank === move.card.rank;
      const message = onTop
        ? `Hint: ${card} from the waste (${keyLabel(pile.waste)}) to ${to}.`
        : `Hint: draw until ${card} is on the waste, then play it to ${to}.`;
      return { ...base, cursor: pile.waste, message };
    }
    case 'tableau': {
      const from = pile.tableau(move.from.index);
      const more = move.count > 1 ? ` and the ${move.count - 1 === 1 ? 'card' : `${move.count - 1} cards`} on it` : '';
      const message = `Hint: ${card}${more} from ${pileName(from)} (${keyLabel(from)}) to ${to}.`;
      // Part of a run: choose just those cards, so space picks up the right ones.
      const part = move.count < maxTake(g, from) ? move.count : undefined;
      return { ...base, cursor: from, selected: part, message };
    }
    case 'foundation': {
      const f = g.foundations.findIndex((p) => {
        const top = p.at(-1);
        return top !== undefined && top.suit === move.card.suit && top.rank === move.card.rank;
      });
      const key = f < 0 ? '' : ` (${keyLabel(pile.foundation(f))})`;
      return { ...base, message: `Hint: take ${card} back down from its foundation${key} to ${to}.` };
    }
  }
}

/** ?: asks before showing a hint, when there is one to show; otherwise says why not. */
function askHint(app: App): App {
  const ready = app.stalled && app.status === 'winnable' && app.hint?.version === app.version;
  return ready ? { ...app, held: undefined, dialog: 'hint' } : showHint(app);
}

/** Sends cards to the best spot: exactly `count` of them if given, else whatever fits. */
function autoFrom(app: App, from: PileId, now: number, count?: number): App {
  if (count === undefined) return commit(app, autoMove(app.game, from), now, (e) => explain(app, e, from));
  const best = exactMoves(app.game, from, count)[0];
  if (!best) return say(app, `${runName(app, from, count)} ${count > 1 ? 'have' : 'has'} nowhere to go right now.`);
  return commit(app, best, now, () => '');
}

function toFoundation(app: App, now: number): App {
  const from = app.held?.from ?? (app.cursor.kind === 'stock' ? pile.waste : app.cursor);
  return commit(app, moveToFoundation(app.game, from), now, (e) => explain(app, e, from, pile.foundation(0)));
}

function fresh(app: App, game: KlondikeState, verified: boolean, message: string): App {
  const next = createApp(game, { ascii: app.ascii, compact: app.compact, verified, redeals: app.redeals, stats: app.stats, canShare: app.canShare });
  return { ...next, outbox: app.outbox, version: app.version + 1, nextDrawMode: app.nextDrawMode, message };
}

function newGame(app: App, dealer: Dealer, drawMode = app.nextDrawMode, now?: number): App {
  const { seed, verified } = dealer(drawMode);
  const left = abandon(app, now);
  return { ...fresh(left, deal(seed, drawMode, app.redeals), verified, greeting(left, seed, drawMode, 'New game.')), nextDrawMode: drawMode };
}

/**
 * The same deal from the start. An unfinished game carries on as the same
 * play in the statistics; after a win it is a new one.
 */
function restart(app: App): App {
  // The same deal goes through the same positions: what is known about them still holds.
  const next = recall({ ...fresh(app, deal(app.game.seed, app.game.drawMode, app.redeals), app.verified, 'Same deal, from the start.'), known: app.known });
  return app.play === 'counted' ? { ...next, play: 'counted', gameId: app.gameId, ...(app.gameAt === undefined ? {} : { gameAt: app.gameAt }) } : next;
}

/** Restart, after asking; not before a move, and not once the deal is won. */
function askRestart(app: App): App {
  if (app.game.moves === 0 && app.history.length === 0) return say(app, 'This deal is already at the start.');
  // A deal won stays won: it is not played again.
  if (app.play === 'won') return say(app, 'This deal is won. Choose New game in the menu.');
  return { ...app, held: undefined, dialog: 'restart' };
}

/** A deal proven winnable in one mode may not be in the other, so an untouched deal is replaced; else the next deal switches. */
function switchDraw(app: App, dealer: Dealer, now: number): App {
  const nextDrawMode: DrawMode = app.nextDrawMode === 1 ? 3 : 1;
  if (untouched(app) && app.finishedAt === undefined) return { ...newGame(app, dealer, nextDrawMode, now), message: `Draw ${nextDrawMode}.` };
  return { ...app, nextDrawMode, message: `Draw ${nextDrawMode} from the next game.` };
}

function backToWinnable(app: App): App {
  const snap = app.lastWinnable;
  if (!snap) return restart(app);
  return {
    ...moved(app, snap.game, snap.history),
    status: 'winnable',
    playingOn: false,
    message: 'Back to the last winnable position.',
  };
}

const STOCK = { kind: 'stock' } as const;

/** The top row, left to right: stock, waste, then the foundations over columns 4 to 7. */
const TOP_ROW: CursorSpot[] = [STOCK, pile.waste, ...Array.from({ length: 4 }, (_, i) => pile.foundation(i))];
/** What is straight above each column. Nothing is above column 3, so it goes to the waste, the nearest. */
const ABOVE: CursorSpot[] = [STOCK, pile.waste, pile.waste, ...TOP_ROW.slice(2)];
/** The column straight below each place in the top row. */
const BELOW = [0, 1, 3, 4, 5, 6];

const sameSpot = (a: CursorSpot, b: CursorSpot): boolean =>
  a.kind === 'stock' || b.kind === 'stock' ? a.kind === b.kind : samePile(a, b);

/**
 * Left and right stay on their row: round the seven columns, or along the top
 * row without wrapping. Only up and down change rows.
 */
function cursorSideways(app: App, step: 1 | -1): App {
  const c = app.cursor;
  if (c.kind === 'tableau') return { ...app, cursor: pile.tableau((c.index + step + TABLEAU_COLUMNS) % TABLEAU_COLUMNS) };
  const i = TOP_ROW.findIndex((p) => sameSpot(p, c));
  const next = TOP_ROW[i + step];
  return next ? { ...app, cursor: next } : app;
}

/**
 * Up goes to whatever is straight above, as on the board. With cards chosen
 * in a column it first walks the choice back up the run, a card at a time;
 * past its first card it leaves the column.
 */
function cursorUp(app: App): App {
  const c = app.cursor;
  if (c.kind !== 'tableau') return app;
  const max = maxTake(app.game, c);
  if (app.selected !== undefined && app.selected < max) return choose(app, c, app.selected + 1);
  return { ...app, cursor: ABOVE[c.index]!, selected: undefined };
}

/** Says which cards are chosen, as down and up move through a run. */
function choose(app: App, from: PileId, n: number): App {
  return { ...app, selected: n, message: `${runName(app, from, n)}: space picks ${n === 1 ? 'it' : 'them'} up.` };
}

/**
 * Down in a column chooses cards down its run: first the whole run, from its
 * top card, then one card fewer each time. From the top row it goes to the
 * column below, or back to the one the cursor came up from.
 */
function cursorDown(app: App): App {
  const c = app.cursor;
  if (c.kind === 'tableau') {
    const max = maxTake(app.game, c);
    if (app.held || max <= 1) return app;
    return choose(app, c, app.selected === undefined ? max : Math.max(1, app.selected - 1));
  }
  const back = app.cameFrom !== undefined && sameSpot(ABOVE[app.cameFrom]!, c) ? app.cameFrom : undefined;
  const index = back ?? BELOW[TOP_ROW.findIndex((p) => sameSpot(p, c))]!;
  return { ...app, cursor: pile.tableau(index) };
}

/**
 * Remembers the column whenever the cursor goes from it to the top row,
 * however it got there. Chosen cards are let go once the cursor or the
 * position changes, unless the key chose them afresh.
 */
function trackColumn(before: App, after: App): App {
  let next = after;
  const moved = !sameSpot(before.cursor, after.cursor) || before.version !== after.version || after.held !== undefined;
  if (moved && after.selected !== undefined && after.selected === before.selected) next = { ...next, selected: undefined };
  if (next.cursor.kind === 'tableau') return next.cameFrom === undefined ? next : { ...next, cameFrom: undefined };
  if (before.cursor.kind === 'tableau') return { ...next, cameFrom: before.cursor.index };
  return next;
}

/** A particular deal, chosen by seed: not checked first, so the solver judges it as play starts. */
function playSeed(app: App, seed: number, drawMode: DrawMode, now: number): App {
  const left = abandon(app, now);
  return { ...fresh(left, deal(seed, drawMode, app.redeals), false, greeting(left, seed, drawMode, `Seed ${seed}, Draw ${drawMode}.`)), nextDrawMode: drawMode };
}

/** The answer came back from the server: the games sent are marked, or the batch waits for the next start. */
export function applyShared(app: App, ids: readonly string[], error?: string): App {
  if (error) return say(app, `Results not sent: ${error}. Trying again next start.`);
  const stats = markShared(app.stats, ids);
  return say({ ...app, stats, outbox: [...app.outbox, { sent: ids }] }, `Sent ${ids.length.toLocaleString('en-US')} games. Thank you for helping research!`);
}

/** The opening line of a deal, saying when it was lost before if it was. */
function greeting(app: App, seed: number, drawMode: DrawMode, first: string): string {
  const lost = pastGame(app.stats, seed, drawMode, 'lost');
  return lost ? `${first} You lost this deal on ${formatWhen(lost.at)}. Revenge?` : `${first} Good luck!`;
}

function openDeals(app: App): App {
  return { ...app, held: undefined, deals: { typed: '', index: 0, drawMode: app.nextDrawMode } };
}

/** Keys on the deals screen: type a seed or choose a recent game, then Enter. */
function handleDeals(app: App, screen: DealsScreen, key: string, now: number): App {
  // Any key clears a note from the last Enter.
  const set = (change: Partial<DealsScreen>): App => ({ ...app, deals: { ...screen, note: undefined, ...change } });
  const recent = app.stats.games;
  if (/^[0-9]$/.test(key)) {
    const typed = (screen.typed === '0' ? '' : screen.typed) + key;
    return Number(typed) > MAX_SEED ? app : set({ typed });
  }
  switch (key) {
    case 'backspace':
      return set({ typed: screen.typed.slice(0, -1) });
    case 'up':
    case 'down': {
      if (recent.length === 0) return app;
      const index = Math.min(recent.length - 1, Math.max(0, screen.index + (key === 'down' ? 1 : -1)));
      return set({ typed: '', index });
    }
    case 'left':
    case 'right':
      return set({ drawMode: screen.drawMode === 1 ? 3 : 1 });
    case 'space':
    case 'enter': {
      const pick = screen.typed ? { seed: Number(screen.typed), drawMode: screen.drawMode } : recent[screen.index];
      if (!pick) return app;
      const closed = { ...app, deals: undefined };
      const current = pick.seed === app.game.seed && pick.drawMode === app.game.drawMode && app.finishedAt === undefined && app.game.moves > 0;
      if (current) return say(closed, 'That is the game you are playing.');
      const won = pastGame(app.stats, pick.seed, pick.drawMode, 'won');
      if (won) return set({ note: `Seed ${pick.seed} was won on ${formatWhen(won.at)}: won deals are not played again.` });
      return playSeed(closed, pick.seed, pick.drawMode, now);
    }
    case 'escape':
      return { ...app, deals: undefined };
    default:
      return app;
  }
}

/**
 * Keys while a dialog is up: up and down choose, enter or space takes the
 * choice, esc backs out. Anything else is ignored.
 */
function handleDialog(app: App, key: string, dealer: Dealer, now: number): App {
  const spec = specOf(app);
  if (!spec) return close(app);
  const n = spec.choices.length;
  switch (key) {
    case 'up':
    case 'down':
      return { ...app, choice: (Math.min(app.choice, n - 1) + (key === 'down' ? 1 : n - 1)) % n };
    case 'enter':
    case 'space':
      // A key already on its way when the dialog came up was meant for the board.
      if (app.dialogAt !== undefined && now >= app.dialogAt && now - app.dialogAt < DIALOG_GUARD_MS) return app;
      return spec.choices[Math.min(app.choice, n - 1)]!.act(app, now, dealer);
    case 'escape':
      return spec.cancel(app, now, dealer);
    case 'z':
    case 'backspace':
      // After a loss, undo still means going back.
      return app.dialog === 'lost' ? backToWinnable(app) : app;
    default:
      return app;
  }
}

/**
 * One key press. `now` is the clock in ms and `dealer` supplies new deals;
 * both are passed in so tests stay deterministic.
 */
export function handleKey(app: App, key: string, now: number, dealer: Dealer): App {
  return stampDialog(app, trackColumn(app, press(app, key, now, dealer)), now);
}

function press(app: App, key: string, now: number, dealer: Dealer): App {
  if (key === 'focus-out') return blur(app, now);
  // A key press means the player is here, even if the terminal never said focus came back.
  app = focus(app, now);
  if (key === 'focus-in') return app;
  if (key === 'ctrl+c' || key === 'ctrl+q') return { ...app, quit: true };
  if (app.showHelp) return { ...app, showHelp: false };
  if (app.showStats) return { ...app, showStats: false };
  // Any key cuts the ceremony short.
  if (app.celebrating) return endCeremony(app);
  if (app.deals) return handleDeals(app, app.deals, key, now);
  if (app.dialog) return handleDialog(app, key, dealer, now);

  // Any key during auto-complete jumps straight to the end.
  if (app.autoQueue.length > 0) {
    const last = app.autoQueue[app.autoQueue.length - 1]!;
    return winIfDone({ ...app, game: last, history: [...app.history, app.game], autoQueue: [] }, now);
  }

  const target = pileForKey(key);
  if (target) {
    if (target.kind === 'stock') return watchStall(app, drawCard(app, now));
    if (target.kind === 'auto-foundation') return toFoundation(app, now);
    return app.held ? drop(app, target, now) : pick(app, target);
  }

  switch (key) {
    case 'left':
    case 'right':
      return cursorSideways(app, key === 'right' ? 1 : -1);
    case 'up':
      return cursorUp(app);
    case 'down':
      return cursorDown(app);
    case 'space':
      if (app.cursor.kind === 'stock') return app.held ? say(app, 'Cards cannot go on the stock.') : watchStall(app, drawCard(app, now));
      if (app.held) return drop(app, app.cursor, now);
      return pick(app, app.cursor, app.selected);
    case 'enter': {
      if (!app.held && app.cursor.kind === 'stock') return watchStall(app, drawCard(app, now));
      const from = app.held?.from ?? (app.cursor.kind === 'stock' ? pile.waste : app.cursor);
      return autoFrom({ ...app, held: undefined }, from, now, app.held ? app.held.count : app.selected);
    }
    case 'escape':
      // Esc first puts held cards back; with nothing in hand it brings up the menu.
      if (app.held) return { ...app, held: undefined, message: 'Put back.' };
      return { ...app, dialog: 'menu' };
    case 'tab':
      return { ...app, compact: !app.compact, message: app.compact ? 'Large cards.' : 'Compact cards. Tab for large ones.' };
    case 'z':
    case 'backspace': {
      const prev = app.history[app.history.length - 1];
      if (!prev) return say(app, 'Nothing to undo.');
      return { ...moved(app, prev, app.history.slice(0, -1)), finishedAt: undefined, message: 'Undone.' };
    }
    case '?':
    case '/':
      return askHint(app);
    case 'e':
      return say(app, 'e sits over the gap in the top row: nothing there. Esc for the menu.');
    case 'x':
      return { ...app, held: undefined, dialog: 'quit' };
    default:
      return app;
  }
}

/**
 * The solver's answer for position `version`, with the first move of the win
 * it found when there is one. Answers for older positions are dropped. A
 * proven loss brings up the retry choices.
 */
export function applyVerdict(app: App, version: number, verdict: Verdict, next?: SolverMove): App {
  if (version !== app.version || app.status !== 'checking') return app;
  app = remember(app, app.game, verdict, next);
  switch (verdict) {
    case 'winnable':
      return settleWinnable(app, next);
    case 'unclear': {
      // The first unsettled position after a winnable one is where a loss would have started.
      const known = liveSuspect(app);
      const suspect = known ?? { game: app.game, at: app.history.length };
      // Say so the moment it happens: this move may be the one that loses the game.
      const warn = !known && !app.playingOn && app.message === '';
      const message = warn ? 'Win ? : a win from here is not confirmed yet. Checking deeper; z undoes.' : app.message;
      return { ...app, status: 'unclear', suspect, message };
    }
    case 'lost':
      return lose({ ...app, suspect: undefined });
  }
}

function lose(app: App): App {
  if (app.playingOn) return { ...app, status: 'lost' };
  return { ...app, status: 'lost', dialog: 'lost', held: undefined, message: '' };
}

/** The suspect position, if this game still passes through it (undo or a restart can leave it behind). */
export function liveSuspect(app: App): App['suspect'] {
  const s = app.suspect;
  if (!s) return undefined;
  const onPath = s.at === app.history.length ? app.game === s.game : app.history[s.at] === s.game;
  return onPath ? s : undefined;
}

/**
 * The long look at the suspect position is back. A loss there is a loss
 * here too, since no move can make a lost game winnable again. A win there
 * moves the point to go back to forward.
 */
export function applyDeepVerdict(app: App, game: KlondikeState, verdict: Verdict): App {
  app = remember(app, game, verdict);
  const s = liveSuspect(app);
  if (!s || s.game !== game) return app.suspect && !s ? { ...app, suspect: undefined } : app;
  const cleared = { ...app, suspect: undefined };
  switch (verdict) {
    case 'lost':
      if (app.status === 'lost') return cleared;
      return lose(cleared);
    case 'winnable': {
      const ahead = (app.lastWinnable?.history.length ?? -1) < s.at;
      return ahead ? { ...cleared, lastWinnable: { game: s.game, history: app.history.slice(0, s.at) } } : cleared;
    }
    case 'unclear':
      // Give up on this one; the next unsettled position will be looked at instead.
      return cleared;
  }
}

/**
 * The answer for `game`, a position one move from where the player was when
 * it was asked. It is kept; if the player has since moved there it settles the
 * position now, and if it is a loss the cards in hand could make, they are warned.
 */
export function applyAhead(app: App, game: KlondikeState, verdict: Verdict, next?: SolverMove): App {
  if (verdict === 'unclear') return app;
  if (app.status === 'checking' && positionKey(app.game) === positionKey(game)) return applyVerdict(app, app.version, verdict, next);
  app = remember(app, game, verdict, next);
  const warning = verdict === 'lost' && !app.dialog ? heldWarning(app) : undefined;
  return warning ? { ...app, message: warning } : app;
}

/** Whether the runner should keep ticking: auto-complete steps, the ceremony, or confetti behind the results. */
export function animating(app: App): boolean {
  return app.autoQueue.length > 0 || app.celebrating || afterWin(app);
}

/**
 * Shows the next auto-complete step, or moves the ceremony along. The runner
 * calls this on a short timer while `animating`.
 */
export function tick(app: App, now: number): App {
  if (app.celebrating) return now - (app.finishedAt ?? now) >= CEREMONY_MS ? endCeremony(app) : app;
  const [next, ...rest] = app.autoQueue;
  if (!next) return app;
  return winIfDone({ ...app, game: next, history: [...app.history, app.game], autoQueue: rest }, now);
}
