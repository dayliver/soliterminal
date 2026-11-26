import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp, handleKey, playTime, resumeApp } from '../src/app.ts';
import { deal, positionKey } from '../src/core/klondike.ts';
import {
  loadSavedGame,
  ownedElsewhere,
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
const played = () => press(createApp(deal(1), { verified: true }), 'w', 'w', '`', '`', '`', 'z', 'y', 'y', '`');
/** Through JSON and back, as the file does it. */
const roundTrip = (app: App, now = 20_000) => parseSavedGame(JSON.parse(JSON.stringify(snapshot(app, now, 1234))))!;

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
    const app = press(createApp(deal(1)), 'w', 'w');
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

  test('a game written by another live process is left to it', () => {
    const saved = roundTrip(played());
    assert.equal(ownedElsewhere({ ...saved, pid: process.pid }), false); // ours
    assert.equal(ownedElsewhere({ ...saved, pid: process.ppid }), true); // alive, someone else
    assert.equal(ownedElsewhere({ ...saved, pid: 0 }), false);
    assert.equal(ownedElsewhere({ ...saved, pid: 2 ** 22 + 1 }), false); // beyond any real pid: gone
  });
});
