#!/usr/bin/env node
/**
 * Play Klondike in the terminal.
 *
 *   node src/cli.ts [--seed N] [--draw 1|3] [--redeals N|unlimited] [--compact] [--theme NAME] [--ascii] [--any-deal]
 */
import { readFileSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { parseArgs } from 'node:util';
import {
  type App,
  type Dealer,
  animating,
  applyAhead, applyRating, applyShared, playTime, slackCheck, stampDialog,
  applyDeepVerdict,
  applyVerdict,
  createApp,
  handleKey,
  liveSuspect,
  resumeApp,
  tick,
  viewOf,
} from './app.ts';
import type { KlondikeState } from './core/klondike.ts';
import { randomSeed } from './core/deck.ts';
import { DEFAULT_REDEALS, type DrawMode, deal, positionKey, successors } from './core/klondike.ts';
import { findWinnableSeed } from './core/solver.ts';
import { SolverClient } from './solver-client.ts';
import { ansi, diff } from './ui/ansi.ts';
import { loadSavedGame, removeSavedGame, replaySaved, savedGamePath, snapshot, writeSavedGame } from './saved-game.ts';
import { type GameRecord, type ShareState, type Stats, pastGame, unrated } from './stats.ts';
import { postShare, sharePayload, shareUrl } from './share.ts';
import { appendStats, loadStats, saveShare, statsPath } from './stats-file.ts';
import { renderDeals, renderHelp, renderNotice, renderStats } from './ui/help.ts';
import { normalizeKey } from './ui/input.ts';
import { MIN_WIDTH, minScreenHeight, renderKlondike } from './ui/layout.ts';
import type { ScreenBuffer } from './ui/screen.ts';
import { ACCENTS, isAccent, pickTheme } from './ui/theme.ts';

const AUTO_STEP_MS = 60;
/** Winnable deals kept ready per draw mode, so `n` never has to wait. */
const DEALS_AHEAD = 2;

/** The options; a mistyped one gets a line of help rather than a stack trace. */
const { values } = (() => {
  try {
    return parseArgs({
      options: {
        seed: { type: 'string' },
        draw: { type: 'string', default: '1' },
        redeals: { type: 'string' },
        ascii: { type: 'boolean', default: false },
        compact: { type: 'boolean', default: false },
        theme: { type: 'string' },
        'any-deal': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}. See soliterminal --help.\n`);
    process.exit(2);
  }
})();

if (values.help) {
  process.stdout.write(
    'Usage: soliterminal [--seed N] [--draw 1|3] [--redeals N|unlimited] [--compact] [--theme NAME] [--ascii] [--any-deal]\n' +
      `  --redeals N   times the waste can be turned over (default ${DEFAULT_REDEALS}; 'unlimited' for no limit)\n` +
      '  --seed N      play deal N (0 to 4294967295); asks first if a game is kept\n' +
      '  --compact     start with small cards (tab switches while playing)\n' +
      `  --theme NAME  colors from your terminal palette: ${Object.keys(ACCENTS).join(', ')} (default green)\n` +
      '  --any-deal    deal any shuffle, not only ones proven winnable\n' +
      '\n' +
      'Environment:\n' +
      '  SOLITERMINAL_CARD=ddd|fff  card face: soft grey-white (default) or pure white\n' +
      '  SOLITERMINAL_THEME=NAME    same as --theme\n' +
      '  SOLITERMINAL_STATS=PATH    where statistics are kept (a log, one line per game)\n' +
      '  SOLITERMINAL_GAME=PATH     where the game in progress is kept (default: next to the statistics)\n' +
      '  SOLITERMINAL_SHARE_URL=URL where shared results go (for testing a share server)\n' +
      '  COLORTERM=truecolor        exact card colors (otherwise 256-color matches)\n' +
      '  NO_COLOR=1                 no color at all\n',
  );
  process.exit(0);
}

const themeName = values.theme?.trim().toLowerCase();
if (themeName !== undefined && !isAccent(themeName)) {
  process.stderr.write(`Unknown theme "${values.theme}". Choose one of: ${Object.keys(ACCENTS).join(', ')}.\n`);
  process.exit(2);
}

function parseRedeals(text: string | undefined): number {
  if (text === undefined) return DEFAULT_REDEALS;
  const t = text.trim().toLowerCase();
  if (t === 'unlimited' || t === 'inf' || t === 'infinity') return Infinity;
  const n = Number(t);
  if (Number.isInteger(n) && n >= 0 && n <= 99) return n;
  process.stderr.write(`--redeals takes a number from 0 to 99, or 'unlimited'; got "${text}".\n`);
  process.exit(2);
}
const redeals = parseRedeals(values.redeals);

function parseSeed(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  if (/^\d{1,10}$/.test(t) && Number(t) <= 0xffff_ffff) return Number(t);
  process.stderr.write(`--seed takes a whole number from 0 to 4294967295; got "${text}".\n`);
  process.exit(2);
}
const seedAsked = parseSeed(values.seed);

if (values.draw !== '1' && values.draw !== '3') {
  process.stderr.write(`--draw takes 1 or 3; got "${values.draw}".\n`);
  process.exit(2);
}

const { stdin, stdout } = process;
if (!stdin.isTTY || !stdout.isTTY) {
  process.stderr.write('soliterminal needs an interactive terminal.\n');
  process.exit(1);
}

const ascii = values.ascii;
const anyDeal = values['any-deal'];
const theme = pickTheme(process.env, true, themeName);
const solver = new SolverClient();

// --- deals ---------------------------------------------------------------------

const ready: Record<DrawMode, number[]> = { 1: [], 3: [] };
const filling: Record<DrawMode, boolean> = { 1: false, 3: false };

/** Keeps a couple of proven-winnable seeds in stock, found in the background. */
function refill(drawMode: DrawMode): void {
  if (anyDeal || filling[drawMode] || ready[drawMode].length >= DEALS_AHEAD) return;
  filling[drawMode] = true;
  solver.deal(drawMode, redeals, (seed) => {
    filling[drawMode] = false;
    if (seed !== undefined) ready[drawMode].push(seed);
    refill(drawMode);
  });
}

/** The statistics as they stand; the app's once it exists. */
let currentStats = (): Stats => stats;
/** A deal won is not dealt again in the same draw mode. */
const wonAlready = (seed: number, drawMode: DrawMode) => pastGame(currentStats(), seed, drawMode, 'won') !== undefined;

const dealer: Dealer = (drawMode) => {
  const fresh = () => {
    let seed = randomSeed();
    while (wonAlready(seed, drawMode)) seed = randomSeed();
    return seed;
  };
  if (anyDeal) return { seed: fresh(), verified: false };
  // Normally a seed is waiting. If not, finding one here takes well under a second.
  let seed = ready[drawMode].shift();
  while (seed !== undefined && wonAlready(seed, drawMode)) seed = ready[drawMode].shift();
  seed ??= findWinnableSeed(drawMode, fresh, { redeals });
  refill(drawMode);
  return seed === undefined ? { seed: fresh(), verified: false } : { seed, verified: true };
};

const drawMode: DrawMode = values.draw === '3' ? 3 : 1;
const statsFile = statsPath(process.env);
const gameFile = savedGamePath(process.env, statsFile);

/**
 * The game in progress is kept on disk and picked up again on the next start.
 * --seed asks for a particular deal: if a game under way is kept, the player
 * is asked first whether to give it up (a loss) or carry on with it.
 */
const saved = loadSavedGame(gameFile);
const resumed = saved ? replaySaved(saved) : undefined;
const stats = loadStats(statsFile);

const shareTo = shareUrl(process.env);
const options = { ascii, compact: values.compact, redeals, stats, canShare: shareTo !== undefined };
let app: App;
if (resumed && saved && (seedAsked === undefined || saved.play === 'counted')) {
  app = resumeApp(resumed, {
    ...options,
    verified: saved.verified,
    play: saved.play,
    ms: saved.ms,
    now: Date.now(),
    winnable: saved.winnable,
    gameId: saved.id,
    ...(saved.at === undefined ? {} : { gameAt: saved.at }),
  });
  if (seedAsked !== undefined) app = { ...app, dialog: 'seed', choice: 0, seedOffer: { seed: seedAsked, drawMode } };
} else {
  const first = seedAsked === undefined ? dealer(drawMode) : { seed: seedAsked, verified: false };
  app = createApp(deal(first.seed, drawMode, redeals), { ...options, verified: first.verified });
}
refill(app.game.drawMode);

currentStats = () => app.stats;
let savedShare: ShareState | undefined = app.stats.share;

/**
 * Writes what changed: new lines for the statistics log (then reads the log
 * back, so games finished in other windows count too), the share state, and
 * the game whenever it moves. A failed save is not worth interrupting a game for.
 */
function saveIfChanged(): void {
  if (app.outbox.length > 0) {
    const ended = app.outbox.some((e) => 'game' in e);
    const written = appendStats(statsFile, app.outbox);
    app = { ...app, outbox: [] };
    if (written && ended) {
      const share = app.stats.share;
      app = { ...app, stats: { ...loadStats(statsFile), ...(share ? { share } : {}) } };
    }
    rateIfNeeded();
    shareIfAgreed();
  }
  if (app.stats.share !== savedShare) {
    savedShare = app.stats.share;
    if (savedShare) saveShare(statsFile, savedShare);
    shareIfAgreed();
  }
  saveGame();
}

/**
 * Rates lost deals in the background, one at a time, newest first: a few
 * seconds each on a worker of its own. One left unrated when soliterminal
 * quit is rated on a later run.
 */
let rating: GameRecord | undefined;
function rateIfNeeded(): void {
  if (rating) return;
  const game = unrated(app.stats);
  if (!game) return;
  rating = game;
  const limit = game.limit === null ? Infinity : (game.limit ?? DEFAULT_REDEALS);
  solver.rate(deal(game.seed, game.drawMode, limit), (level) => {
    rating = undefined;
    app = applyRating(app, game.id, level);
    saveIfChanged();
    render();
  });
}

/** What this program calls itself to the share server: its name and version, nothing more. */
function clientName(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return `soliterminal/${pkg.version ?? '?'}`;
  } catch {
    return 'soliterminal';
  }
}

/**
 * Sends the batch the player agreed to share. One try per run: a failure
 * waits for the next start rather than retrying against a struggling server.
 */
let shareTried = false;
function shareIfAgreed(): void {
  if (!shareTo || shareTried) return;
  const batch = sharePayload(app.stats, clientName());
  if (!batch) return;
  shareTried = true;
  void postShare(shareTo, batch.payload).then((error) => {
    app = applyShared(app, batch.games.map((g) => g.id), error);
    saveIfChanged();
    render();
  });
}

let keptGame: KlondikeState | undefined;
let keptHistory: readonly KlondikeState[] | undefined;
let keptPlay: App['play'] | undefined;
let kept = false;
/**
 * Writes the game in progress when it changed, or `always` (to bring the
 * clock up to date); a finished game is removed. Says whether a game is kept.
 */
function saveGame(always = false): boolean {
  if (!always && app.game === keptGame && app.history === keptHistory && app.play === keptPlay) return kept;
  keptGame = app.game;
  keptHistory = app.history;
  keptPlay = app.play;
  const snap = snapshot(app, Date.now());
  kept = snap !== undefined && writeSavedGame(gameFile, snap);
  if (!snap) removeSavedGame(gameFile);
  return kept;
}

// --- terminal setup and teardown -------------------------------------------

let restored = false;
function restore(): void {
  if (restored) return;
  restored = true;
  stdout.write(ansi.reset + ansi.focusReportingOff + ansi.showCursor + ansi.altScreenOff);
  if (stdin.isTTY) stdin.setRawMode(false);
}

function quit(code = 0): never {
  // A kept game is only paused: run soliterminal again to carry on.
  saveIfChanged();
  const kept = saveGame(true);
  restore();
  void solver.close();
  const after = kept ? ' Your game is saved: run soliterminal to carry on.' : '';
  stdout.write(`Thanks for playing. This deal was seed ${app.game.seed}.${after}\n`);
  process.exit(code);
}

process.on('exit', restore);
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(signal, () => quit(130));
process.on('uncaughtException', (err) => {
  restore();
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});

// --- drawing -----------------------------------------------------------------

let shown: ScreenBuffer | undefined;
let autoTimer: NodeJS.Timeout | undefined;

function frame(): ScreenBuffer {
  const cols = stdout.columns;
  const rows = stdout.rows;
  if (app.showHelp) return renderHelp(cols, rows, ascii);
  if (app.showStats) return renderStats(cols, rows, app.stats, ascii);
  if (app.deals) {
    const playing = app.finishedAt === undefined && app.game.moves > 0;
    const current = { seed: app.game.seed, drawMode: app.game.drawMode, ms: playTime(app, Date.now()), moves: app.game.moves, playing };
    return renderDeals(cols, rows, app.stats.games, app.deals, current, ascii);
  }
  const needRows = minScreenHeight(app.game);
  if (cols < MIN_WIDTH || rows < needRows) {
    return renderNotice(cols, rows, ['Window too small', `Needs ${MIN_WIDTH}x${needRows}, now ${cols}x${rows}.`]);
  }
  return renderKlondike(app.game, viewOf(app, Date.now()), { ascii, compact: app.compact, width: cols, height: rows });
}

function render(): void {
  const next = frame();
  const out = diff(shown, next, theme);
  if (out) stdout.write(out);
  shown = next;
}

/** Steps auto-complete and the win ceremony while either is running. */
function scheduleAuto(): void {
  if (autoTimer || !animating(app)) return;
  autoTimer = setTimeout(() => {
    autoTimer = undefined;
    const before = app;
    app = stampDialog(before, tick(app, Date.now()), Date.now());
    saveIfChanged();
    render();
    scheduleAuto();
  }, AUTO_STEP_MS);
}

/** Asks the solver about the current position whenever it is new. */
let judgedVersion = -1;
function judgeIfNeeded(): void {
  if (app.status !== 'checking' || judgedVersion === app.version) return;
  const version = app.version;
  judgedVersion = version;
  solver.judge(app.game, (verdict, next) => {
    app = stampDialog(app, applyVerdict(app, version, verdict, next), Date.now());
    render();
    deepIfNeeded();
    lookAheadIfNeeded();
  });
}

/**
 * While the player thinks, settles every position one move away that is not
 * known yet: a quick look at each, then a long one at those it left open. A
 * move into a loss found here ends the game at once instead of seconds later.
 * Only a winnable position is worth it; a move makes it all moot.
 */
let aheadVersion = -1;
function lookAheadIfNeeded(): void {
  if (aheadVersion === app.version) return;
  solver.cancelAhead();
  if (app.status !== 'winnable' || app.dialog || animating(app)) return;
  aheadVersion = app.version;
  const ask = (child: KlondikeState, deep: boolean) =>
    // Answers only arrive while the position is unchanged: a move cancels them.
    solver.lookAhead(child, deep, (verdict, next) => {
      if (!deep && verdict === 'unclear') ask(child, true);
      app = stampDialog(app, applyAhead(app, child, verdict, next), Date.now());
      render();
    });
  // First whether any redeal is to spare, then each move.
  const spare = slackCheck(app);
  if (spare) ask(spare, false);
  for (const child of successors(app.game)) if (!app.known.has(positionKey(child))) ask(child, false);
}

/**
 * Gives the suspect position, the first one quick judging could not settle,
 * a long look on the second worker. Stops that look once it no longer matters.
 */
let deepOn: KlondikeState | undefined;
function deepIfNeeded(): void {
  const suspect = liveSuspect(app)?.game;
  if (suspect === deepOn) return;
  deepOn = suspect;
  if (!suspect) {
    solver.cancelDeep();
    return;
  }
  solver.judgeDeeply(suspect, (verdict) => {
    deepOn = undefined;
    app = stampDialog(app, applyDeepVerdict(app, suspect, verdict), Date.now());
    render();
    deepIfNeeded();
  });
}

// --- go ----------------------------------------------------------------------

// Focus reporting lets the clock stop while the player is in another window.
stdout.write(ansi.altScreenOn + ansi.hideCursor + ansi.focusReportingOn + ansi.clear);
emitKeypressEvents(stdin);
stdin.setRawMode(true);
stdin.resume();

stdin.on('keypress', (str: string | undefined, key) => {
  const name = normalizeKey(str, key);
  if (!name) return;
  app = handleKey(app, name, Date.now(), dealer);
  if (app.quit) quit();
  saveIfChanged();
  render();
  scheduleAuto();
  judgeIfNeeded();
  deepIfNeeded();
  lookAheadIfNeeded();
});

stdout.on('resize', () => {
  shown = undefined;
  render();
});

// The clock in the header only changes once a second, and diff sends just those cells.
setInterval(render, 1000).unref();
// Write the game straight away, so a tool looking at the file sees the game on screen.
saveGame(true);
render();
scheduleAuto();
rateIfNeeded();
shareIfAgreed();
judgeIfNeeded();
