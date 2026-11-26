import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp, handleKey, playTime, resumeApp, viewOf } from '../src/app.ts';
import { deal, positionKey } from '../src/core/klondike.ts';
import {
  loadSavedGame,
  parseSavedGame,
  removeSavedGame,
  replaySaved,
  savedGamePath,
  snapshot,
  stepsOf,
  writeSavedGame,
} from '../src/saved-game.ts';

const dealer = () => ({ seed: 2, verified: true });
const press = (app: App, ...keys: string[]) => keys.reduce((a, k, i) => handleKey(a, k, 10_000 + i * 1_000, dealer), app);
/** Deal 1 with some play: a card moved (double-tap w), draws, an undo, another card. */
const played = () => press(createApp(deal(1), { verified: true }), 's', 's', 'q', 'q', 'q', 'z', 'h', 'h', 'q');
/** Through JSON and back, as the file does it. */
const roundTrip = (app: App, now = 20_000) => parseSavedGame(JSON.parse(JSON.stringify(snapshot(app, now))))!;

describe('saved game', () => {
  test('the deal and its steps replay to exactly the same positions', () => {
    const app = played();
    const saved = roundTrip(app);
    assert.equal(saved.seed, 1);
    assert.equal(saved.steps.length, app.history.length);
    assert.equal(saved.play, 'counted');
    const states = replaySaved(saved)!;
    assert.deepEqual(states, [...app.history, app.game]);
  });

  test('foundations keep their places, not just their cards', () => {
    // An ace sent to one particular foundation comes back on that one.
    const app = press(createApp(deal(1)), 's', 's');
    const states = [...app.history, app.game];
    const steps = stepsOf(states)!;
    assert.equal(steps.length, 1);
    assert.deepEqual(replaySaved(roundTrip(app))!.at(-1)!.foundations, app.game.foundations);
  });

  test('resuming brings back the position, the undo history, the clock and the statistics state', () => {
    const app = played();
    const saved = roundTrip(app, 25_000);
    const back = resumeApp(replaySaved(saved)!, { verified: saved.verified, play: saved.play, ms: saved.ms, now: 100_000 });
    assert.equal(positionKey(back.game), positionKey(app.game));
    assert.equal(back.history.length, app.history.length);
    assert.equal(back.status, 'checking');
    assert.equal(back.play, 'counted');
    assert.equal(playTime(back, 100_000), saved.ms);
    assert.equal(playTime(back, 103_000), saved.ms + 3_000);
    assert.match(back.message, /Welcome back/);
    // Undo walks back all the way to the deal; a restart still knows the deal was winnable.
    let undone = back;
    for (let i = 0; i < app.history.length; i++) undone = press(undone, 'z');
    assert.equal(positionKey(undone.game), positionKey(deal(1)));
    assert.equal(undone.lastWinnable?.game, back.history[0]);
  });

  test('the last winnable position is kept, so after a loss z goes back to it, not to the deal', () => {
    const app = played();
    const at = app.history.length - 1;
    const kept = { ...app, lastWinnable: { game: app.history[at]!, history: app.history.slice(0, at) } };
    const saved = roundTrip(kept);
    assert.equal(saved.winnable, at);
    const back = resumeApp(replaySaved(saved)!, { verified: true, play: saved.play, ms: saved.ms, now: 0, winnable: saved.winnable });
    assert.equal(positionKey(back.lastWinnable!.game), positionKey(app.history[at]!));
    assert.equal(back.lastWinnable!.history.length, at);
    // An older file without it, or a nonsense value, falls back to the deal.
    assert.equal(parseSavedGame({ ...saved, winnable: 999 })!.winnable, undefined);
    const old = resumeApp(replaySaved(saved)!, { verified: true, play: saved.play, ms: 0, now: 0 });
    assert.equal(old.lastWinnable!.history.length, 0);
  });

  test('an untouched deal resumes as it was, not counted', () => {
    const saved = roundTrip(createApp(deal(7), { verified: true }));
    assert.deepEqual(saved.steps, []);
    const back = resumeApp(replaySaved(saved)!, { verified: true, play: saved.play, ms: 0, now: 0 });
    assert.equal(back.play, 'fresh');
    assert.equal(back.status, 'winnable');
    assert.equal(back.startedAt, undefined);
  });

  test('a finished game is not kept', () => {
    assert.equal(snapshot({ ...played(), finishedAt: 30_000 }, 40_000), undefined);
  });

  test('damaged files and illegal steps mean there is no game to resume', () => {
    for (const junk of [null, 3, {}, { version: 2 }, { version: 1, seed: 1, drawMode: 2, redeals: 3, play: 'fresh', steps: [] }]) {
      assert.equal(parseSavedGame(junk), undefined);
    }
    const saved = roundTrip(played());
    const bad = parseSavedGame({ ...saved, steps: [{ from: { kind: 'tableau', index: 0 }, to: { kind: 'tableau', index: 6 }, count: 1 }] })!;
    assert.ok(bad, 'well formed');
    assert.equal(replaySaved(bad), undefined, 'but not legal');
    assert.equal(parseSavedGame({ ...saved, steps: [{ from: { kind: 'tableau', index: 9 }, to: { kind: 'waste' }, count: 1 }] }), undefined);
    // No limit on redeals survives JSON as null.
    const unlimited = roundTrip(createApp(deal(1, 1, Infinity)));
    assert.equal(unlimited.redeals, null);
    assert.equal(replaySaved(unlimited)![0]!.redealsLeft, Infinity);
  });

  test('files: written whole, read back, removed; a missing one is no game', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soli-'));
    try {
      const path = join(dir, 'sub', 'current.json');
      assert.equal(loadSavedGame(path), undefined);
      const snap = snapshot(played(), 20_000)!;
      assert.equal(writeSavedGame(path, snap), true);
      assert.deepEqual(loadSavedGame(path), JSON.parse(readFileSync(path, 'utf8')));
      removeSavedGame(path);
      assert.equal(existsSync(path), false);
      removeSavedGame(path); // already gone: fine
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the file sits next to the statistics unless SOLITERMINAL_GAME says otherwise', () => {
    assert.equal(savedGamePath({}, '/s/soliterminal/stats.json'), '/s/soliterminal/current.json');
    assert.equal(savedGamePath({ SOLITERMINAL_GAME: '/x/g.json' }, '/s/stats.json'), '/x/g.json');
  });

  test('the game keeps its name and start, so it is counted once wherever it ends', () => {
    const app = played();
    const saved = roundTrip(app);
    assert.equal(saved.id, app.gameId);
    assert.equal(saved.at, app.gameAt);
    const back = resumeApp(replaySaved(saved)!, { verified: saved.verified, play: saved.play, ms: saved.ms, now: 100_000, gameId: saved.id, gameAt: saved.at! });
    assert.deepEqual([back.gameId, back.gameAt], [app.gameId, app.gameAt]);
    // A version 1 file (with the process that wrote it) still reads, under a fresh name.
    const v1 = parseSavedGame({ ...saved, version: 1, pid: 1234, id: undefined })!;
    assert.match(v1.id, /^[0-9a-f]{16}$/);
    assert.equal('pid' in v1, false);
  });

  test('a game taken back to the deal still keeps its clock', () => {
    const back = resumeApp([deal(1)], { play: 'counted', ms: 42_000, now: 100_000 });
    assert.equal(playTime(back, 100_000), 42_000);
  });
});

describe('a seed asked for while a game is kept', () => {
  const kept = () => {
    const app = played();
    const saved = roundTrip(app);
    const back = resumeApp(replaySaved(saved)!, { verified: true, play: saved.play, ms: saved.ms, now: 100_000, gameId: saved.id, gameAt: saved.at! });
    return { app, back: { ...back, dialog: 'seed' as const, choice: 0, seedOffer: { seed: 42, drawMode: 3 as const } } };
  };

  test('carrying on keeps the game and records nothing', () => {
    const { app, back } = kept();
    assert.match(viewOf(back, 0).dialog!.lines.join(' '), /seed 42, Draw 3.*counts as a loss/);
    for (const keys of [['enter'], ['escape']]) {
      const on = press(back, ...keys);
      assert.equal(on.dialog, undefined);
      assert.equal(positionKey(on.game), positionKey(app.game));
      assert.equal(on.outbox.length, 0);
    }
  });

  test('giving it up records a loss and deals the seed', () => {
    const { app, back } = kept();
    const next = press(back, 'down', 'enter');
    assert.deepEqual([next.game.seed, next.game.drawMode, next.game.moves], [42, 3, 0]);
    assert.deepEqual(next.outbox.map((e) => ('game' in e ? [e.game.id, e.game.result] : [])), [[app.gameId, 'lost']]);
  });
});
