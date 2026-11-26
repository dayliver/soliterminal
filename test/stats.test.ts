import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_STATS, type Stats, eventLine, foldLog, parseLegacyStats, pastGame, recordLoss, recordWin, statsFor, unrated, winRate, withLevel } from '../src/stats.ts';
import { appendStats, loadStats, saveShare, sharePath, statsPath } from '../src/stats-file.ts';

const gid = (seed: number) => seed.toString(16).padStart(8, '0');
const won = (seed: number, redeals = 0) => ({ id: gid(seed), seed, at: seed, redeals });
const lost = (seed: number, extra: object = {}) => ({ id: gid(seed), seed, ms: 5_000, moves: 9, at: seed, ...extra });

describe('stats', () => {
  test('worked out from the games finished, per draw mode', () => {
    let s = recordWin(EMPTY_STATS, 1, 90_000, 120, won(1)).stats;
    s = recordWin(s, 1, 80_000, 130, won(2)).stats;
    s = recordLoss(s, 1, lost(3)).stats;
    const m = statsFor(s, 1);
    assert.deepEqual(m, { played: 3, won: 2, streak: 0, bestStreak: 2, bestMs: 80_000, fewestMoves: 120 });
    assert.equal(winRate(m), 67);
    assert.deepEqual(statsFor(s, 3), statsFor(EMPTY_STATS, 3));
    s = recordWin(s, 1, 1, 1, won(4)).stats;
    assert.deepEqual([statsFor(s, 1).streak, statsFor(s, 1).played], [1, 4]);
  });

  test('a game is counted once, however many times it is finished', () => {
    // The same game played on in two windows: the first to finish it counts.
    let s = recordWin(EMPTY_STATS, 1, 9, 9, won(1)).stats;
    s = recordLoss(s, 1, lost(1)).stats;
    assert.deepEqual(s.games.map((g) => g.result), ['won']);
  });

  test('a win reports new records, but not on the very first win', () => {
    const first = recordWin(EMPTY_STATS, 3, 100_000, 100, won(1));
    assert.equal(first.record.bestTime, false);
    const second = recordWin(first.stats, 3, 90_000, 110, won(2, 2));
    assert.deepEqual([second.record.bestTime, second.record.fewestMoves, second.record.redeals], [true, false, 2]);
  });

  test('a loss keeps the redeal limit of the deal and the move that lost it; the level comes later', () => {
    let s = recordLoss(EMPTY_STATS, 1, lost(5, { limit: 3, lostAt: 38 })).stats;
    s = recordLoss(s, 1, lost(6, { limit: Infinity })).stats; // given up
    assert.deepEqual(s.games.map((g) => [g.seed, g.limit, g.lostAt]), [[6, null, undefined], [5, 3, 38]]);
    const first = unrated(s)!;
    assert.equal(first.seed, 6); // newest first
    s = withLevel(s, first.id, 2);
    assert.equal(unrated(s)!.seed, 5);
    s = withLevel(s, unrated(s)!.id, 0);
    assert.equal(unrated(s), undefined);
    assert.equal(pastGame(s, 5, 1, 'lost')?.lostAt, 38);
    assert.equal(pastGame(s, 5, 3, 'lost'), undefined); // the other draw mode is another deal
  });
});

describe('the statistics log', () => {
  const sample = (): { lines: string; stats: Stats } => {
    const w = recordWin(EMPTY_STATS, 1, 90_000, 120, won(7, 2));
    const l = recordLoss(w.stats, 3, lost(8, { lostAt: 4 }));
    const lines = eventLine({ game: w.game }) + eventLine({ game: l.game }) + eventLine({ level: { id: gid(8), level: 3 } }) + eventLine({ sent: [gid(7)] });
    return { lines, stats: l.stats };
  };

  test('folds into the games, newest first, with levels and sent marks applied', () => {
    const s = foldLog(sample().lines);
    assert.deepEqual(s.games.map((g) => [g.seed, g.result, g.level, g.sent]), [[8, 'lost', 3, undefined], [7, 'won', undefined, true]]);
  });

  test('skips damaged lines and counts a game finished twice once', () => {
    const { lines } = sample();
    const again = eventLine({ game: { id: gid(7), seed: 7, drawMode: 1, result: 'lost', ms: 1, moves: 1, at: 7 } });
    const s = foldLog('{ not json\n' + lines + again + '{"game":{"seed":1}}\n' + '{"game":{"id":"00');
    assert.deepEqual(s.games.map((g) => [g.seed, g.result]), [[8, 'lost'], [7, 'won']]);
  });

  test('lives in the usual state folder for each platform', () => {
    assert.equal(statsPath({}, 'linux', '/home/a'), '/home/a/.local/state/soliterminal/games.jsonl');
    assert.equal(statsPath({ XDG_STATE_HOME: '/x' }, 'linux', '/home/a'), '/x/soliterminal/games.jsonl');
    assert.equal(statsPath({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U'), join('C:\\L', 'soliterminal', 'games.jsonl'));
    assert.equal(statsPath({ SOLITERMINAL_STATS: '/tmp/s.jsonl' }, 'linux'), '/tmp/s.jsonl');
  });

  test('two windows appending at once both keep their games', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soliterminal-'));
    try {
      const path = join(dir, 'a', 'b', 'games.jsonl');
      assert.deepEqual(loadStats(path), EMPTY_STATS);
      // Both start from an empty record, and each appends its own game.
      const a = recordWin(loadStats(path), 1, 1000, 50, won(1));
      const b = recordLoss(loadStats(path), 1, lost(2));
      assert.equal(appendStats(path, [{ game: a.game }]), true);
      assert.equal(appendStats(path, [{ game: b.game }]), true);
      assert.deepEqual(loadStats(path).games.map((g) => g.seed), [2, 1]);
      // A write cut short does not swallow the next line.
      appendFileSync(path, '{"game":{"id":"0000');
      appendStats(path, [{ level: { id: gid(2), level: 1 } }]);
      assert.equal(loadStats(path).games[0]!.level, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the share state is a file of its own next to the log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soliterminal-'));
    try {
      const path = join(dir, 'games.jsonl');
      const share = { id: '0b7c2b8e-6f1a-4d3e-9c55-2f0e8a1b3c4d', asked: 100, pending: true };
      assert.equal(saveShare(path, share), true);
      assert.deepEqual(loadStats(path), { games: [], share });
      writeFileSync(sharePath(path), '{ broken');
      assert.deepEqual(loadStats(path), EMPTY_STATS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an earlier version's stats.json moves into the log once, unfinished games left out", () => {
    const dir = mkdtempSync(join(tmpdir(), 'soliterminal-'));
    try {
      const share = { id: '0b7c2b8e-6f1a-4d3e-9c55-2f0e8a1b3c4d', sent: 0, asked: 0, pending: false };
      const old = {
        games: [
          { seed: 3, drawMode: 1, result: 'playing', ms: 0, moves: 0, at: 30 },
          { seed: 2, drawMode: 1, result: 'lost', ms: 9, moves: 9, at: 20, level: 2 },
          { seed: 1, drawMode: 3, result: 'won', ms: 8, moves: 8, at: 10, redeals: 1, sent: true },
        ],
        share,
      };
      writeFileSync(join(dir, 'stats.json'), JSON.stringify(old));
      const path = join(dir, 'games.jsonl');
      const s = loadStats(path);
      assert.deepEqual(s.games.map((g) => [g.seed, g.result, g.level, g.sent]), [[2, 'lost', 2, undefined], [1, 'won', undefined, true]]);
      assert.ok(s.games.every((g) => /^[0-9a-f]{16}$/.test(g.id)));
      assert.deepEqual(s.share, { id: share.id, asked: 0, pending: false });
      assert.ok(existsSync(join(dir, 'stats.json'))); // left where it was
      // Only once: the ids given on the way over stay.
      assert.deepEqual(loadStats(path).games.map((g) => g.id), s.games.map((g) => g.id));
      assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2);
      // Old files with bare counts bring nothing over.
      assert.deepEqual(parseLegacyStats({ draw1: { played: 31, won: 17 } }).games, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
