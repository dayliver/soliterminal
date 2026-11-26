import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type KlondikeState, deal, draw, isWon } from '../src/core/klondike.ts';
import { isSolvable, rateDeal, reachablePositions, replay, solve } from '../src/core/solver.ts';
import { board } from './helpers.ts';

const FAST = { maxNodes: 20_000, timeLimitMs: 2_000 };

function solvedSeeds(drawMode: 1 | 3, want: number): number[] {
  const seeds: number[] = [];
  for (let seed = 1; seeds.length < want && seed <= 40; seed++) {
    if (solve(deal(seed, drawMode), FAST).status === 'solved') seeds.push(seed);
  }
  return seeds;
}

describe('talon reach', () => {
  test('Draw 1 can reach every card', () => {
    assert.deepEqual(reachablePositions(4, 0, 1).sort(), [1, 2, 3, 4]);
    assert.deepEqual(reachablePositions(4, 2, 1).sort(), [1, 2, 3, 4]);
    assert.deepEqual(reachablePositions(0, 0, 1), []);
  });

  test('Draw 3 reaches every third card, the last card, and wraps around', () => {
    assert.deepEqual(reachablePositions(8, 0, 3).sort(), [3, 6, 8]);
    // From 1 turned: 1, 4, 7, 8, then after recycling 3 and 6.
    assert.deepEqual(reachablePositions(8, 1, 3).sort(), [1, 3, 4, 6, 7, 8]);
  });
});

describe('solve', () => {
  test('solutions for real deals replay to a win under the game rules', () => {
    for (const drawMode of [1, 3] as const) {
      const seeds = solvedSeeds(drawMode, 6);
      assert.ok(seeds.length >= 6, `only ${seeds.length} Draw ${drawMode} deals solved`);
      for (const seed of seeds) {
        const start = deal(seed, drawMode);
        const r = solve(start, FAST);
        assert.equal(r.status, 'solved');
        if (r.status === 'solved') assert.equal(isWon(replay(start, r.moves)), true, `seed ${seed}`);
      }
    }
  });

  test('solves from the middle of a game, foundations in any order', () => {
    const seed = solvedSeeds(1, 1)[0]!;
    // Play part of the solution, then ask again from there.
    const start = deal(seed, 1);
    const full = solve(start, FAST);
    assert.equal(full.status, 'solved');
    if (full.status !== 'solved') return;
    const midway = replay(start, full.moves.slice(0, Math.floor(full.moves.length / 2)));
    const rest = isSolvable(midway, FAST);
    assert.equal(rest.status, 'solved');
  });

  test('a board missing cards is never claimed won', () => {
    // Diamonds sit on the second foundation; with most of the deck absent there is no win.
    const r = solve(board({ foundations: [, 'AD'], waste: '2D', tableau: ['| AS'] }), FAST);
    assert.notEqual(r.status, 'solved');
  });

  test('a blocked position is reported unsolvable', () => {
    // The two of spades sits on its own ace, and only a king can move.
    const r = solve(board({ tableau: ['AS 2S | KH'] }), FAST);
    assert.equal(r.status, 'unsolvable');
  });

  test('a tiny budget reports unknown instead of guessing', () => {
    const r = solve(deal(3, 1), { maxNodes: 5 });
    assert.equal(r.status, 'unknown');
  });

  test('a finished endgame needs no search', () => {
    const s = board({
      foundations: ['AS 2S 3S 4S 5S 6S 7S 8S 9S XS JS QS', 'AH 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH KH', 'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD', 'AC 2C 3C 4C 5C 6C 7C 8C 9C XC JC QC KC'],
      tableau: ['| KS'],
    });
    const r = solve(s);
    assert.equal(r.status, 'solved');
    if (r.status === 'solved') assert.equal(r.moves.length, 1);
  });
});

describe('replay', () => {
  test('refuses a move the rules do not allow', () => {
    const s: KlondikeState = board({ tableau: ['| 9H', '| 9S'] });
    assert.throws(
      () => replay(s, [{ from: { kind: 'tableau', index: 1 }, to: { kind: 'tableau', index: 0 }, card: { suit: 'S', rank: 9 }, count: 1 }]),
      /Solution step failed/,
    );
  });

  test('draws until the wanted talon card is on top', () => {
    let s = board({ stock: 'KS 5D 7H', tableau: ['| 8S'] });
    s = replay(s, [{ from: { kind: 'talon' }, to: { kind: 'tableau', index: 0 }, card: { suit: 'H', rank: 7 }, count: 1 }]);
    assert.equal(s.tableau[0]!.up.length, 2);
    // Already on top: no extra draw.
    const ready = draw(board({ stock: '7H', tableau: ['| 8S'] }));
    assert.ok(ready.ok);
    if (!ready.ok) return;
    const after = replay(ready.state, [{ from: { kind: 'talon' }, to: { kind: 'tableau', index: 0 }, card: { suit: 'H', rank: 7 }, count: 1 }]);
    assert.equal(after.moves, ready.state.moves + 1);
  });
});

describe('judge and dealing', () => {
  test('says winnable for a solvable deal and lost only with an exhaustive proof', async () => {
    const { judge } = await import('../src/core/solver.ts');
    const won = judge(deal(solvedSeeds(1, 1)[0]!, 1));
    assert.equal(won.verdict, 'winnable');
    assert.ok(won.next, 'a win comes with its first move, for hints');
    assert.equal(judge(board({ tableau: ['AS 2S | KH'] })).verdict, 'lost');
    // A budget too small to decide anything is honest about it.
    assert.equal(judge(deal(3, 1), { quick: { maxNodes: 5 } }).verdict, 'unclear');
  });

  test('findWinnableSeed only returns deals that replay to a win', async () => {
    const { findWinnableSeed } = await import('../src/core/solver.ts');
    let n = 1;
    for (const drawMode of [1, 3] as const) {
      const seed = findWinnableSeed(drawMode, () => n++);
      assert.ok(seed !== undefined);
      const r = solve(deal(seed, drawMode), FAST);
      assert.equal(r.status, 'solved');
      if (r.status === 'solved') assert.equal(isWon(replay(deal(seed, drawMode), r.moves)), true);
    }
  });
});

describe('redeal limit', () => {
  // Everything is home but the clubs from 2 up. 2♣ lies under 3♣ in the waste,
  // so it can only be reached by turning the waste over once.
  const endgame = (redealsLeft: number) =>
    board({
      waste: '2C 3C',
      foundations: [
        'AS 2S 3S 4S 5S 6S 7S 8S 9S XS JS QS KS',
        'AH 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH KH',
        'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD',
        'AC',
      ],
      tableau: ['| KC QC JC XC 9C 8C 7C 6C 5C 4C'],
      redealsLeft,
    });

  test('a card behind the pointer needs a redeal to reach', () => {
    assert.deepEqual(reachablePositions(5, 5, 1), [5, 1, 2, 3, 4]);
    assert.deepEqual(reachablePositions(5, 5, 1, 0), [5]);
    assert.deepEqual(reachablePositions(5, 2, 1, 0), [2, 3, 4, 5]);
  });

  test('with no redeal left the position is lost; with one it is won', () => {
    assert.equal(isSolvable(endgame(0), { exhaustive: true }).status, 'unsolvable');
    const r = isSolvable(endgame(1));
    assert.equal(r.status, 'solved');
    assert.ok(r.status === 'solved' && isWon(replay(endgame(1), r.moves)));
  });

  test('solutions for real deals stay within three redeals', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const drawMode of [1, 3] as const) {
        const s = deal(seed, drawMode, 3);
        const r = isSolvable(s, { maxNodes: 20_000, timeLimitMs: 500 });
        if (r.status === 'solved') assert.ok(isWon(replay(s, r.moves)), `seed ${seed} draw ${drawMode}`);
      }
    }
  });
});

describe('rating a deal', () => {
  test('an easy deal rates easy, the same every time; an unwinnable one cannot be rated', () => {
    const easy = rateDeal(deal(3291647763, 1, 3));
    assert.equal(easy.level, 1);
    assert.deepEqual(rateDeal(deal(3291647763, 1, 3)), easy);
    // Aces under a king that cannot move: no win, so no rating.
    const stuck = board({ tableau: ['AS 2S | KH'] });
    assert.deepEqual(rateDeal(stuck), { level: 0, traps: 0, forced: 0 });
  });
});
