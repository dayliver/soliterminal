import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type App, CEREMONY_MS, abandon, choiceKey, animating, applyAhead, applyDeepVerdict, applyVerdict, createApp, handleKey, liveSuspect, playTime, redealsUsed, slackCheck, stampDialog, tick, viewOf } from '../src/app.ts';
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

/** The clock for `press`: it only runs forward, so a dialog never sees a key sent before it came up. */
let clock = 10_000;

/** Presses keys in order, one second apart. */
function press(app: App, ...keys: string[]): App {
  const next = seeds();
  for (const k of keys) app = handleKey(app, k, (clock += 1000), next);
  return app;
}

const run = (s: ReturnType<typeof board>) => createApp(s);

/** The esc menu, top to bottom. */
const MENU = ['back', 'new', 'restart', 'draw', 'hint', 'deals', 'stats', 'help', 'quit'] as const;
/** The keys that choose an item from the esc menu. */
const menu = (item: (typeof MENU)[number]): string[] => ['escape', ...Array<string>(MENU.indexOf(item)).fill('down'), 'enter'];

describe('pile keys', () => {
  test('source key then destination key moves the cards', () => {
    const app = press(run(board({ waste: '7D', tableau: ['| 8S'] })), 'w', 'a');
    assert.equal(labels(app.game.tableau[0]!.up), '8S 7D');
    assert.equal(app.held, undefined);
    assert.equal(app.history.length, 1);
  });

  test('the run that fits is worked out on drop', () => {
    const app = press(run(board({ tableau: ['| XH', '2C | KS QH JC XD 9S 8H 7C'] })), 's', 'a');
    assert.equal(labels(app.game.tableau[0]!.up), 'XH 9S 8H 7C');
  });

  test('same key twice moves to the best spot', () => {
    const app = press(run(board({ foundations: ['AS'], tableau: ['| 2S'] })), 'a', 'a');
    assert.equal(labels(app.game.foundations[0]!), 'AS 2S');
  });

  test('a failed drop keeps the cards in hand and explains why', () => {
    const app = press(run(board({ waste: '7D', tableau: ['| 8D'] })), 'w', 'a');
    assert.deepEqual(app.held?.from, pile.waste);
    assert.match(app.message, /7♦ cannot go on column 1/);
  });

  test('picking from an empty waste points at the stock key', () => {
    const app = press(run(board({ stock: '2C' })), 'w');
    assert.equal(app.held, undefined);
    assert.match(app.message, /Press q to draw/);
  });

  test('q draws and drops anything held', () => {
    const app = press(run(board({ stock: '2C 3C', tableau: ['| 8S'] })), 'a', 'q');
    assert.equal(app.held, undefined);
    assert.equal(labels(app.game.waste), '3C');
  });

  test('escape puts the cards back', () => {
    const app = press(run(board({ tableau: ['| 8S'] })), 'a', 'escape');
    assert.equal(app.held, undefined);
  });
});

describe('foundation keys', () => {
  const s = () => board({ foundations: ['AC', 'AD'], tableau: ['3S | 2D'] });

  test('r t y u are exact, and the wrong one suggests i', () => {
    const app = press(run(s()), 'a', 'u');
    assert.equal(app.game.foundations[3]!.length, 0);
    assert.equal(app.message, '2♦ goes on t. Press i to send it there.');
    // Cards are still held, so i finishes the job.
    const done = press(app, 'i');
    assert.equal(labels(done.game.foundations[1]!), 'AD 2D');
    assert.equal(labels(done.game.tableau[0]!.up), '3S');
  });

  test('i with nothing held sends the card under the cursor', () => {
    const app = press(run(s()), 'i');
    assert.equal(labels(app.game.foundations[1]!), 'AD 2D');
  });

  test('an ace goes exactly where it is sent', () => {
    const app = press(run(board({ waste: 'AH' })), 'w', 'y');
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
    const app = press(run(board({ waste: '7D', tableau: ['| 9S', '', '| 8S'] })), 'right', 'right', 'w', 'escape', 'down');
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
    const app = press(run(board({ foundations: ['AS'], tableau: ['| 3H 2S'] })), 'down', 'down', 'space', 'i');
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
    let app = press(run(board({ waste: '7D', stock: '2C', tableau: ['| 8S'] })), 'w', 'a', 'q');
    assert.equal(app.history.length, 2);
    app = press(app, 'z');
    assert.equal(labels(app.game.tableau[0]!.up), '8S 7D');
    app = press(app, 'backspace');
    assert.equal(labels(app.game.waste), '7D');
    assert.equal(press(app, 'z').message, 'Nothing to undo.');
  });

  test('a new game from the menu asks in a dialog once a game is under way', () => {
    assert.equal(press(createApp(deal(1)), ...menu('new')).game.seed, 1000); // untouched: no question
    let app = press(createApp(deal(1)), 's', 's');
    app = press(app, ...menu('new'));
    assert.equal(app.dialog, 'new');
    assert.equal(app.game.seed, 1);
    assert.equal(press(app, 'enter').game.seed, 1000);
    assert.equal(press(app, 'space').game.seed, 1000);
    // Down to "Keep playing", then enter, keeps the game.
    assert.equal(press(app, 'down', 'enter').game.seed, 1);
    // Keys the dialog does not offer are ignored; esc closes it.
    assert.equal(press(app, 'a'), app);
    const kept = press(app, 'escape');
    assert.equal(kept.dialog, undefined);
    assert.equal(kept.game.seed, 1);
  });

  test('the cursor stays where the cards came from, on the card turned up there', () => {
    const s = board({ tableau: ['| 9C', '', '', '2S 3S | 9H', '', 'KD | 8S'] });
    // Enter on h (the cursor starts on a; five steps right) sends 8♠ onto 9♥ on f.
    let app = press(run(s), 'right', 'right', 'right', 'right', 'right', 'enter');
    assert.equal(labels(app.game.tableau[3]!.up), '9H 8S');
    // The cursor is still on h, where K♦ has turned up: the next card to play.
    assert.deepEqual(app.cursor, pile.tableau(5));
    assert.equal(labels(app.game.tableau[5]!.up), 'KD');
    // With pile keys, the cursor goes to the pile picked from, and stays there.
    app = press(run(s), 'h', 'h');
    assert.deepEqual(app.cursor, pile.tableau(5));
    // From the waste: the cursor stays on the waste, for the next card there.
    app = press(run(board({ waste: '6C 7D', tableau: ['', '', '', '', '', '| 8S'] })), 'up', 'right', 'enter');
    assert.equal(labels(app.game.tableau[5]!.up), '8S 7D');
    assert.deepEqual(app.cursor, pile.waste);
    // To a foundation: the cursor stays put.
    app = press(run(board({ tableau: ['| AS', '| 5D'] })), 'a', 'i');
    assert.equal(app.game.foundations[0]!.length, 1);
    assert.deepEqual(app.cursor, pile.tableau(0)); // where the ace was picked up
  });

  test('drawing moves the cursor to the waste; recycling does not', () => {
    let app = press(createApp(deal(1)), 'right', 'right');
    assert.deepEqual(app.cursor, pile.tableau(2));
    app = press(app, 'q');
    assert.deepEqual(app.cursor, pile.waste);
    // Then space picks the new card up.
    assert.deepEqual(press(app, 'space').held?.from, pile.waste);
    // Recycling empties the waste: the cursor stays where it was.
    const empty = { ...app, game: { ...app.game, stock: [], waste: app.game.waste }, cursor: pile.tableau(4) };
    const recycled = press(empty, 'q');
    assert.equal(recycled.game.waste.length, 0);
    assert.deepEqual(recycled.cursor, pile.tableau(4));
  });

  test('esc puts held cards back first, otherwise brings up the menu; esc again closes it', () => {
    let app = press(createApp(deal(1)), 'a');
    assert.ok(app.held);
    app = press(app, 'escape');
    assert.equal(app.held, undefined);
    assert.equal(app.dialog, undefined);
    app = press(app, 'escape');
    assert.equal(app.dialog, 'menu');
    assert.equal(app.choice, 0);
    assert.equal(press(app, 'down', 'down').choice, 2);
    assert.equal(press(app, 'up').choice, MENU.length - 1); // round from the top to the bottom
    assert.equal(press(app, 'escape').dialog, undefined);
    assert.equal(press(app, 'enter').dialog, undefined); // Resume
  });

  test('tab switches card size, kept across deals', () => {
    let app = press(createApp(deal(1)), 'tab');
    assert.equal(app.compact, true);
    assert.match(app.message, /Compact/);
    assert.equal(press(app, ...menu('new')).compact, true); // untouched deal, so it deals at once
    assert.equal(press(app, 'tab').compact, false);
    assert.equal(createApp(deal(1), { compact: true }).compact, true);
  });

  test('the menu switches draw mode now on an untouched deal, else from the next game', () => {
    assert.equal(press(createApp(deal(1)), ...menu('draw')).game.drawMode, 3);
    const busy = press(createApp(deal(1)), 's', 's', ...menu('draw'));
    assert.equal(busy.game.drawMode, 1);
    assert.equal(busy.nextDrawMode, 3);
    assert.equal(press(busy, ...menu('new'), 'enter').game.drawMode, 3);
  });

  test('a card moved and taken back is still a game under way: switching draw mode does not give it up', () => {
    // Find a deal where a column card can move, move it, and undo.
    for (let seed = 1; seed < 100; seed++) {
      const moved = ['a', 's', 'd', 'f', 'g', 'h', 'j'].map((k) => press(createApp(deal(seed)), k, k)).find((a) => a.play === 'counted');
      if (!moved) continue;
      const back = press(moved, 'z');
      assert.equal(back.game.moves, 0);
      const switched = press(back, ...menu('draw'));
      assert.equal(switched.game.seed, seed);
      assert.equal(switched.outbox.length, 0);
      return;
    }
    assert.fail('no deal with a column move');
  });

  test('help opens from the menu and any key closes it without acting', () => {
    let app = press(run(board({ stock: '2C' })), ...menu('help'));
    assert.equal(app.showHelp, true);
    app = press(app, 'q');
    assert.equal(app.showHelp, false);
    assert.equal(app.game.stock.length, 1);
  });

  test('e, over the gap in the top row, says there is nothing there', () => {
    const app = press(createApp(deal(1)), 'e');
    assert.match(app.message, /nothing there/);
    assert.deepEqual(app.game, createApp(deal(1)).game);
  });

  test('a letter picks a choice at once: the first of its label, distinct in every dialog', () => {
    const app = run(board({ tableau: ['| 8S'] }));
    const kinds = ['menu', 'restart', 'new', 'lost', 'won', 'share', 'seed', 'quit', 'hint'] as const;
    for (const dialog of kinds) {
      const d = viewOf({ ...app, dialog, choice: 0, seedOffer: { seed: 5, drawMode: 1 }, lastWin: undefined }, 0).dialog!;
      const keys = d.choices.map((c) => choiceKey(c));
      assert.equal(new Set(keys).size, keys.length, `${dialog}: ${d.choices.join(', ')}`);
      assert.ok(keys.every((k) => /^[a-z]$/.test(k)), dialog);
    }
    // In the menu: s for Statistics, d for the draw mode, q to quit; arrows and enter still work.
    assert.equal(press(app, 'escape', 's').showStats, true);
    assert.equal(press(app, 'escape', 'd').nextDrawMode, 3);
    assert.equal(press(app, 'escape', 'q').quit, true);
    assert.equal(press(app, 'escape', 'k').showHelp, true);
    assert.equal(press(app, 'escape', 'b').dialog, undefined);
    // A letter no choice starts with does nothing; inside a dialog it never reaches the board.
    const asked = press(app, 'escape', 'w');
    assert.deepEqual([asked.dialog, asked.game], ['menu', app.game]);
  });

  test('ctrl+q and ctrl+c quit at once; so does Quit in the menu', () => {
    assert.equal(press(run(board({})), 'ctrl+q').quit, true);
    assert.equal(press(run(board({})), 'ctrl+c').quit, true);
    assert.equal(press(run(board({})), ...menu('quit')).quit, true);
  });

  test('x asks before quitting: enter or space quits, esc or Keep playing stays', () => {
    const asked = press(run(board({ tableau: ['| 8S'] })), 'a', 'x');
    assert.equal(asked.dialog, 'quit');
    assert.equal(asked.held, undefined);
    assert.match(viewOf(asked, 0).dialog!.lines[0]!, /kept/);
    assert.equal(press(asked, 'a').quit, false); // other keys do nothing
    for (const yes of ['enter', 'space']) assert.equal(press(asked, yes).quit, true, yes);
    for (const keys of [['escape'], ['down', 'enter']]) {
      const stay = press(asked, ...keys);
      assert.deepEqual([stay.dialog, stay.quit], [undefined, false]);
    }
  });

  test('the clock starts on the first move', () => {
    let app = run(board({ waste: 'AS' }));
    assert.equal(viewOf(app, 99_000).elapsedMs, 0);
    app = handleKey(app, 'w', 50_000, seeds());
    app = handleKey(app, 'i', 50_000, seeds());
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
    let app = press(endgame(), 's', 'i');
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
    let app = press(endgame(), 's', 'i');
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
    assert.deepEqual(d.choices, ['New deal', 'Choose a deal', 'Statistics', 'Look at the board', 'Quit']);
    assert.equal(d.selected, 0);
    assert.equal(app.stats.games[0]!.redeals, 0);
  });

  test('any key cuts the ceremony short; the results are chosen from with the arrows', () => {
    const results = press(win(), 'a');
    assert.equal(results.dialog, 'won');
    assert.equal(results.celebrating, false);
    assert.equal(press(results, 'enter').game.seed, 1000);
    assert.ok(press(results, 'down', 'enter').deals);
    assert.equal(press(results, 'down', 'down', 'space').showStats, true);
    assert.equal(press(results, 'escape').dialog, undefined);
    // A deal won is not played again.
    assert.match(press(results, 'escape', ...menu('restart')).message, /This deal is won/);
  });

  test('a win counts once, even after undo and winning again', () => {
    const app = win();
    assert.deepEqual([statsFor(app.stats, 1).played, statsFor(app.stats, 1).won], [1, 1]);
    let redo = press(press(app, 'a', 'escape'), 'z');
    assert.equal(isWon(redo.game), false);
    // Send the last card home again: a column key twice moves it to the best spot.
    for (const k of ['a', 's', 'd']) if (!isWon(redo.game)) redo = press(redo, k, k);
    let now = 200_000;
    while (redo.autoQueue.length > 0) redo = tick(redo, (now += 60));
    assert.equal(isWon(redo.game), true);
    assert.deepEqual([statsFor(redo.stats, 1).played, statsFor(redo.stats, 1).won], [1, 1]);
  });

  test('a key during auto-complete skips to the end', () => {
    const app = press(endgame(), 's', 'i', 'left');
    assert.equal(isWon(app.game), true);
  });

  test('a face-down card holds auto-complete back', () => {
    const app = press(run(board({ foundations: ['AS'], tableau: ['3D | 2S'] })), 'a', 'i');
    assert.equal(app.autoQueue.length, 0);
  });
});

describe('normalizeKey', () => {
  test('maps Node keypress events to short names', () => {
    assert.equal(normalizeKey('q', { name: 'q', ctrl: true, sequence: '\x11' }), 'ctrl+q');
    assert.equal(normalizeKey('\t', { name: 'tab', sequence: '\t' }), 'tab');
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
    assert.match(buf.toText().split('\n')[29]!, /esc menu/);
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
    app = press(app, 'w', 'a');
    assert.equal(app.status, 'checking');
    const v = app.version;
    app = press(app, 'q');
    assert.equal(applyVerdict(app, v, 'lost'), app); // stale
    app = applyVerdict(app, app.version, 'winnable');
    assert.equal(app.status, 'winnable');
    assert.equal(viewOf(app, 0).status, 'winnable');
  });

  test('a proven loss shows 0% in a dialog that offers a retry', () => {
    let app = press(createApp(position(), { verified: true }), 'w', 'a');
    app = applyVerdict(app, app.version, 'lost');
    assert.equal(app.status, 'lost');
    assert.equal(app.dialog, 'lost');
    const dialog = viewOf(app, 0).dialog!;
    assert.equal(dialog.danger, true);
    assert.match(dialog.lines.join(' '), /0%.*Try again\?/);
    assert.deepEqual(dialog.choices, ['Back to the last winnable spot', 'Restart this deal', 'New deal', 'Play on', 'Quit (your game is kept)']);
    // Other keys do nothing while the question is up.
    assert.equal(press(app, 's'), app);
  });

  test('giving up a lost game records the move that lost it; giving up a live one does not', () => {
    let app = press(createApp(position(), { verified: true }), 'w', 'a', 's', 's'); // counted from the first card moved
    app = applyVerdict(app, app.version, 'lost');
    const lost = abandon(app, 50_000).stats.games[0]!;
    assert.equal(lost.result, 'lost');
    assert.equal(lost.lostAt, 1); // the deal was winnable, the first move lost it
    const live = press(createApp(position(), { verified: true }), 'w', 'a');
    assert.equal(abandon(live, 50_000).stats.games[0]!.lostAt, undefined);
    assert.equal(abandon(live, 50_000).stats.games[0]!.limit, null); // the hand-built board has no redeal limit
  });

  test('a dialog that comes up on its own does not take a key already on its way', () => {
    let app = handleKey(createApp(position(), { verified: true }), 'w', 40_000, seeds());
    app = handleKey(app, 'a', 41_000, seeds());
    // The loss arrives from the solver while the player is still pressing keys.
    app = stampDialog(app, applyVerdict(app, app.version, 'lost'), 50_000);
    assert.equal(app.dialog, 'lost');
    assert.equal(app.choice, 0);
    assert.equal(handleKey(app, 'enter', 50_200, seeds()).dialog, 'lost'); // meant for the board
    assert.equal(handleKey(app, 'enter', 51_000, seeds()).dialog, undefined); // now it answers
  });

  test('a dialog the player opens answers at once, starting on its first choice', () => {
    let app = press(createApp(deal(1)), 's', 's');
    app = handleKey(app, 'escape', 50_000, seeds());
    app = handleKey(app, 'down', 50_100, seeds());
    app = handleKey(app, 'enter', 50_200, seeds());
    assert.deepEqual([app.dialog, app.choice], ['new', 0]);
    assert.equal(handleKey(app, 'space', 50_300, seeds()).game.seed, 1000);
  });

  test('z goes back to the last position proven winnable, even several moves ago', () => {
    let app = createApp(position(), { verified: true });
    app = press(app, 'w', 'a'); // 7D onto 8S, never judged
    app = press(app, 'q'); // draw 3C
    app = applyVerdict(app, app.version, 'lost');
    app = press(app, 'z');
    assert.equal(app.dialog, undefined);
    assert.equal(app.status, 'winnable');
    assert.equal(labels(app.game.waste), '7D');
    assert.equal(app.history.length, 0);
  });

  test('after a loss, the choices restart at once or deal a new one', () => {
    let app = press(createApp(position(), { verified: true }), 'w', 'a');
    app = applyVerdict(app, app.version, 'lost');
    assert.equal(app.dialog, 'lost');
    const restarted = press(app, 'down', 'enter');
    assert.deepEqual([restarted.history.length, restarted.game.moves], [0, 0]);
    assert.equal(restarted.status, 'winnable');
    assert.equal(restarted.dialog, undefined);
    assert.equal(press(app, 'down', 'down', 'enter').game.seed, 1000);
  });

  test('esc plays on without asking again until it is winnable once more', () => {
    let app = press(createApp(position(), { verified: true }), 'w', 'a');
    app = press(applyVerdict(app, app.version, 'lost'), 'escape');
    assert.equal(app.dialog, undefined);
    app = press(app, 'q');
    app = applyVerdict(app, app.version, 'lost');
    assert.equal(app.dialog, undefined);
    assert.equal(app.status, 'lost');
  });

  test('restart from the menu asks first; enter or space confirms, esc cancels', () => {
    let app = press(createApp(deal(5)), 'q');
    app = press(app, ...menu('restart'));
    assert.equal(app.dialog, 'restart');
    assert.equal(viewOf(app, 0).dialog?.title, 'Restart this deal?');
    for (const yes of ['enter', 'space']) assert.equal(press(app, yes).game.moves, 0, yes);
    assert.equal(press(app, 'escape').game.moves, 1);
    assert.equal(press(app, 'down', 'enter').game.moves, 1);
    assert.match(press(createApp(deal(5)), ...menu('restart')).message, /already at the start/);
  });

  test('a won game is not started over', () => {
    const app = { ...press(createApp(deal(5)), 'q'), finishedAt: 1, play: 'won' as const };
    const after = press(app, ...menu('restart'));
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
    for (const k of ['z', 'x', 'tab', '?', 'space', 'enter', 'escape', 'backspace', 'left', 'right', 'up', 'down', 'ctrl+q', 'ctrl+c']) {
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
  test('a game is under way from the first card moved, and goes on record when it ends', () => {
    const app = createApp(deal(1));
    const looked = press(app, 'q', 'q', 'q');
    assert.equal(looked.play, 'fresh');
    // Drawing alone only looks: a new deal needs no asking, and leaving it costs nothing.
    assert.equal(press(looked, ...menu('new')).dialog, undefined);
    assert.equal(abandon(looked).outbox.length, 0);
    // Double-tapping s plays a card at the start of deal 1: under way, but not on record yet.
    const busy = press(app, 'q', 's', 's', 'q');
    assert.equal(busy.play, 'counted');
    assert.equal(statsFor(busy.stats, 1).played, 0);
    assert.equal(busy.outbox.length, 0);
    // Given up, it is a loss, written out once as a line for the log.
    const gaveUp = abandon(busy, 60_000);
    assert.equal(statsFor(gaveUp.stats, 1).played, 1);
    assert.deepEqual(gaveUp.outbox.map((e) => ('game' in e ? e.game.id : '')), [busy.gameId]);
    assert.equal(gaveUp.stats.games[0]!.at, busy.gameAt); // when its first card moved
  });

  test('restarting carries on the same game; a new deal or quitting ends the streak', () => {
    const streaky = { ...createApp(deal(1)), stats: { games: [3, 2, 1].map((seed) => ({ id: `0000000${seed}`, seed, drawMode: 1 as const, result: 'won' as const, ms: 1, moves: 1, at: seed, redeals: 0 })) } };
    const busy = press(streaky, 's', 's');
    const restarted = press(busy, ...menu('restart'), 'enter', 's', 's');
    assert.equal(restarted.gameId, busy.gameId); // the same play of the deal
    assert.equal(restarted.play, 'counted');
    assert.equal(statsFor(abandon(restarted).stats, 1).played, 4);
    assert.equal(statsFor(restarted.stats, 1).streak, 3);
    const gaveUp = press(busy, ...menu('new'), 'enter');
    assert.notEqual(gaveUp.gameId, busy.gameId);
    assert.equal(statsFor(gaveUp.stats, 1).streak, 0);
    assert.equal(statsFor(abandon(busy).stats, 1).streak, 0);
    assert.equal(statsFor(abandon(streaky).stats, 1).streak, 3); // nothing played yet
  });

  test('the menu opens the statistics and any key closes them', () => {
    const app = press(createApp(deal(1)), ...menu('stats'));
    assert.equal(app.showStats, true);
    const back = press(app, 'a');
    assert.equal(back.showStats, false);
    assert.equal(back.held, undefined); // the key only closed the screen
  });

  test('new deals use the redeal setting, and running out is announced', () => {
    const app = createApp(deal(1, 1, 2));
    assert.equal(app.redeals, 2);
    assert.equal(press(app, 'q', ...menu('new')).game.redealsLeft, 2);
    let s = press(createApp(board({ stock: '2C', waste: '3D', redealsLeft: 1 })), 'q');
    assert.match(s.message, /stock is out. 1 redeal left/);
    s = press(s, 'q', 'q', 'q'); // redeal, then turn both cards again
    assert.equal(s.game.redealsLeft, 0);
    assert.match(s.message, /No redeals left/);
    assert.match(press(s, 'q').message, /No redeals left/);
  });
});

describe('pausing while the terminal is out of focus', () => {
  const key = (app: App, k: string, now: number) => handleKey(app, k, now, () => ({ seed: 1, verified: false }));

  test('focus reports become keys of their own', () => {
    assert.equal(normalizeKey(undefined, { sequence: '\x1b[I', name: 'undefined', code: '[I' }), 'focus-in');
    assert.equal(normalizeKey(undefined, { sequence: '\x1b[O', name: 'undefined', code: '[O' }), 'focus-out');
  });

  test('the clock stops while away and the time away is left out', () => {
    let app = key(createApp(deal(1)), 'q', 10_000); // first move starts the clock
    app = key(app, 'focus-out', 25_000);
    assert.equal(viewOf(app, 25_000).paused, true);
    assert.equal(playTime(app, 25_000), 15_000);
    assert.equal(playTime(app, 600_000), 15_000); // still stopped, long after
    app = key(app, 'focus-in', 600_000);
    assert.equal(viewOf(app, 600_000).paused, false);
    assert.equal(playTime(app, 605_000), 20_000);
  });

  test('focus keys change nothing else: no dialog closes, no ceremony ends', () => {
    const asking = key(key(key(createApp(deal(1)), 's', 500), 's', 1_000), 'escape', 2_000);
    assert.equal(asking.dialog, 'menu');
    assert.equal(key(key(asking, 'focus-out', 3_000), 'focus-in', 4_000).dialog, 'menu');
  });

  test('a key press counts as being back, if the terminal never said so', () => {
    let app = key(createApp(deal(1)), 'q', 10_000);
    app = key(app, 'focus-out', 20_000);
    app = key(app, 'right', 50_000); // no focus-in arrived
    assert.equal(app.pausedAt, undefined);
    assert.equal(playTime(app, 50_000), 10_000);
  });

  test('time away before the first move does not count against the game', () => {
    let app = key(createApp(deal(1)), 'focus-out', 1_000);
    app = key(app, 'focus-in', 90_000);
    app = key(app, 'q', 100_000);
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
    let app = key(createApp(almost), 's', 1_000);
    app = key(app, 's', 1_500); // Q♠ home: the clock starts, and K♠ is queued to finish
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
    app = press(app, 'q');
    app = applyVerdict(app, app.version, 'winnable');
    app = press(app, 'q');
    app = applyVerdict(app, app.version, 'unclear');
    return app;
  };

  test('the first unclear position after a winnable one is suspected, with a warning', () => {
    const app = setup();
    assert.equal(app.status, 'unclear');
    assert.equal(liveSuspect(app)?.game, app.game);
    assert.match(app.message, /not confirmed yet/);
    // Later unclear positions keep the first one as the suspect, and do not warn again.
    let later = press(app, 'q');
    later = applyVerdict(later, later.version, 'unclear');
    assert.equal(liveSuspect(later)?.game, app.game);
    assert.equal(later.message, '');
  });

  test('a loss proven there is a loss now, several moves on', () => {
    const app = setup();
    let later = press(app, 'q', 'q');
    later = applyDeepVerdict(later, app.game, 'lost');
    assert.equal(later.status, 'lost');
    assert.equal(later.dialog, 'lost');
    const d = viewOf(later, 0).dialog!;
    assert.match(d.lines.join(' '), /lost within the last 3 moves\. Going back goes to just before them/);
    // z goes back to the last winnable position, before the suspect.
    const back = press(later, 'z');
    assert.equal(back.history.length, 1);
    assert.equal(back.status, 'winnable');
  });

  test('a win proven there moves the point to go back to forward', () => {
    const app = setup();
    const later = applyDeepVerdict(press(app, 'q'), app.game, 'winnable');
    assert.equal(later.lastWinnable?.game, app.game);
    assert.equal(later.suspect, undefined);
  });

  test('undoing past the suspect, or a winnable verdict, drops it', () => {
    const app = setup();
    const undone = press(app, 'z');
    assert.equal(liveSuspect(undone), undefined);
    assert.equal(applyDeepVerdict(undone, app.game, 'lost').status, undone.status); // too late to matter
    let later = press(app, 'q');
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

  test('? asks first once a hint is there, then shows it; before that it says why not', () => {
    let app = play(createApp(position()), 'q');
    assert.match(press(app, '?').message, /Hints open up/);
    assert.equal(press(app, '?').dialog, undefined);
    app = play(app, 'q', 'q', 'q'); // round the stock: stalled
    const asked = press(app, '/');
    assert.equal(asked.dialog, 'hint');
    assert.equal(viewOf(asked, 0).dialog!.title, 'Show a hint?');
    assert.match(press(asked, 'enter').message, /Hint: draw until 7♦/);
    const no = press(asked, 'escape');
    assert.equal(no.dialog, undefined);
    assert.doesNotMatch(no.message, /Hint:/);
  });

  test('the hint gives nothing before the whole stock has gone by', () => {
    const app = play(createApp(position()), 'q', 'q');
    assert.equal(app.stalled, false);
    const after = press(app, ...menu('hint'));
    assert.equal(after.showHelp, false);
    assert.match(after.message, /Hints open up/);
  });

  test('turning the waste over with nothing played opens the hint', () => {
    let app = play(createApp(position()), 'q', 'q', 'q');
    assert.equal(app.stalled, false);
    app = play(app, 'q'); // redeal: every card has been on top
    assert.equal(app.stalled, true);
    assert.match(app.message, /can still be won.*\? shows it/);
    app = press(app, ...menu('hint'));
    assert.match(app.message, /Hint: draw until 7♦ is on the waste, then play it to column 1 \(a\)/);
    assert.deepEqual(app.cursor, pile.waste);
  });

  test('with the card on top, the hint names the keys', () => {
    let app = play(createApp(position()), 'q', 'q', 'q', 'q', 'q');
    assert.equal(labels(app.game.waste), '7D');
    app = press(app, ...menu('hint'));
    assert.match(app.message, /Hint: 7♦ from the waste \(w\) to column 1 \(a\)/);
  });

  test('a stall counts from where the waste stood at the last real move', () => {
    // Waste has two cards at the start: the stall needs them both seen again.
    let app = play(createApp(board({ stock: '4C', waste: '2C 3C', tableau: ['| 8S'] })), 'q', 'q');
    assert.equal(app.stalled, false); // redealt, but the waste is back to 0 of 2
    app = play(app, 'q');
    assert.equal(app.stalled, false);
    app = play(app, 'q');
    assert.equal(app.stalled, true);
  });

  test('any real move closes the hint again', () => {
    let app = play(createApp(position()), 'q', 'q', 'q', 'q', 'q');
    assert.equal(app.stalled, true);
    app = play(app, 'w', 'a');
    assert.equal(labels(app.game.tableau[0]!.up), '8S 7D');
    assert.equal(app.stalled, false);
    assert.match(press(app, ...menu('hint')).message, /Hints open up/);
  });

  test('running out of stock with no redeals left also counts', () => {
    let app = play(createApp(board({ stock: '2C 3C', tableau: ['| 8S'], redealsLeft: 0 })), 'q', 'q');
    assert.equal(app.stalled, false);
    app = play(app, 'q'); // cannot turn the waste over
    assert.equal(app.stalled, true);
    assert.match(app.message, /\? shows it/);
  });

  test('with no talon at all, pressing the stock key counts at once', () => {
    let app = play(createApp(board({ tableau: ['| 8S', '| 7D'] })), 's', 'a');
    assert.equal(app.stalled, false);
    app = play(app, 'q');
    assert.equal(app.stalled, true);
  });

  test('no hint while the position is unproven', () => {
    let app = play(createApp(position()), 'q', 'q', 'q');
    app = press(app, 'q');
    assert.equal(app.stalled, true);
    assert.match(press(app, ...menu('hint')).message, /Still checking/);
    app = applyVerdict(app, app.version, 'unclear');
    assert.match(press(app, ...menu('hint')).message, /not confirmed/);
  });

  test('a run in a column: the hint says how many cards', () => {
    const run = { from: { kind: 'tableau', index: 1 }, to: { kind: 'tableau', index: 0 }, card: { suit: 'D', rank: 7 }, count: 2 } as const;
    let app = createApp(board({ stock: '2C', tableau: ['| 8S', '| 7D 6C'] }));
    app = press(app, 'q', 'q');
    app = applyVerdict(app, app.version, 'winnable', run);
    assert.equal(app.stalled, true);
    app = press(app, ...menu('hint'));
    assert.match(app.message, /Hint: 7♦ and the card on it from column 2 \(s\) to column 1 \(a\)/);
    assert.deepEqual(app.cursor, pile.tableau(1));
  });

  test('a hint for part of a run chooses just those cards', () => {
    const part = { from: { kind: 'tableau', index: 1 }, to: { kind: 'tableau', index: 0 }, card: { suit: 'D', rank: 7 }, count: 2 } as const;
    let app = createApp(board({ stock: '2C', tableau: ['| 8S', '| 8C 7D 6C'] }));
    app = press(app, 'q', 'q');
    app = applyVerdict(app, app.version, 'winnable', part);
    app = press(app, ...menu('hint'));
    assert.equal(app.selected, 2);
    app = press(app, 'space', 'a');
    assert.equal(labels(app.game.tableau[0]!.up), '8S 7D 6C');
  });
});

describe('known positions and looking ahead', () => {
  // 7D can go on 8S (a) or 8C (s). Say a is proven lost and s winnable.
  const position = () => board({ stock: '2C', waste: '7D', tableau: ['| 8S', '| 8C'] });
  const after = (app: App, keys: string[]) => press(app, ...keys).game;
  const start = () => createApp(position(), { verified: true });
  const onQ = after(start(), ['w', 'a']);
  const onW = after(start(), ['w', 's']);

  test('a move into a position found lost a move ahead loses at once, and z takes back just that move', () => {
    let app = applyAhead(start(), onQ, 'lost');
    app = press(app, 'w', 'a');
    assert.equal(app.status, 'lost');
    assert.equal(app.dialog, 'lost');
    assert.deepEqual(viewOf(app, 0).dialog!.lines, ['Win chance is now 0%. Try again?']);
    app = press(app, 'z');
    assert.equal(app.history.length, 0);
    assert.equal(labels(app.game.waste), '7D');
    assert.equal(app.status, 'winnable');
  });

  test('a known winnable position is settled without asking the solver', () => {
    const app = press(applyAhead(start(), onW, 'winnable'), 'w', 's');
    assert.equal(app.status, 'winnable');
    assert.equal(app.lastWinnable?.game, app.game);
  });

  test('picking up cards with a known losing place to go warns, without saying which', () => {
    const app = press(applyAhead(start(), onQ, 'lost'), 'w');
    assert.match(app.message, /Holding 7♦\. Careful: one of its two places loses the game\./);
    // With nowhere safe, it says so.
    const doomed = press(applyAhead(applyAhead(start(), onQ, 'lost'), onW, 'lost'), 'w');
    assert.match(doomed.message, /wherever it goes, the game is lost/);
  });

  test('the warning stands out: a red line with a warning sign, and the sign in the header', () => {
    const app = press(applyAhead(start(), onQ, 'lost'), 'w');
    const view = viewOf(app, 0);
    assert.deepEqual(view.danger, { message: true });
    const text = renderKlondike(app.game, view).toText();
    assert.match(text.split('\n')[0]!, /Win ⚠$/);
    assert.match(text, /⚠ Holding 7♦\. Careful/);
    // Nothing in hand, or nothing known to lose: the tick and the usual prompt.
    assert.equal(viewOf(press(app, 'escape'), 0).danger, undefined);
    const calm = viewOf(press(start(), 'w'), 0);
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
    let app = press(start(), 'w');
    assert.match(app.message, /Where does it go\?/);
    app = applyAhead(app, onQ, 'lost');
    assert.match(app.message, /Careful/);
    // A winnable answer changes nothing on screen.
    assert.equal(applyAhead(press(start(), 'w'), onW, 'winnable').message, press(start(), 'w').message);
  });

  test('a loss found late is remembered: making the same move again loses at once', () => {
    let app = press(start(), 'w', 'a');
    app = applyVerdict(app, app.version, 'unclear');
    app = press(app, 'q'); // played on before the long look came back
    const suspect = liveSuspect(app)!.game;
    app = applyDeepVerdict(app, suspect, 'lost');
    assert.equal(app.dialog, 'lost');
    app = press(app, 'z'); // back to before 7♦ went on q
    assert.equal(app.history.length, 0);
    app = press(app, 'w');
    assert.match(app.message, /Careful/);
    app = press(app, 'a');
    assert.equal(app.dialog, 'lost');
  });

  test('restarting the deal keeps what is known; a new deal forgets it', () => {
    // A real deal, so a restart deals the same cards again.
    const fresh = createApp(deal(5), { verified: true });
    const drawn = press(fresh, 'q').game;
    let app = applyAhead(press(fresh, 'q', 'q'), drawn, 'lost');
    app = press(app, ...menu('restart'), 'enter', 'q');
    assert.equal(app.dialog, 'lost');
    assert.equal(press(app, 'down', 'down', 'enter').known.size, 0); // New deal, from the loss choices
  });

  test('an answer for the position the player has just moved to settles it', () => {
    let app = press(start(), 'w', 'a');
    assert.equal(app.status, 'checking');
    app = applyAhead(app, onQ, 'lost');
    assert.equal(app.dialog, 'lost');
  });
});

describe('the deals screen', () => {
  /** Opens the deals screen from the menu, putting back any cards in hand first. */
  const open = (app: App) => press(app.held ? press(app, 'escape') : app, ...menu('deals'));
  const played = () => press(createApp(deal(1), { verified: true }), 's', 's'); // deal 1 with a card moved

  test('type a seed and play it; the game given up is listed as lost', () => {
    let app = open(played());
    assert.deepEqual(app.deals, { typed: '', index: 0, drawMode: 1 });
    app = press(app, '0', '4', '2', 'backspace', '2', 'right');
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
    // The same deal in Draw 3 (same columns, so s s moves a card), and Draw 1 given up.
    let app = press(open(played()), '1', 'right', 'enter', 's', 's');
    assert.equal(app.game.drawMode, 3);
    assert.deepEqual(app.stats.games.map((g) => [g.seed, g.drawMode, g.result]), [[1, 1, 'lost']]);
    app = press(open(app), '1', 'enter'); // typed: this very game (the screen starts on Draw 3, the mode in play)
    assert.equal(app.game.drawMode, 3);
    assert.ok(app.game.moves > 0);
    assert.match(app.message, /the game you are playing/);
    app = press(open(app), 'down', 'up', 'enter'); // the newest in the list: Draw 1, given up
    assert.equal(app.game.drawMode, 1);
    assert.equal(app.game.moves, 0);
    assert.deepEqual(app.stats.games.map((g) => [g.seed, g.drawMode, g.result]), [[1, 3, 'lost'], [1, 1, 'lost']]);
  });

  test('a deal lost before says when, at the start and in the record line', () => {
    let app = press(open(played()), '7', 'enter', 's', 's'); // seed 1 given up for seed 7
    app = press(open(app), '1', 'enter');
    assert.equal(app.game.seed, 1);
    const lostAt = app.stats.games.find((g) => g.seed === 1)!.at;
    assert.match(app.message, /You lost this deal on \d\d-\d\d \d\d:\d\d\. Revenge\?/);
    assert.equal(viewOf(app, 0).lostBefore, lostAt);
    assert.match(renderKlondike(app.game, viewOf(app, 0)).toText(), /lost before \d\d-\d\d \d\d:\d\d/);
    // Seed 7 was never lost: nothing said.
    assert.equal(viewOf(press(open(app), '7', 'enter'), 0).lostBefore, undefined);
  });

  test('a deal won is not played again, from the list or typed', () => {
    const wonSeven = { id: '00000007', seed: 7, drawMode: 1 as const, result: 'won' as const, ms: 60_000, moves: 99, at: 1, redeals: 1 };
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
    assert.equal(press(app, 'right', 'enter').game.seed, 7);
  });

  test('the list shows where a game was lost and how hard the deal is', () => {
    const g = (seed: number, extra: object) => ({ id: `0000000${seed}`, seed, drawMode: 1 as const, result: 'lost' as const, ms: 60_000, moves: 40, at: 1, ...extra });
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
    assert.match(text, /gives up seed 1: it counts as a loss/);
    const back = press(app, 'escape');
    assert.equal(back.deals, undefined);
    assert.equal(back.game.seed, 1);
  });
});
