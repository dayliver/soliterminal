import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, handleKey, viewOf } from '../src/app.ts';
import { deal } from '../src/core/klondike.ts';
import { EMPTY_STATS, type GameRecord, type Stats, parseStats } from '../src/stats.ts';
import { acceptShare, declineShare, finishedGames, markShared, shareDue, sharePayload, unsent } from '../src/share.ts';

/** `n` finished games, oldest first in time (the list itself is newest first). */
function played(n: number, from = 0): GameRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const k = from + n - 1 - i;
    return { seed: k, drawMode: 1, result: k % 3 === 0 ? 'lost' : 'won', ms: 60_000 + k, moves: 100, at: Date.UTC(2026, 10, 1) + k * 60_000, limit: 3, ...(k % 3 === 0 ? { lostAt: 50, level: 2 } : { redeals: 1 }) } as GameRecord;
  });
}
const stats = (games: GameRecord[], share?: Stats['share']): Stats => ({ games, ...(share ? { share } : {}) });

describe('sharing results', () => {
  test('asked only once a thousand games are finished; a game in progress does not count', () => {
    assert.equal(shareDue(stats(played(999))), false);
    const playing: GameRecord = { seed: 5000, drawMode: 1, result: 'playing', ms: 0, moves: 0, at: 1 };
    assert.equal(shareDue(stats([playing, ...played(999)])), false);
    assert.equal(shareDue(stats(played(1000))), true);
  });

  test('no means ask again at the next thousand, and then all of them go', () => {
    let s = declineShare(stats(played(1000)));
    assert.equal(s.share!.asked, 1000);
    assert.equal(shareDue(s), false);
    s = { ...s, games: [...played(999, 1000), ...s.games] };
    assert.equal(shareDue(s), false); // 1,999
    s = { ...s, games: [...played(1, 1999), ...s.games] };
    assert.equal(shareDue(s), true); // 2,000
    s = acceptShare(s);
    const batch = sharePayload(s, 'soliterminal/test')!;
    assert.equal(batch.payload.games.length, 2000);
    assert.equal(batch.payload.games[0]!.seed, 0); // oldest first
  });

  test('yes sends what has not gone yet; once through it is marked, and the next batch is the next thousand', () => {
    let s = acceptShare(stats(played(1000)));
    assert.equal(shareDue(s), false); // agreed: no second question while it waits
    const batch = sharePayload(s, 'soliterminal/test')!;
    s = markShared(s, batch.games);
    assert.deepEqual([s.share!.sent, s.share!.pending, unsent(s).length], [1000, false, 0]);
    assert.equal(sharePayload(s, 'x'), undefined); // nothing agreed, nothing sent
    s = { ...s, games: [...played(1000, 1000), ...s.games] };
    assert.equal(finishedGames(s), 2000);
    assert.equal(shareDue(s), true);
    assert.equal(sharePayload(acceptShare(s), 'x')!.payload.games.length, 1000);
    // The state survives the file.
    assert.deepEqual(parseStats(JSON.parse(JSON.stringify(s))), s);
  });

  test('a batch is never smaller than a thousand, even if agreed', () => {
    const s = acceptShare(stats(played(500)));
    assert.equal(sharePayload(s, 'x'), undefined);
  });

  test('only the deal and how it went are sent, with the day but not the time', () => {
    const { payload } = sharePayload(acceptShare(stats(played(1000))), 'soliterminal/1.0')!;
    assert.match(payload.id, /^[0-9a-f-]{36}$/);
    assert.equal(payload.client, 'soliterminal/1.0');
    assert.deepEqual(Object.keys(payload).sort(), ['client', 'games', 'id', 'v']);
    assert.deepEqual(payload.games[0], { seed: 0, draw: 1, limit: 3, result: 'lost', ms: 60_000, moves: 100, lostAt: 50, level: 2, day: '2026-11-01' });
    assert.deepEqual(payload.games[1], { seed: 1, draw: 1, limit: 3, result: 'won', ms: 60_001, moves: 100, redeals: 1, day: '2026-11-01' });
  });

  test('the question comes between games, only when a server is set up', () => {
    const s = stats(played(1000));
    const dealer = () => ({ seed: 9, verified: true });
    const fresh = (canShare: boolean) => createApp(deal(1), { verified: true, stats: s, canShare });
    // A new deal brings it up; without a server, never.
    const asked = handleKey(fresh(true), 'n', 0, dealer);
    assert.equal(asked.dialog, 'share');
    assert.match(viewOf(asked, 0).dialog!.title, /1,000 games played!/);
    assert.equal(handleKey(fresh(false), 'n', 0, dealer).dialog, undefined);
    const yes = handleKey(asked, 'y', 0, dealer);
    assert.equal(yes.stats.share!.pending, true);
    const no = handleKey(asked, 'n', 0, dealer);
    assert.equal(no.stats.share!.pending, false);
    assert.match(no.message, /asked again at 2,000 games/);
    assert.equal(no.game, asked.game); // n here answers the question, it does not deal again
  });
});

describe('the share server checks batches', async () => {
  const { validateBatch } = (await import('../server/src/validate.js' as string)) as { validateBatch: (b: unknown) => { ok: boolean; status?: number; games?: unknown[] } };
  const good = () => sharePayload(acceptShare(stats(played(1000))), 'soliterminal/1.0')!.payload;

  test('a batch from the game passes', () => {
    const r = validateBatch(JSON.parse(JSON.stringify(good())));
    assert.equal(r.ok, true);
    assert.equal(r.games!.length, 1000);
  });

  test('small batches, odd games and odd ids are turned away', () => {
    const p = good();
    assert.equal(validateBatch({ ...p, games: p.games.slice(0, 999) }).status, 400);
    assert.equal(validateBatch({ ...p, id: 'me@example.com' }).ok, false);
    assert.equal(validateBatch({ ...p, games: [{ ...p.games[0], result: 'maybe' }, ...p.games.slice(1)] }).ok, false);
    assert.equal(validateBatch({ ...p, v: 2 }).ok, false);
    assert.equal(validateBatch(EMPTY_STATS).ok, false);
  });
});
