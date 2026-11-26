import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_STATS, parseStats, pastGame, recordLoss, recordStart, recordWin, statsFor, unrated, winRate, withLevel } from '../src/stats.ts';
import { loadStats, saveStats, statsPath } from '../src/stats-file.ts';

const id = (seed: number, at = seed) => ({ seed, at });
const won = (seed: number, redeals = 0) => ({ seed, at: seed, redeals });

describe('stats', () => {
  test('worked out from the games played, per draw mode', () => {
    let s = recordStart(EMPTY_STATS, 1, id(1));
    s = recordWin(s, 1, 90_000, 120, won(1)).stats;
    s = recordStart(s, 1, id(2));
    s = recordWin(s, 1, 80_000, 130, won(2)).stats;
    s = recordStart(s, 1, id(3));
    s = recordLoss(s, 1, { seed: 3, ms: 5_000, moves: 9, at: 4 });
    const m = statsFor(s, 1);
    assert.deepEqual(m, { played: 3, won: 2, streak: 0, bestStreak: 2, bestMs: 80_000, fewestMoves: 120 });
    assert.equal(winRate(m), 67);
    assert.deepEqual(statsFor(s, 3), statsFor(EMPTY_STATS, 3));
    // A game still being played neither adds to the streak nor breaks it.
    s = recordWin(recordStart(s, 1, id(4)), 1, 1, 1, won(4)).stats;
    s = recordStart(s, 1, id(5));
    assert.deepEqual([statsFor(s, 1).streak, statsFor(s, 1).played], [1, 5]);
  });

  test('a win reports new records, but not on the very first win', () => {
    const first = recordWin(recordStart(EMPTY_STATS, 3, id(1)), 3, 100_000, 100, won(1));
    assert.equal(first.record.bestTime, false);
    const second = recordWin(recordStart(first.stats, 3, id(2)), 3, 90_000, 110, won(2, 2));
    assert.deepEqual([second.record.bestTime, second.record.fewestMoves, second.record.redeals], [true, false, 2]);
  });

  test('old files with bare counts and no games start afresh; odd games are dropped', () => {
    assert.deepEqual(parseStats('nonsense'), EMPTY_STATS);
    assert.deepEqual(parseStats({ draw1: { played: 31, won: 17, streak: 1, bestStreak: 3 } }), EMPTY_STATS);
    const games = [{ seed: -1, drawMode: 1, result: 'won' }, { seed: 3, drawMode: 2, result: 'won' }, 5, { seed: 4, drawMode: 1, result: 'maybe' }];
    assert.deepEqual(parseStats({ games }).games, []);
  });
});

describe('stats file', () => {
  test('lives in the usual state folder for each platform', () => {
    assert.equal(statsPath({}, 'linux', '/home/a'), '/home/a/.local/state/soliterminal/stats.json');
    assert.equal(statsPath({ XDG_STATE_HOME: '/x' }, 'linux', '/home/a'), '/x/soliterminal/stats.json');
    assert.equal(statsPath({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U'), join('C:\\L', 'soliterminal', 'stats.json'));
    assert.equal(statsPath({ SOLITERMINAL_STATS: '/tmp/s.json' }, 'linux'), '/tmp/s.json');
  });

  test('saves and loads, creating folders, and shrugs off a broken file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soliterminal-'));
    try {
      const path = join(dir, 'a', 'b', 'stats.json');
      assert.deepEqual(loadStats(path), EMPTY_STATS);
      const s = recordWin(recordStart(EMPTY_STATS, 1, id(1)), 1, 1000, 50, won(1)).stats;
      assert.equal(saveStats(path, s), true);
      assert.deepEqual(loadStats(path), s);
      assert.match(readFileSync(path, 'utf8'), /"result": "won"/);
      writeFileSync(path, '{ not json');
      assert.deepEqual(loadStats(path), EMPTY_STATS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the games on record', () => {
  test('a game is recorded from its first move and updated when it is won or given up', () => {
    let s = recordStart(EMPTY_STATS, 1, id(7, 1000));
    assert.deepEqual(s.games, [{ seed: 7, drawMode: 1, result: 'playing', ms: 0, moves: 0, at: 1000 }]);
    s = recordWin(s, 1, 90_000, 120, { seed: 7, at: 5000, redeals: 2 }).stats;
    assert.deepEqual(s.games, [{ seed: 7, drawMode: 1, at: 1000, result: 'won', ms: 90_000, moves: 120, redeals: 2 }]);
    s = recordStart(s, 3, id(8, 6000));
    s = recordLoss(s, 3, { seed: 8, ms: 30_000, moves: 40, at: 9000 });
    assert.deepEqual(s.games.map((g) => [g.seed, g.drawMode, g.result, g.ms]), [[8, 3, 'lost', 30_000], [7, 1, 'won', 90_000]]);
    assert.equal(pastGame(s, 8, 3, 'lost')?.at, 6000);
    assert.equal(pastGame(s, 8, 1, 'lost'), undefined); // the other draw mode is another deal
    assert.equal(pastGame(s, 7, 1, 'won')?.redeals, 2);
  });

  test('they survive the file', () => {
    let s = EMPTY_STATS;
    for (let i = 0; i < 40; i++) s = recordStart(s, 1, id(i));
    s = recordWin(s, 1, 9, 9, won(39, 1)).stats;
    assert.equal(s.games.length, 40);
    assert.deepEqual(parseStats(JSON.parse(JSON.stringify(s))), s);
  });

  test('a loss keeps the redeal limit of the deal and the move that lost it; the level comes later', () => {
    let s = recordStart(EMPTY_STATS, 1, { seed: 5, at: 1, limit: 3 });
    s = recordLoss(s, 1, { seed: 5, ms: 9, moves: 40, at: 2, lostAt: 38 });
    s = recordStart(s, 1, { seed: 6, at: 3, limit: Infinity });
    s = recordLoss(s, 1, { seed: 6, ms: 9, moves: 4, at: 4 }); // given up
    assert.deepEqual(s.games.map((g) => [g.seed, g.limit, g.lostAt]), [[6, null, undefined], [5, 3, 38]]);
    const first = unrated(s)!;
    assert.equal(first.seed, 6); // newest first
    s = withLevel(s, first, 2);
    assert.equal(unrated(s)!.seed, 5);
    s = withLevel(s, unrated(s)!, 0);
    assert.equal(unrated(s), undefined);
    assert.deepEqual(parseStats(JSON.parse(JSON.stringify(s))), s);
    // Won games are never rated or marked lost.
    assert.equal(parseStats({ games: [{ seed: 1, drawMode: 1, result: 'won', lostAt: 3, level: 2 }] }).games[0]!.level, undefined);
  });
});
