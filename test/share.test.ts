import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CEREMONY_MS, applyShared, createApp, handleKey, stampDialog, tick, viewOf } from '../src/app.ts';
import { board } from './helpers.ts';
import { deal } from '../src/core/klondike.ts';
import { EMPTY_STATS, type GameRecord, type Stats } from '../src/stats.ts';
import { MAX_BATCH, SHARE_EVERY, acceptShare, declineShare, finishedGames, markShared, shareDue, sharePayload, unsent } from '../src/share.ts';

/** `n` finished games, oldest first in time (the list itself is newest first). */
function played(n: number, from = 0): GameRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const k = from + n - 1 - i;
    return { id: k.toString(16).padStart(8, '0'), seed: k, drawMode: 1, result: k % 3 === 0 ? 'lost' : 'won', ms: 60_000 + k, moves: 100, at: Date.UTC(2026, 10, 1) + k * 60_000, limit: 3, ...(k % 3 === 0 ? { lostAt: 50, level: 2 } : { redeals: 1 }) } as GameRecord;
  });
}
const stats = (games: GameRecord[], share?: Stats['share']): Stats => ({ games, ...(share ? { share } : {}) });
const ids = (games: readonly GameRecord[]) => games.map((g) => g.id);

describe('sharing results', () => {
  test('asked only once a hundred games are finished', () => {
    assert.equal(SHARE_EVERY, 100);
    assert.equal(shareDue(stats(played(99))), false);
    assert.equal(shareDue(stats(played(100))), true);
  });

  test('no means ask again at the next hundred, and then all of them go', () => {
    let s = declineShare(stats(played(100)));
    assert.equal(s.share!.asked, 100);
    assert.equal(shareDue(s), false);
    s = { ...s, games: [...played(99, 100), ...s.games] };
    assert.equal(shareDue(s), false); // 199
    s = { ...s, games: [...played(1, 199), ...s.games] };
    assert.equal(shareDue(s), true); // 200
    s = acceptShare(s);
    const batch = sharePayload(s, 'soliterminal/test')!;
    assert.equal(batch.payload.games.length, 200);
    assert.equal(batch.payload.games[0]!.seed, 0); // oldest first
  });

  test('one batch carries at most a thousand games; the rest wait', () => {
    const s = acceptShare(stats(played(2500)));
    const batch = sharePayload(s, 'x')!;
    assert.equal(batch.payload.games.length, MAX_BATCH);
    assert.equal(batch.payload.games[0]!.seed, 0);
    assert.equal(unsent(markShared(s, ids(batch.games))).length, 1500);
  });

  test('yes sends what has not gone yet; once through it is marked, and the next batch is the next hundred', () => {
    let s = acceptShare(stats(played(100)));
    assert.equal(shareDue(s), false); // agreed: no second question while it waits
    const batch = sharePayload(s, 'soliterminal/test')!;
    s = markShared(s, ids(batch.games));
    assert.deepEqual([s.share!.pending, unsent(s).length], [false, 0]);
    assert.equal(sharePayload(s, 'x'), undefined); // nothing agreed, nothing sent
    s = { ...s, games: [...played(100, 100), ...s.games] };
    assert.equal(finishedGames(s), 200);
    assert.equal(shareDue(s), true);
    assert.equal(sharePayload(acceptShare(s), 'x')!.payload.games.length, 100);
  });

  test('a batch is never smaller than a hundred, even if agreed', () => {
    const s = acceptShare(stats(played(50)));
    assert.equal(sharePayload(s, 'x'), undefined);
  });

  test('only the deal and how it went are sent, with the day but not the time', () => {
    const { payload } = sharePayload(acceptShare(stats(played(100))), 'soliterminal/1.0')!;
    assert.match(payload.id, /^[0-9a-f-]{36}$/);
    assert.equal(payload.client, 'soliterminal/1.0');
    assert.deepEqual(Object.keys(payload).sort(), ['client', 'games', 'id', 'v']);
    assert.deepEqual(payload.games[0], { id: '00000000', seed: 0, draw: 1, limit: 3, result: 'lost', ms: 60_000, moves: 100, lostAt: 50, level: 2, day: '2026-11-01' });
    assert.deepEqual(payload.games[1], { id: '00000001', seed: 1, draw: 1, limit: 3, result: 'won', ms: 60_001, moves: 100, redeals: 1, day: '2026-11-01' });
  });

  test('the question comes after a win, before the results, only when a server is set up', () => {
    const s = stats(played(99)); // the win makes it 100
    const dealer = () => ({ seed: 9, verified: true });
    const endgame = board({
      foundations: ['AS 2S 3S 4S 5S 6S 7S 8S 9S XS JS QS', 'AH 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH KH', 'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD', 'AC 2C 3C 4C 5C 6C 7C 8C 9C XC JC QC KC'],
      tableau: ['| KS'],
    });
    /** Wins, then lets the ceremony run out on its own. */
    const win = (canShare: boolean) => {
      let app = handleKey(createApp(endgame, { verified: true, stats: s, canShare }), 'i', 1_000, dealer); // K♠ home
      assert.ok(app.finishedAt !== undefined);
      app = stampDialog(app, tick(app, app.finishedAt! + CEREMONY_MS), app.finishedAt! + CEREMONY_MS);
      return app;
    };
    const asked = win(true);
    assert.equal(asked.dialog, 'share');
    assert.match(viewOf(asked, 0).dialog!.title, /You won, and that makes 100 games!/);
    assert.ok(viewOf(asked, asked.finishedAt! + CEREMONY_MS + 100).celebration! > 0); // the confetti keeps falling
    assert.equal(win(false).dialog, 'won');
    // A new deal never asks, nor does the start of one.
    const fresh = createApp(deal(1), { verified: true, stats: s, canShare: true });
    assert.equal(['escape', 'down', 'enter'].reduce((a, k, i) => handleKey(a, k, 1_000 * (i + 1), dealer), fresh).dialog, undefined);
    // Straight after it comes up, enter is taken as meant for the board.
    const at = asked.dialogAt!;
    assert.equal(handleKey(asked, 'enter', at + 100, dealer).dialog, 'share');
    for (const yes of ['enter', 'space']) {
      const sent = handleKey(asked, yes, at + 5_000, dealer);
      assert.equal(sent.stats.share!.pending, true, yes);
      assert.equal(sent.dialog, 'won', yes); // then the results
    }
    const no = handleKey(asked, 'escape', at + 5_000, dealer);
    assert.equal(no.stats.share!.pending, false);
    assert.equal(no.dialog, 'won');
    assert.match(no.message, /asked again at 200 games/);
    // Sent: the games are marked, and a line for the log says which.
    const sent = applyShared(handleKey(asked, 'enter', at + 5_000, dealer), ids(s.games));
    assert.equal(unsent(sent.stats).filter((g) => s.games.includes(g)).length, 0);
    assert.deepEqual(sent.outbox.at(-1), { sent: ids(s.games) });
  });
});

describe('the share server checks batches', async () => {
  const { validateBatch } = (await import('../server/src/validate.js' as string)) as { validateBatch: (b: unknown) => { ok: boolean; status?: number; games?: unknown[] } };
  const good = () => sharePayload(acceptShare(stats(played(100))), 'soliterminal/1.0')!.payload;

  test('a batch from the game passes', () => {
    const r = validateBatch(JSON.parse(JSON.stringify(good())));
    assert.equal(r.ok, true);
    assert.equal(r.games!.length, 100);
  });

  test('small batches, odd games and odd ids are turned away', () => {
    const p = good();
    assert.equal(validateBatch({ ...p, games: p.games.slice(0, 99) }).status, 400);
    assert.equal(validateBatch({ ...p, games: [{ ...p.games[0], id: 'x' }, ...p.games.slice(1)] }).ok, false);
    assert.equal(validateBatch({ ...p, id: 'me@example.com' }).ok, false);
    assert.equal(validateBatch({ ...p, games: [{ ...p.games[0], result: 'maybe' }, ...p.games.slice(1)] }).ok, false);
    assert.equal(validateBatch({ ...p, v: 2 }).ok, false);
    assert.equal(validateBatch(EMPTY_STATS).ok, false);
  });
});
