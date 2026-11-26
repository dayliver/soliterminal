import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type App, CEREMONY_MS, abandon, animating, applyAhead, applyDeepVerdict, applyVerdict, createApp, handleKey, liveSuspect, playTime, redealsUsed, slackCheck, tick, viewOf } from '../src/app.ts';
import { statsFor } from '../src/stats.ts';
import { deal, draw, isWon, pile } from '../src/core/klondike.ts';
import { normalizeKey } from '../src/ui/input.ts';
import { renderDeals } from '../src/ui/help.ts';
import { MIN_WIDTH, minScreenHeight, renderKlondike, screenHeight } from '../src/ui/layout.ts';
import { board, labels } from './helpers.ts';

/** A dealer that hands out 1000, 1001, … and does not claim they are winnable. */
const seeds = () => {
  let n = 1000;
  return () => ({ seed: n++, verified: false });
};

/** Presses keys in order, one second apart. */
function press(app: App, ...keys: string[]): App {
  const next = seeds();
  let now = 10_000;
  for (const k of keys) app = handleKey(app, k, (now += 1000), next);
  return app;
}

const run = (s: ReturnType<typeof board>) => createApp(s);

describe('pile keys', () => {
  test('source key then destination key moves the cards', () => {
    const app = press(run(board({ waste: '7D', tableau: ['| 8S'] })), '1', 'q');
    assert.equal(labels(app.game.tableau[0]!.up), '8S 7D');
    assert.equal(app.held, undefined);
    assert.equal(app.history.length, 1);
  });

  test('the run that fits is worked out on drop', () => {
    const app = press(run(board({ tableau: ['| XH', '2C | KS QH JC XD 9S 8H 7C'] })), 'w', 'q');
    assert.equal(labels(app.game.tableau[0]!.up), 'XH 9S 8H 7C');
  });

  test('same key twice moves to the best spot', () => {
    const app = press(run(board({ foundations: ['AS'], tableau: ['| 2S'] })), 'q', 'q');
    assert.equal(labels(app.game.foundations[0]!), 'AS 2S');
  });

  test('a failed drop keeps the cards in hand and explains why', () => {
    const app = press(run(board({ waste: '7D', tableau: ['| 8D'] })), '1', 'q');
    assert.deepEqual(app.held?.from, pile.waste);
    assert.match(app.message, /7♦ cannot go on column 1/);
  });

  test('picking from an empty waste points at the stock key', () => {
    const app = press(run(board({ stock: '2C' })), '1');
    assert.equal(app.held, undefined);
    assert.match(app.message, /Press ` to draw/);
  });

  test('` draws and drops anything held', () => {
    const app = press(run(board({ stock: '2C 3C', tableau: ['| 8S'] })), 'q', '`');
    assert.equal(app.held, undefined);
    assert.equal(labels(app.game.waste), '3C');
  });

  test('escape puts the cards back', () => {
    const app = press(run(board({ tableau: ['| 8S'] })), 'q', 'escape');
    assert.equal(app.held, undefined);
  });
});

describe('foundation keys', () => {
  const s = () => board({ foundations: ['AC', 'AD'], tableau: ['3S | 2D'] });

  test('F5-F8 are exact and the wrong one suggests F9', () => {
    const app = press(run(s()), 'q', 'f8');
    assert.equal(app.game.foundations[3]!.length, 0);
    assert.equal(app.message, '2♦ goes on F6. Press F9 to send it there.');
    // Cards are still held, so F9 finishes the job.
    const done = press(app, 'f9');
    assert.equal(labels(done.game.foundations[1]!), 'AD 2D');
    assert.equal(labels(done.game.tableau[0]!.up), '3S');
  });

  test('F9 with nothing held sends the card under the cursor', () => {
    const app = press(run(s()), 'f9');
    assert.equal(labels(app.game.foundations[1]!), 'AD 2D');
  });

  test('an ace goes exactly where it is sent', () => {
    const app = press(run(board({ waste: 'AH' })), '1', 'f7');
    assert.equal(labels(app.game.foundations[2]!), 'AH');
  });
});

describe('cursor', () => {
  test('space picks up and puts down; how many cards is worked out on the drop', () => {
    let app = run(board({ tableau: ['| XS', '| KH QS JH XC 9H'] }));
    app = press(app, 'right', 'space', 'left', 'space'); // only 9H fits on XS
    assert.equal(labels(app.game.tableau[0]!.up), 'XS 9H');
  });

  test('left and right go round the columns and never up to the top row', () => {
    assert.deepEqual(press(run(board({})), 'left').cursor, pile.tableau(6));
    assert.deepEqual(press(run(board({})), 'left', 'right').cursor, pile.tableau(0));
  });

  test('up goes straight up: q to the stock, w and e to the waste, r to u to F5 to F8', () => {
    const up = (rights: number) => press(run(board({})), ...Array<string>(rights).fill('right'), 'up').cursor;
    assert.deepEqual(up(0), { kind: 'stock' });
    assert.deepEqual(up(1), pile.waste);
    assert.deepEqual(up(2), pile.waste); // nothing above e: the nearest
    assert.deepEqual(up(4), pile.foundation(1)); // t to F6
    assert.deepEqual(up(6), pile.foundation(3));
    // Up again does nothing.
    assert.deepEqual(press(run(board({})), 'up', 'up').cursor, { kind: 'stock' });
  });

  test('on the top row, left and right go along it without wrapping', () => {
    let app = press(run(board({})), 'up');
    assert.deepEqual(press(app, 'left').cursor, { kind: 'stock' });
    app = press(app, 'right', 'right');
    assert.deepEqual(app.cursor, pile.foundation(0));
    app = press(app, 'right', 'right', 'right', 'right');
    assert.deepEqual(app.cursor, pile.foundation(3));
  });

  test('down goes straight down, or back to the column the cursor came up from', () => {
    assert.deepEqual(press(run(board({})), 'right', 'right', 'right', 'right', 'up', 'down').cursor, pile.tableau(4));
    // From e to the waste and back: e, not w below it.
    assert.deepEqual(press(run(board({})), 'right', 'right', 'up', 'down').cursor, pile.tableau(2));
    // Moved along the top row since: straight down from where it is now.
    assert.deepEqual(press(run(board({})), 'right', 'right', 'up', 'right', 'down').cursor, pile.tableau(3));
    // Arriving on the top row some other way also counts.
    const app = press(run(board({ waste: '7D', tableau: ['| 9S', '', '| 8S'] })), 'right', 'right', '1', 'escape', 'down');
    assert.deepEqual(app.cursor, pile.tableau(2));
    // Down in a column does nothing.
    assert.deepEqual(press(run(board({})), 'down').cursor, pile.tableau(0));
  });

  test('on a foundation, space puts cards there or takes its top card back down', () => {
    let app = run(board({ foundations: ['AS'], tableau: ['| 2S', '', '', '| 3H'] }));
    app = press(app, 'space', 'right', 'right', 'right', 'up', 'space');
    assert.equal(labels(app.game.foundations[0]!), 'AS 2S');
    app = press(app, 'space', 'down', 'space');
    assert.equal(labels(app.game.tableau[3]!.up), '3H 2S');
  });

  test('space or enter on the stock draws and leaves the cursor there', () => {
    let app = press(run(board({ stock: '2C 3C' })), 'up', 'space');
    assert.equal(labels(app.game.waste), '3C');
    assert.deepEqual(app.cursor, { kind: 'stock' });
    app = press(app, 'enter');
    assert.equal(labels(app.game.waste), '3C 2C');
    assert.deepEqual(app.cursor, { kind: 'stock' });
    // The waste is next door; space there picks the card up, down drops it on the column.
    app = press(run(board({ stock: '7D', tableau: ['| 8S', '| 8C'] })), 'up', 'space', 'right', 'space', 'down', 'space');
    assert.equal(labels(app.game.tableau[1]!.up), '8C 7D');
  });

  test('down chooses cards from the top of a run, one fewer each time: K to 6, send just 7 and 6', () => {
    const s = board({ tableau: ['| KS QH JC XD 9C 8D 7S 6H', '| 8H'] });
    let app = press(run(s), 'down');
    assert.equal(app.selected, 8);
    assert.match(app.message, /K♠ and the 7 cards on it: space picks them up/);
    app = press(app, 'down', 'down', 'down', 'down', 'down', 'down');
    assert.equal(app.selected, 2);
    assert.match(app.message, /^7♠ and the card on it/);
    app = press(app, 'space');
    assert.deepEqual(app.held, { from: pile.tableau(0), count: 2 });
    app = press(app, 'right', 'space');
    assert.equal(labels(app.game.tableau[1]!.up), '8H 7S 6H');
    assert.equal(labels(app.game.tableau[0]!.up), 'KS QH JC XD 9C 8D');
    assert.equal(app.selected, undefined);
  });

  test('down stops at the last card; up walks back and, past the first, leaves the column', () => {
    const s = board({ stock: '2C', tableau: ['| 9C 8D 7S'] });
    let app = press(run(s), 'down', 'down', 'down', 'down');
    assert.equal(app.selected, 1);
    app = press(app, 'up', 'up');
    assert.equal(app.selected, 3);
    assert.deepEqual(app.cursor, pile.tableau(0));
    app = press(app, 'up');
    assert.deepEqual(app.cursor, { kind: 'stock' });
    assert.equal(app.selected, undefined);
    // A lone card has nothing to choose between.
    assert.equal(press(run(board({ tableau: ['| 9C'] })), 'down').selected, undefined);
  });

  test('moving the cursor lets the chosen cards go', () => {
    const app = press(run(board({ tableau: ['| 9C 8D 7S'] })), 'down', 'right');
    assert.equal(app.selected, undefined);
    assert.equal(press(app, 'left', 'space').held?.count, undefined);
  });

  test('an exact choice goes exactly: enter sends just those cards to their best spot', () => {
    // Whole run 9C 8D fits on XD; 8D alone fits on 9S.
    const s = board({ tableau: ['| XH 9C 8D', '| XD', '| 9S'] });
    assert.equal(labels(press(run(s), 'enter').game.tableau[1]!.up), 'XD 9C 8D');
    const app = press(run(s), 'down', 'down', 'down', 'enter');
    assert.equal(labels(app.game.tableau[2]!.up), '9S 8D');
    assert.equal(labels(app.game.tableau[0]!.up), 'XH 9C');
    // A choice that fits nowhere says so and moves nothing.
    assert.match(press(run(s), 'down', 'enter').message, /10♥ and the 2 cards on it have nowhere to go/);
  });

  test('an exact choice of one card can still go home', () => {
    const app = press(run(board({ foundations: ['AS'], tableau: ['| 3H 2S'] })), 'down', 'down', 'space', 'f9');
    assert.equal(labels(app.game.foundations[0]!), 'AS 2S');
  });

  test('the chosen card itself is highlighted, not a count', () => {
    const s = board({ tableau: ['| 9C 8D 7S', '| 9H'] });
    /** The text of every chosen cell, and whether any label shows a count. */
    const look = (app: App) => {
      const buf = renderKlondike(app.game, viewOf(app, 0));
      let chosen = '';
      for (let y = 0; y < buf.height; y++) for (let x = 0; x < buf.width; x++) if (buf.get(x, y).bg === 'chosen') chosen += buf.get(x, y).ch;
      return { chosen: chosen.replace(/\s+/g, ''), count: /×\d/.test(buf.toText()) };
    };
    assert.deepEqual(look(run(s)), { chosen: '', count: false });
    assert.deepEqual(look(press(run(s), 'down')), { chosen: '９♣️', count: false }); // the top of the run
    assert.deepEqual(look(press(run(s), 'down', 'down')), { chosen: '８♦️', count: false });
    // In hand, the first card held stays marked; the cursor going elsewhere does not move it.
    assert.deepEqual(look(press(run(s), 'down', 'down', 'space', 'right')), { chosen: '８♦️', count: false });
    // Cards taken without choosing are not marked.
    assert.deepEqual(look(press(run(s), 'space')), { chosen: '', count: false });
  });

  test('cards cannot go on the stock', () => {
    const app = press(run(board({ tableau: ['| 9S'], stock: '2C' })), 'space', 'up', 'space');
    assert.match(app.message, /cannot go on the stock/);
    assert.deepEqual(app.held?.from, pile.tableau(0));
  });

  test('enter auto-moves the cursor pile', () => {
    const app = press(run(board({ tableau: ['| AS'] })), 'enter');
    assert.equal(labels(app.game.foundations[0]!), 'AS');
  });
});

describe('game controls', () => {
  test('undo walks back one move at a time', () => {
    let app = press(run(board({ waste: '7D', stock: '2C', tableau: ['| 8S'] })), '1', 'q', '`');
    assert.equal(app.history.length, 2);
    app = press(app, 'z');
    assert.equal(labels(app.game.tableau[0]!.up), '8S 7D');
    app = press(app, 'backspace');
    assert.equal(labels(app.game.waste), '7D');
    assert.equal(press(app, 'z').message, 'Nothing to undo.');
  });

  test('n asks in a dialog once a game is under way', () => {
    assert.equal(press(createApp(deal(1)), 'n').game.seed, 1000); // untouched: no question
    let app = press(createApp(deal(1)), 'w', 'w');
    app = press(app, 'n');
    assert.equal(app.dialog, 'new');
    assert.equal(app.game.seed, 1);
    assert.equal(press(app, 'y').game.seed, 1000);
    assert.equal(press(app, 'n').game.seed, 1000);
    // Keys the dialog does not offer are ignored; esc closes it.
    assert.equal(press(app, 'q'), app);
    const kept = press(app, 'escape');
    assert.equal(kept.dialog, undefined);
    assert.equal(kept.game.seed, 1);
  });

  test('the cursor follows cards to the column they land on', () => {
    const s = board({ tableau: ['| 9C', '', '', '2S 3S | 9H', '', 'KD | 8S'] });
    // 8♠ from y onto 9♥ on r, with the same key twice.
    let app = press(run(s), 'y', 'y');
    assert.deepEqual(app.cursor, pile.tableau(3));
    assert.equal(labels(app.game.tableau[3]!.up), '9H 8S');
    // K♦ turned face up on y is not a landing: the cursor went with the 8♠.
    assert.equal(labels(app.game.tableau[5]!.up), 'KD');
    // Enter on y (the cursor starts on q; five steps right) does the same.
    app = press(run(s), 'right', 'right', 'right', 'right', 'right', 'enter');
    assert.deepEqual(app.cursor, pile.tableau(3));
    // From the waste: 7♦ onto 8♠ lands on y, and the cursor goes there too.
    app = press(run(board({ waste: '7D', tableau: ['', '', '', '', '', '| 8S'] })), '1', 'y');
    assert.deepEqual(app.cursor, pile.tableau(5));
    // To a foundation: the cursor stays put.
    app = press(run(board({ tableau: ['| AS', '| 5D'] })), 'q', 'f9');
    assert.equal(app.game.foundations[0]!.length, 1);
    assert.deepEqual(app.cursor, pile.tableau(0)); // where the ace was picked up
  });

  test('~ draws just like `', () => {
    assert.deepEqual(press(createApp(deal(1)), '~').game, press(createApp(deal(1)), '`').game);
    assert.equal(press(createApp(deal(1)), '~').game.waste.length, 1);
  });

  test('drawing moves the cursor to the waste; recycling does not', () => {
    let app = press(createApp(deal(1)), 'right', 'right');
    assert.deepEqual(app.cursor, pile.tableau(2));
    app = press(app, '`');
    assert.deepEqual(app.cursor, pile.waste);
    // Then space picks the new card up.
    assert.deepEqual(press(app, 'space').held?.from, pile.waste);
    // Recycling empties the waste: the cursor stays where it was.
    const empty = { ...app, game: { ...app.game, stock: [], waste: app.game.waste }, cursor: pile.tableau(4) };
    const recycled = press(empty, '`');
    assert.equal(recycled.game.waste.length, 0);
    assert.deepEqual(recycled.cursor, pile.tableau(4));
  });

  test('esc puts held cards back first, otherwise switches card size, kept across deals', () => {
    let app = press(createApp(deal(1)), 'q');
    assert.ok(app.held);
    app = press(app, 'escape');
    assert.equal(app.held, undefined);
    assert.equal(app.compact, false);
    app = press(app, 'escape');
    assert.equal(app.compact, true);
    assert.match(app.message, /Compact/);
    assert.equal(press(app, 'n').compact, true); // untouched deal, so n deals at once
    assert.equal(press(app, 'escape').compact, false);
    assert.equal(createApp(deal(1), { compact: true }).compact, true);
  });

  test('d switches draw mode now on an untouched deal, else next game', () => {
    assert.equal(press(createApp(deal(1)), 'd').game.drawMode, 3);
    const busy = press(createApp(deal(1)), '`', 'd');
    assert.equal(busy.game.drawMode, 1);
    assert.equal(press(busy, 'n', 'n').game.drawMode, 3);
  });

  test('help opens with ? and any key closes it without acting', () => {
    let app = press(run(board({ stock: '2C' })), '?');
    assert.equal(app.showHelp, true);
    app = press(app, '`');
    assert.equal(app.showHelp, false);
    assert.equal(app.game.stock.length, 1);
  });

  test('ctrl+c quits', () => {
    assert.equal(press(run(board({})), 'ctrl+c').quit, true);
  });

  test('the clock starts on the first move', () => {
    let app = run(board({ waste: 'AS' }));
    assert.equal(viewOf(app, 99_000).elapsedMs, 0);
    app = handleKey(app, '1', 50_000, seeds());
    app = handleKey(app, 'f9', 50_000, seeds());
    assert.equal(app.game.foundations[0]!.length, 1);
    assert.equal(viewOf(app, 53_000).elapsedMs, 3000);
  });
});

describe('finishing', () => {
  // Everything is face up and the stock is gone, so the next move triggers auto-complete.
  const endgame = () =>
    run(board({
      foundations: [
        'AS 2S 3S 4S 5S 6S 7S 8S 9S XS JS',
        'AH 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH',
        'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD',
        'AC 2C 3C 4C 5C 6C 7C 8C 9C XC JC',
      ],
      tableau: ['| KS', '| KC QS', '| KH QC'],
    }));

  test('auto-complete plays out step by step, then the game is won and the clock stops', () => {
    let app = press(endgame(), 'w', 'f9');
    assert.ok(app.autoQueue.length > 0);
    assert.match(app.message, /Finishing/);
    let now = 100_000;
    while (app.autoQueue.length > 0) app = tick(app, (now += 60));
    assert.equal(isWon(app.game), true);
    assert.match(app.message, /You won!/);
    assert.equal(viewOf(app, now + 60_000).elapsedMs, viewOf(app, now).elapsedMs);
  });

  /** Plays the endgame out and returns the app just after the winning step. */
  const win = () => {
    let app = press(endgame(), 'w', 'f9');
    let now = 100_000;
    while (app.autoQueue.length > 0) app = tick(app, (now += 60));
    return app;
  };

  test('a win starts the ceremony, then shows the results', () => {
    const app = win();
    assert.equal(app.celebrating, true);
    assert.equal(animating(app), true);
    assert.ok(viewOf(app, app.finishedAt! + 500).celebration === 500);
    assert.equal(tick(app, app.finishedAt! + 100).dialog, undefined); // still raining
    const done = tick(app, app.finishedAt! + CEREMONY_MS);
    assert.equal(done.celebrating, false);
    assert.equal(done.dialog, 'won');
    // The confetti keeps falling behind the results, and stops once they are put away.
    assert.equal(animating(done), true);
    assert.equal(viewOf(done, done.finishedAt! + 30_000).celebration, 30_000);
    const closed = press(done, 'escape');
    assert.equal(animating(closed), false);
    assert.equal(viewOf(closed, 0).celebration, undefined);
    const d = viewOf(done, 0).dialog!;
    assert.equal(d.title, 'You won!');
    assert.match(d.lines.join(' '), /moves in \d\d:\d\d, no redeals\. Draw 1: won 1 of 1 \(100%\)\. Streak 1, longest 1\./);
    assert.deepEqual(d.choices.map(([k]) => k), ['n', 'g', 's', 'x', 'esc']);
    assert.equal(app.stats.games[0]!.redeals, 0);
  });

  test('any key cuts the ceremony short; the results dialog then takes n, g, s, esc', () => {
    const results = press(win(), 'q');
    assert.equal(results.dialog, 'won');
    assert.equal(results.celebrating, false);
    assert.equal(press(results, 'n').game.seed, 1000);
    assert.equal(press(results, 'f2').dialog, 'won'); // a deal won is not played again
    assert.ok(press(results, 'g').deals);
    assert.equal(press(results, 's').showStats, true);
    assert.equal(press(results, 'escape').dialog, undefined);
  });

  test('a win counts once, even after undo and winning again', () => {
    const app = win();
    assert.deepEqual([statsFor(app.stats, 1).played, statsFor(app.stats, 1).won], [1, 1]);
    let redo = press(press(app, 'q', 'escape'), 'z');
    assert.equal(isWon(redo.game), false);
    // Send the last card home again: a column key twice moves it to the best spot.
    for (const k of ['q', 'w', 'e']) if (!isWon(redo.game)) redo = press(redo, k, k);
    let now = 200_000;
    while (redo.autoQueue.length > 0) redo = tick(redo, (now += 60));
    assert.equal(isWon(redo.game), true);
    assert.deepEqual([statsFor(redo.stats, 1).played, statsFor(redo.stats, 1).won], [1, 1]);
  });

  test('a key during auto-complete skips to the end', () => {
    const app = press(endgame(), 'w', 'f9', 'left');
    assert.equal(isWon(app.game), true);
  });

  test('a face-down card holds auto-complete back', () => {
    const app = press(run(board({ foundations: ['AS'], tableau: ['3D | 2S'] })), 'q', 'f9');
    assert.equal(app.autoQueue.length, 0);
  });
});

describe('normalizeKey', () => {
  test('maps Node keypress events to short names', () => {
    assert.equal(normalizeKey('`', { sequence: '`' }), '`');
    assert.equal(normalizeKey('?', { sequence: '?' }), '?');
    assert.equal(normalizeKey('1', { name: '1' }), '1');
    assert.equal(normalizeKey('Q', { name: 'q', shift: true }), 'q');
    assert.equal(normalizeKey(undefined, { name: 'f9', sequence: '\x1b[20~' }), 'f9');
    assert.equal(normalizeKey('\r', { name: 'return' }), 'enter');
    assert.equal(normalizeKey(' ', { name: 'space' }), 'space');
    assert.equal(normalizeKey('\x03', { name: 'c', ctrl: true }), 'ctrl+c');
    assert.equal(normalizeKey('\x1a', { name: 'z', ctrl: true }), undefined);
    assert.equal(normalizeKey('한', undefined), undefined);
  });
});

describe('fitting the terminal', () => {
  test('status bar sits on the last rows of a taller terminal', () => {
    const buf = renderKlondike(deal(1), { cursor: pile.tableau(0) }, { height: 30 });
    assert.equal(buf.height, 30);
    assert.match(buf.toText().split('\n')[29]!, /help/);
  });

  test('face-down stacks fold when the board is too tall', () => {
    const s = board({ tableau: ['2C 3C 4C 5C 6C 7C | KH QS JH XC 9H 8C 7H 6S'] });
    assert.equal(screenHeight(s), 6 + 6 + 8 + 5);
    const buf = renderKlondike(s, { cursor: pile.tableau(0) }, { height: 24, width: MIN_WIDTH });
    assert.equal(buf.height, 24);
    assert.equal(minScreenHeight(s), 6 + 1 + 8 + 5);
    // The six hidden cards become one grey row that says how many there are.
    const row = (y: number) => Array.from({ length: 6 }, (_, i) => buf.get(1 + i, y).ch).join('');
    assert.equal(row(6), '  ６  '); // one digit, so fullwidth
    assert.equal(buf.get(1, 6).bg, 'back');
    assert.equal(row(7), ' Ｋ♥\uFE0F ');
  });
});

describe('live winnability', () => {
  const position = () => board({ stock: '2C 3C', waste: '7D', tableau: ['| 8S', '| KH'] });

  test('a verified deal starts out winnable; any other starts out checking', () => {
    assert.equal(createApp(deal(1), { verified: true }).status, 'winnable');
    assert.equal(createApp(deal(1)).status, 'checking');
  });

  test('every move asks again, and late answers for older positions are ignored', () => {
    let app = createApp(position(), { verified: true });
    app = press(app, '1', 'q');
    assert.equal(app.status, 'checking');
    const v = app.version;
    app = press(app, '`');
    assert.equal(applyVerdict(app, v, 'lost'), app); // stale
    app = applyVerdict(app, app.version, 'winnable');
    assert.equal(app.status, 'winnable');
    assert.equal(viewOf(app, 0).status, 'winnable');
  });

  test('a proven loss shows 0% in a dialog that offers a retry', () => {
    let app = press(createApp(position(), { verified: true }), '1', 'q');
    app = applyVerdict(app, app.version, 'lost');
    assert.equal(app.status, 'lost');
    assert.equal(app.dialog, 'lost');
    const dialog = viewOf(app, 0).dialog!;
    assert.equal(dialog.danger, true);
    assert.match(dialog.lines.join(' '), /0%.*Try again\?/);
    assert.deepEqual(dialog.choices.map(([k]) => k), ['z', 'F2', 'n', 'x', 'esc']);
    // Other keys do nothing while the question is up.
    assert.equal(press(app, 'w'), app);
  });

  test('giving up a lost game records the move that lost it; giving up a live one does not', () => {
    let app = press(createApp(position(), { verified: true }), '1', 'q', 'w', 'w'); // counted from the first card moved
    app = applyVerdict(app, app.version, 'lost');
    const lost = abandon(app, 50_000).stats.games[0]!;
    assert.equal(lost.result, 'lost');
    assert.equal(lost.lostAt, 1); // the deal was winnable, the first move lost it
    const live = press(createApp(position(), { verified: true }), '1', 'q');
    assert.equal(abandon(live, 50_000).stats.games[0]!.lostAt, undefined);
    assert.equal(abandon(live, 50_000).stats.games[0]!.limit, null); // the hand-built board has no redeal limit
  });

  test('x asks before quitting, from the board and from the loss dialog', () => {
    const app = press(createApp(position(), { verified: true }), '1');
    const asked = press(app, 'x');
    assert.equal(asked.dialog, 'quit');
    assert.equal(asked.held, undefined);
    assert.match(viewOf(asked, 0).dialog!.lines[0]!, /kept/);
    assert.equal(press(asked, 'w').quit, false); // other keys do nothing
    assert.equal(press(asked, 'y').quit, true);
    const stay = press(asked, 'escape');
    assert.deepEqual([stay.dialog, stay.quit], [undefined, false]);
    // From game over, esc goes back to the game-over choices.
    let lost = press(createApp(position(), { verified: true }), '1', 'q');
    lost = applyVerdict(lost, lost.version, 'lost');
    const fromLost = press(lost, 'x');
    assert.equal(fromLost.dialog, 'quit');
    assert.equal(press(fromLost, 'escape').dialog, 'lost');
    assert.equal(press(fromLost, 'enter').quit, true);
  });

  test('z goes back to the last position proven winnable, even several moves ago', () => {
    let app = createApp(position(), { verified: true });
    app = press(app, '1', 'q'); // 7D onto 8S, never judged
    app = press(app, '`'); // draw 3C
    app = applyVerdict(app, app.version, 'lost');
    app = press(app, 'z');
    assert.equal(app.dialog, undefined);
    assert.equal(app.status, 'winnable');
    assert.equal(labels(app.game.waste), '7D');
    assert.equal(app.history.length, 0);
  });

  test('after a loss F2 restarts at once and n deals a new one', () => {
    let app = press(createApp(deal(5), { verified: true }), '`', '`');
    app = applyVerdict(app, app.version, 'lost');
    const restarted = press(app, 'f2');
    assert.deepEqual(restarted.game, deal(5));
    assert.equal(restarted.status, 'winnable');
    assert.equal(restarted.dialog, undefined);
    assert.equal(press(app, 'n').game.seed, 1000);
  });

  test('esc plays on without asking again until it is winnable once more', () => {
    let app = press(createApp(position(), { verified: true }), '1', 'q');
    app = press(applyVerdict(app, app.version, 'lost'), 'escape');
    assert.equal(app.dialog, undefined);
    app = press(app, '`');
    app = applyVerdict(app, app.version, 'lost');
    assert.equal(app.dialog, undefined);
    assert.equal(app.status, 'lost');
  });

  test('F2 asks before restarting; y, enter or F2 again confirms, esc cancels', () => {
    let app = press(createApp(deal(5)), '`');
    app = press(app, 'f2');
    assert.equal(app.dialog, 'restart');
    assert.equal(viewOf(app, 0).dialog?.title, 'Restart this deal?');
    for (const yes of ['y', 'enter', 'f2']) assert.equal(press(app, yes).game.moves, 0, yes);
    assert.equal(press(app, 'escape').game.moves, 1);
    assert.match(press(createApp(deal(5)), 'f2').message, /already at the start/);
  });

  test('a won game is not started over', () => {
    const app = { ...press(createApp(deal(5)), '`'), finishedAt: 1, play: 'won' as const };
    const after = press(app, 'f2');
    assert.equal(after.game, app.game);
    assert.match(after.message, /This deal is won/);
  });

  test('redeals used count the turns of the waste along the way', () => {
    let s = deal(5, 1, 3);
    const states = [s];
    for (let i = 0; i < 25 * 2; i++) { // 24 draws and a redeal, twice
      const r = draw(s);
      if (r.ok) states.push((s = r.state));
    }
    assert.equal(redealsUsed(states), 2);
  });

  test('no command key collides with a pile key', async () => {
    const { pileForKey } = await import('../src/ui/keymap.ts');
    // (y is column 6; it only means "yes" while a dialog has the keyboard.)
    for (const k of ['z', 'n', 'f2', 'd', 'h', 's', 'g', 'x', '?', 'space', 'enter', 'escape', 'backspace', 'left', 'right', 'up', 'down']) {
      assert.equal(pileForKey(k), undefined, k);
    }
  });

  test('the header shows the verdict', () => {
    const s = deal(1);
    const header = (status: 'winnable' | 'lost' | 'checking' | 'unclear') =>
      renderKlondike(s, { cursor: pile.tableau(0), status }).toText().split('\n')[0]!;
    assert.match(header('winnable'), /Win ✓$/);
    assert.match(header('checking'), /Win …$/);
    assert.match(header('unclear'), /Win \?$/);
    assert.match(header('lost'), /Win 0%$/);
  });
});

describe('statistics and redeals', () => {
  test('a game counts as played from the first card moved; drawing alone does not count', () => {
    const app = createApp(deal(1));
    assert.equal(statsFor(app.stats, 1).played, 0);
    assert.equal(statsFor(press(app, 'left').stats, 1).played, 0);
    const looked = press(app, '`', '`', '`');
    assert.equal(statsFor(looked.stats, 1).played, 0);
    assert.equal(looked.play, 'fresh');
    // So a new deal needs no asking, and leaving it costs nothing.
    assert.equal(press(looked, 'n').dialog, undefined);
    assert.equal(statsFor(abandon(looked).stats, 1).played, 0);
    // Double-tapping w plays a card at the start of deal 1.
    assert.equal(statsFor(press(app, 'w', 'w').stats, 1).played, 1);
    assert.equal(statsFor(press(app, '`', 'w', 'w', '`').stats, 1).played, 1);
  });

  test('restarting carries on the same game; a new deal or quitting ends the streak', () => {
    const streaky = { ...createApp(deal(1)), stats: { games: [3, 2, 1].map((seed) => ({ seed, drawMode: 1 as const, result: 'won' as const, ms: 1, moves: 1, at: seed, redeals: 0 })) } };
    const busy = press(streaky, 'w', 'w');
    const restarted = press(busy, 'f2', 'y', 'w', 'w');
    assert.equal(statsFor(restarted.stats, 1).played, 4);
    assert.equal(statsFor(restarted.stats, 1).streak, 3);
    const gaveUp = press(busy, 'n', 'y');
    assert.equal(statsFor(gaveUp.stats, 1).streak, 0);
    assert.equal(statsFor(abandon(busy).stats, 1).streak, 0);
    assert.equal(statsFor(abandon(streaky).stats, 1).streak, 3); // nothing played yet
  });

  test('s opens the statistics and any key closes them', () => {
    const app = press(createApp(deal(1)), 's');
    assert.equal(app.showStats, true);
    const back = press(app, 'q');
    assert.equal(back.showStats, false);
    assert.equal(back.held, undefined); // the key only closed the screen
  });

  test('new deals use the redeal setting, and running out is announced', () => {
    const app = createApp(deal(1, 1, 2));
    assert.equal(app.redeals, 2);
    assert.equal(press(app, '`', 'n', 'y').game.redealsLeft, 2);
    let s = press(createApp(board({ stock: '2C', waste: '3D', redealsLeft: 1 })), '`');
    assert.match(s.message, /stock is out. 1 redeal left/);
    s = press(s, '`', '`', '`'); // redeal, then turn both cards again
    assert.equal(s.game.redealsLeft, 0);
    assert.match(s.message, /No redeals left/);
    assert.match(press(s, '`').message, /No redeals left/);
  });
});

describe('pausing while the terminal is out of focus', () => {
  const key = (app: App, k: string, now: number) => handleKey(app, k, now, () => ({ seed: 1, verified: false }));

  test('focus reports become keys of their own', () => {
    assert.equal(normalizeKey(undefined, { sequence: '\x1b[I', name: 'undefined', code: '[I' }), 'focus-in');
    assert.equal(normalizeKey(undefined, { sequence: '\x1b[O', name: 'undefined', code: '[O' }), 'focus-out');
  });

  test('the clock stops while away and the time away is left out', () => {
    let app = key(createApp(deal(1)), '`', 10_000); // first move starts the clock
    app = key(app, 'focus-out', 25_000);
    assert.equal(viewOf(app, 25_000).paused, true);
    assert.equal(playTime(app, 25_000), 15_000);
    assert.equal(playTime(app, 600_000), 15_000); // still stopped, long after
    app = key(app, 'focus-in', 600_000);
    assert.equal(viewOf(app, 600_000).paused, false);
    assert.equal(playTime(app, 605_000), 20_000);
  });

  test('focus keys change nothing else: no dialog closes, no ceremony ends', () => {
    const asking = key(key(key(createApp(deal(1)), 'w', 500), 'w', 1_000), 'n', 2_000);
    assert.equal(asking.dialog, 'new');
    assert.equal(key(key(asking, 'focus-out', 3_000), 'focus-in', 4_000).dialog, 'new');
  });

  test('a key press counts as being back, if the terminal never said so', () => {
    let app = key(createApp(deal(1)), '`', 10_000);
    app = key(app, 'focus-out', 20_000);
    app = key(app, 'right', 50_000); // no focus-in arrived
    assert.equal(app.pausedAt, undefined);
    assert.equal(playTime(app, 50_000), 10_000);
  });

  test('time away before the first move does not count against the game', () => {
    let app = key(createApp(deal(1)), 'focus-out', 1_000);
    app = key(app, 'focus-in', 90_000);
    app = key(app, '`', 100_000);
    assert.equal(playTime(app, 103_000), 3_000);
  });

  test('a win records the time without the time away', () => {
    const almost = board({
      foundations: [
        'AS 2S 3S 4S 5S 6S 7S 8S 9S XS JS',
        'AH 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH KH',
        'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD',
        'AC 2C 3C 4C 5C 6C 7C 8C 9C XC JC QC KC',
      ],
      tableau: ['| KS', '| QS'],
    });
    let app = key(createApp(almost), 'w', 1_000);
    app = key(app, 'w', 1_500); // Q♠ home: the clock starts, and K♠ is queued to finish
    assert.equal(app.startedAt, 1_500);
    app = key(app, 'focus-out', 5_000);
    app = key(app, 'focus-in', 65_000);
    app = tick(app, 66_000); // K♠ home
    assert.equal(isWon(app.game), true);
    assert.equal(app.lastWin?.ms, 4_500); // 64.5 s on the wall clock, 60 s of it away
  });

  test('the message line says the clock is waiting', () => {
    const text = renderKlondike(deal(1), { cursor: pile.tableau(0), paused: true, message: 'hello' }).toText();
    assert.match(text, /Paused\. The clock waits until you come back\./);
    assert.doesNotMatch(text, /hello/);
  });
});

describe('positions the quick check cannot settle', () => {
  /** A verified deal, then three draws; the first two judged winnable, the third unclear. */
  const setup = () => {
    let app = createApp(deal(5), { verified: true });
    app = press(app, '`');
    app = applyVerdict(app, app.version, 'winnable');
    app = press(app, '`');
    app = applyVerdict(app, app.version, 'unclear');
    return app;
  };

  test('the first unclear position after a winnable one is suspected, with a warning', () => {
    const app = setup();
    assert.equal(app.status, 'unclear');
    assert.equal(liveSuspect(app)?.game, app.game);
    assert.match(app.message, /not confirmed yet/);
    // Later unclear positions keep the first one as the suspect, and do not warn again.
    let later = press(app, '`');
    later = applyVerdict(later, later.version, 'unclear');
    assert.equal(liveSuspect(later)?.game, app.game);
    assert.equal(later.message, '');
  });

  test('a loss proven there is a loss now, several moves on', () => {
    const app = setup();
    let later = press(app, '`', '`');
    later = applyDeepVerdict(later, app.game, 'lost');
    assert.equal(later.status, 'lost');
    assert.equal(later.dialog, 'lost');
    const d = viewOf(later, 0).dialog!;
    assert.match(d.lines.join(' '), /lost within the last 3 moves\. z goes back to just before them/);
    // z goes back to the last winnable position, before the suspect.
    const back = press(later, 'z');
    assert.equal(back.history.length, 1);
    assert.equal(back.status, 'winnable');
  });

  test('a win proven there moves the point to go back to forward', () => {
    const app = setup();
    const later = applyDeepVerdict(press(app, '`'), app.game, 'winnable');
    assert.equal(later.lastWinnable?.game, app.game);
    assert.equal(later.suspect, undefined);
  });

  test('undoing past the suspect, or a winnable verdict, drops it', () => {
    const app = setup();
    const undone = press(app, 'z');
    assert.equal(liveSuspect(undone), undefined);
    assert.equal(applyDeepVerdict(undone, app.game, 'lost').status, undone.status); // too late to matter
    let later = press(app, '`');
    later = applyVerdict(later, later.version, 'winnable');
    assert.equal(later.suspect, undefined);
  });
});


describe('hints after going round the stock', () => {
  // 7D fits on 8S, but the player only draws.
  const position = () => board({ stock: '2C 3C 7D', tableau: ['| 8S', '| KH'] });
  const hint = { from: { kind: 'talon' }, to: { kind: 'tableau', index: 0 }, card: { suit: 'D', rank: 7 }, count: 1 } as const;
  /** Presses keys, answering each new position as winnable with `hint` as the way on. */
  const play = (app: App, ...keys: string[]) => {
    for (const k of keys) {
      app = press(app, k);
      app = applyVerdict(app, app.version, 'winnable', hint);
    }
    return app;
  };

  test('h gives nothing before the whole stock has gone by', () => {
    const app = play(createApp(position()), '`', '`');
    assert.equal(app.stalled, false);
    const after = press(app, 'h');
    assert.equal(after.showHelp, false);
    assert.match(after.message, /Hints open up/);
  });

  test('turning the waste over with nothing played opens the hint', () => {
    let app = play(createApp(position()), '`', '`', '`');
    assert.equal(app.stalled, false);
    app = play(app, '`'); // redeal: every card has been on top
    assert.equal(app.stalled, true);
    assert.match(app.message, /can still be won.*h shows it/);
    app = press(app, 'h');
    assert.match(app.message, /Hint: draw until 7♦ is on the waste, then play it to column 1 \(q\)/);
    assert.deepEqual(app.cursor, pile.waste);
  });

  test('with the card on top, the hint names the keys', () => {
    let app = play(createApp(position()), '`', '`', '`', '`', '`');
    assert.equal(labels(app.game.waste), '7D');
    app = press(app, 'h');
    assert.match(app.message, /Hint: 7♦ from the waste \(1\) to column 1 \(q\)/);
  });

  test('a stall counts from where the waste stood at the last real move', () => {
    // Waste has two cards at the start: the stall needs them both seen again.
    let app = play(createApp(board({ stock: '4C', waste: '2C 3C', tableau: ['| 8S'] })), '`', '`');
    assert.equal(app.stalled, false); // redealt, but the waste is back to 0 of 2
    app = play(app, '`');
    assert.equal(app.stalled, false);
    app = play(app, '`');
    assert.equal(app.stalled, true);
  });

  test('any real move closes the hint again', () => {
    let app = play(createApp(position()), '`', '`', '`', '`', '`');
    assert.equal(app.stalled, true);
    app = play(app, '1', 'q');
    assert.equal(labels(app.game.tableau[0]!.up), '8S 7D');
    assert.equal(app.stalled, false);
    assert.match(press(app, 'h').message, /Hints open up/);
  });

  test('running out of stock with no redeals left also counts', () => {
    let app = play(createApp(board({ stock: '2C 3C', tableau: ['| 8S'], redealsLeft: 0 })), '`', '`');
    assert.equal(app.stalled, false);
    app = play(app, '`'); // cannot turn the waste over
    assert.equal(app.stalled, true);
    assert.match(app.message, /h shows it/);
  });

  test('with no talon at all, pressing the stock key counts at once', () => {
    let app = play(createApp(board({ tableau: ['| 8S', '| 7D'] })), 'w', 'q');
    assert.equal(app.stalled, false);
    app = play(app, '`');
    assert.equal(app.stalled, true);
  });

  test('no hint while the position is unproven', () => {
    let app = play(createApp(position()), '`', '`', '`');
    app = press(app, '`');
    assert.equal(app.stalled, true);
    assert.match(press(app, 'h').message, /Still checking/);
    app = applyVerdict(app, app.version, 'unclear');
    assert.match(press(app, 'h').message, /not confirmed/);
  });

  test('a run in a column: the hint says how many cards', () => {
    const run = { from: { kind: 'tableau', index: 1 }, to: { kind: 'tableau', index: 0 }, card: { suit: 'D', rank: 7 }, count: 2 } as const;
    let app = createApp(board({ stock: '2C', tableau: ['| 8S', '| 7D 6C'] }));
    app = press(app, '`', '`');
    app = applyVerdict(app, app.version, 'winnable', run);
    assert.equal(app.stalled, true);
    app = press(app, 'h');
    assert.match(app.message, /Hint: 7♦ and the card on it from column 2 \(w\) to column 1 \(q\)/);
    assert.deepEqual(app.cursor, pile.tableau(1));
  });

  test('a hint for part of a run chooses just those cards', () => {
    const part = { from: { kind: 'tableau', index: 1 }, to: { kind: 'tableau', index: 0 }, card: { suit: 'D', rank: 7 }, count: 2 } as const;
    let app = createApp(board({ stock: '2C', tableau: ['| 8S', '| 8C 7D 6C'] }));
    app = press(app, '`', '`');
    app = applyVerdict(app, app.version, 'winnable', part);
    app = press(app, 'h');
    assert.equal(app.selected, 2);
    app = press(app, 'space', 'q');
    assert.equal(labels(app.game.tableau[0]!.up), '8S 7D 6C');
  });
});

describe('known positions and looking ahead', () => {
  // 7D can go on 8S (q) or 8C (w). Say q is proven lost and w winnable.
  const position = () => board({ stock: '2C', waste: '7D', tableau: ['| 8S', '| 8C'] });
  const after = (app: App, keys: string[]) => press(app, ...keys).game;
  const start = () => createApp(position(), { verified: true });
  const onQ = after(start(), ['1', 'q']);
  const onW = after(start(), ['1', 'w']);

  test('a move into a position found lost a move ahead loses at once, and z takes back just that move', () => {
    let app = applyAhead(start(), onQ, 'lost');
    app = press(app, '1', 'q');
    assert.equal(app.status, 'lost');
    assert.equal(app.dialog, 'lost');
    assert.deepEqual(viewOf(app, 0).dialog!.lines, ['Win chance is now 0%. Try again?']);
    app = press(app, 'z');
    assert.equal(app.history.length, 0);
    assert.equal(labels(app.game.waste), '7D');
    assert.equal(app.status, 'winnable');
  });

  test('a known winnable position is settled without asking the solver', () => {
    const app = press(applyAhead(start(), onW, 'winnable'), '1', 'w');
    assert.equal(app.status, 'winnable');
    assert.equal(app.lastWinnable?.game, app.game);
  });

  test('picking up cards with a known losing place to go warns, without saying which', () => {
    const app = press(applyAhead(start(), onQ, 'lost'), '1');
    assert.match(app.message, /Holding 7♦\. Careful: one of its two places loses the game\./);
    // With nowhere safe, it says so.
    const doomed = press(applyAhead(applyAhead(start(), onQ, 'lost'), onW, 'lost'), '1');
    assert.match(doomed.message, /wherever it goes, the game is lost/);
  });

  test('the warning stands out: a red line with a warning sign, and the sign in the header', () => {
    const app = press(applyAhead(start(), onQ, 'lost'), '1');
    const view = viewOf(app, 0);
    assert.deepEqual(view.danger, { message: true });
    const text = renderKlondike(app.game, view).toText();
    assert.match(text.split('\n')[0]!, /Win ⚠$/);
    assert.match(text, /⚠ Holding 7♦\. Careful/);
    // Nothing in hand, or nothing known to lose: the tick and the usual prompt.
    assert.equal(viewOf(press(app, 'escape'), 0).danger, undefined);
    const calm = viewOf(press(start(), '1'), 0);
    assert.equal(calm.danger, undefined);
    assert.match(renderKlondike(start().game, calm).toText().split('\n')[0]!, /Win ✓$/);
  });

  test('a win that needs every redeal left is marked: no redeal to spare', () => {
    const app = createApp(deal(1), { verified: true });
    const less = slackCheck(app)!;
    assert.equal(less.redealsLeft, app.game.redealsLeft - 1);
    assert.equal(viewOf(app, 0).tight, undefined); // not known yet
    const tight = applyAhead(app, less, 'lost');
    assert.equal(viewOf(tight, 0).tight, true);
    assert.equal(slackCheck(tight), undefined); // asked once
    assert.match(renderKlondike(tight.game, viewOf(tight, 0)).toText().split('\n')[0]!, /Win ✓!$/);
    // A redeal to spare: the plain tick. Without redeals left, or without a limit, nothing to ask.
    assert.equal(viewOf(applyAhead(app, less, 'winnable'), 0).tight, undefined);
    assert.equal(slackCheck(createApp(deal(1, 1, 0), { verified: true })), undefined);
    assert.equal(slackCheck(createApp(deal(1, 1, Infinity), { verified: true })), undefined);
    // Holding cards with a losing place to go outranks it.
    assert.equal(viewOf({ ...tight, status: 'checking' }, 0).tight, undefined);
  });

  test('a loss found while the cards are in hand warns straight away', () => {
    let app = press(start(), '1');
    assert.match(app.message, /Where does it go\?/);
    app = applyAhead(app, onQ, 'lost');
    assert.match(app.message, /Careful/);
    // A winnable answer changes nothing on screen.
    assert.equal(applyAhead(press(start(), '1'), onW, 'winnable').message, press(start(), '1').message);
  });

  test('a loss found late is remembered: making the same move again loses at once', () => {
    let app = press(start(), '1', 'q');
    app = applyVerdict(app, app.version, 'unclear');
    app = press(app, '`'); // played on before the long look came back
    const suspect = liveSuspect(app)!.game;
    app = applyDeepVerdict(app, suspect, 'lost');
    assert.equal(app.dialog, 'lost');
    app = press(app, 'z'); // back to before 7♦ went on q
    assert.equal(app.history.length, 0);
    app = press(app, '1');
    assert.match(app.message, /Careful/);
    app = press(app, 'q');
    assert.equal(app.dialog, 'lost');
  });

  test('restarting the deal keeps what is known; a new deal forgets it', () => {
    // A real deal, so a restart deals the same cards again.
    const fresh = createApp(deal(5), { verified: true });
    const drawn = press(fresh, '`').game;
    let app = applyAhead(press(fresh, '`', '`'), drawn, 'lost');
    app = press(app, 'escape', 'f2', 'y', '`');
    assert.equal(app.dialog, 'lost');
    assert.equal(press(app, 'n').known.size, 0);
  });

  test('an answer for the position the player has just moved to settles it', () => {
    let app = press(start(), '1', 'q');
    assert.equal(app.status, 'checking');
    app = applyAhead(app, onQ, 'lost');
    assert.equal(app.dialog, 'lost');
  });
});

describe('the deals screen', () => {
  const open = (app: App) => press(app, 'g');
  const played = () => press(createApp(deal(1), { verified: true }), 'w', 'w'); // deal 1 with a card moved

  test('type a seed and play it; the game given up is listed as lost', () => {
    let app = open(played());
    assert.deepEqual(app.deals, { typed: '', index: 0, drawMode: 1 });
    app = press(app, '0', '4', '2', 'backspace', '2', 'd');
    assert.deepEqual(app.deals, { typed: '42', index: 0, drawMode: 3, note: undefined });
    app = press(app, 'enter');
    assert.equal(app.deals, undefined);
    assert.equal(app.game.seed, 42);
    assert.equal(app.game.drawMode, 3);
    assert.equal(app.status, 'checking'); // not proven first: the solver judges it now
    assert.match(app.message, /Seed 42, Draw 3/);
    assert.deepEqual(app.stats.games.map((g) => [g.seed, g.result]), [[1, 'lost']]);
  });

  test('choose a recent game with the arrows; the one being played is not dealt again', () => {
    // The same deal in Draw 3 (same columns, so w w moves a card), and Draw 1 given up.
    let app = press(played(), 'g', '1', 'd', 'enter', 'w', 'w');
    assert.equal(app.game.drawMode, 3);
    app = open(app);
    assert.deepEqual(app.stats.games.map((g) => [g.seed, g.drawMode, g.result]), [[1, 3, 'playing'], [1, 1, 'lost']]);
    app = press(app, 'enter'); // the newest is this game
    assert.equal(app.game.drawMode, 3);
    assert.ok(app.game.moves > 0);
    assert.match(app.message, /the game you are playing/);
    app = press(app, 'g', 'down', 'down', 'up', 'down', 'enter');
    assert.equal(app.game.drawMode, 1);
    assert.equal(app.game.moves, 0);
  });

  test('a deal lost before says when, at the start and in the record line', () => {
    let app = press(played(), 'g', '7', 'enter', 'w', 'w'); // seed 1 given up for seed 7
    app = press(app, 'g', '1', 'enter');
    assert.equal(app.game.seed, 1);
    const lostAt = app.stats.games.find((g) => g.seed === 1)!.at;
    assert.match(app.message, /You lost this deal on \d\d-\d\d \d\d:\d\d\. Revenge\?/);
    assert.equal(viewOf(app, 0).lostBefore, lostAt);
    assert.match(renderKlondike(app.game, viewOf(app, 0)).toText(), /lost before \d\d-\d\d \d\d:\d\d/);
    // Seed 7 was never lost: nothing said.
    assert.equal(viewOf(press(app, 'g', '7', 'enter'), 0).lostBefore, undefined);
  });

  test('a deal won is not played again, from the list or typed', () => {
    const wonSeven = { seed: 7, drawMode: 1 as const, result: 'won' as const, ms: 60_000, moves: 99, at: 1, redeals: 1 };
    let app = open({ ...played(), stats: { games: [wonSeven] } });
    app = press(app, 'enter'); // the won game is first in the list
    assert.ok(app.deals);
    assert.match(app.deals.note!, /Seed 7 was won on .*not played again/);
    assert.equal(app.game.seed, 1);
    app = press(app, '7');
    assert.equal(app.deals!.note, undefined); // a key clears it
    const text = renderDeals(80, 24, app.stats.games, app.deals!, { seed: 1, drawMode: 1, ms: 0, moves: 1, playing: true }).toText();
    assert.match(text, /Won on .*: won deals are not played again\./);
    assert.match(text, /7 +1 +won +01:00 +99 +1/); // with the redeals it took
    assert.equal(press(app, 'enter').game.seed, 1);
    // In Draw 3 seed 7 is another deal, so it can be played.
    assert.equal(press(app, 'd', 'enter').game.seed, 7);
  });

  test('the list shows where a game was lost and how hard the deal is', () => {
    const g = (seed: number, extra: object) => ({ seed, drawMode: 1 as const, result: 'lost' as const, ms: 60_000, moves: 40, at: 1, ...extra });
    const games = [g(1, { lostAt: 38, level: 3 }), g(2, { level: 1 }), g(3, {}), g(4, { lostAt: 0, level: 0 })];
    const text = renderDeals(80, 24, games, { typed: '', index: 0, drawMode: 1 }, { seed: 9, drawMode: 1, ms: 0, moves: 0, playing: false }).toText();
    assert.match(text, /1 +1 +lost @38 +01:00 +40 +hard/);
    assert.match(text, /2 +1 +gave up +01:00 +40 +easy/);
    assert.match(text, /3 +1 +gave up +01:00 +40 +…/); // still being rated
    assert.match(text, /4 +1 +no win +01:00 +40 +\?/);
  });

  test('seeds stay 32-bit, esc leaves the game alone, and the screen draws', () => {
    let app = open(played());
    app = press(app, ...'4294967295'.split(''), '9');
    assert.equal(app.deals!.typed, '4294967295');
    const text = renderDeals(80, 24, app.stats.games, app.deals!, { seed: 1, drawMode: 1, ms: 65_000, moves: 1, playing: true }).toText();
    assert.match(text, /Seed {2}4294967295/);
    assert.match(text, /1 +1 +playing +01:05 +1/);
    assert.match(text, /gives up the game in progress/);
    const back = press(app, 'escape');
    assert.equal(back.deals, undefined);
    assert.equal(back.game.seed, 1);
  });
});
