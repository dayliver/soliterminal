import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type KlondikeState, deal, draw, isWon, positionKey, steps, successors } from '../src/core/klondike.ts';
import { isDeadEnd, isSolvable, rateDeal, reachablePositions, replay, solve } from '../src/core/solver.ts';
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
  // Only the clubs are left. The ace lies under the king in the waste, and the king has nowhere
  // to go: no column is empty, and none can be emptied. Turning the waste over brings the ace up.
  const endgame = (redealsLeft: number) =>
    board({
      waste: 'AC KC',
      foundations: [
        'AS 2S 3S 4S 5S 6S 7S 8S 9S XS JS QS KS',
        'AH 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH KH',
        'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD',
      ],
      tableau: ['QC JC XC 9C | 8C', '| 7C', '| 6C', '| 5C', '| 4C', '| 3C', '| 2C'],
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

describe('losses that are proven', () => {
  test('a king can come back from its foundation when that is the only way on', () => {
    // The queen of hearts covers the jack it needs and the only king left in play; the king of
    // spades, long home, has to come down to the empty column to take her.
    const b = board({
      foundations: ['AS 2S 3S 4S 5S 6S 7S 8S 9S XS JS QS KS', 'AH 2H 3H 4H 5H 6H 7H 8H 9H XH', 'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD', 'AC 2C 3C 4C 5C 6C 7C 8C 9C XC JC QC'],
      tableau: ['JH KC | QH', '| KH'],
    });
    assert.equal(isDeadEnd(b), false);
    const r = isSolvable(b, { exhaustive: true });
    assert.equal(r.status, 'solved');
    assert.ok(r.status === 'solved' && isWon(replay(b, r.moves)));
  });

  const RED = ['AH 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH KH', 'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD'] as const;
  const REST = '4S 5S 6S 7S 8S 9S XS 4C 5C 6C 7C 8C 9C XC JC';

  test('cards that wait for one another are a dead end, seen without searching', () => {
    // Each black 3 lies on the 2 the other needs. The red 4s they could move to are home, under
    // kings that have no empty column to come down to.
    const others = ['| KS', '| KC', '| QS', '| QC', '| JS'];
    const stuck = board({ stock: REST, foundations: ['AS', RED[0], RED[1], 'AC'], tableau: ['2C | 3S', '2S | 3C', ...others] });
    assert.equal(isDeadEnd(stuck), true);
    assert.deepEqual({ ...solve(stuck), ms: 0 }, { status: 'unsolvable', nodes: 1, ms: 0 });
    const fine = board({ stock: REST, foundations: ['AS', RED[0], RED[1], 'AC'], tableau: ['2C | 3S', '3C | 2S', ...others] });
    assert.equal(isDeadEnd(fine), false);
    assert.equal(isSolvable(fine).status, 'solved');
  });

  test('no position on the way to a win is called a dead end', () => {
    let positions = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const drawMode of [1, 3] as const) {
        const start = deal(seed, drawMode);
        const r = solve(start, FAST);
        if (r.status !== 'solved') continue;
        let s = start;
        for (const [i, m] of r.moves.entries()) {
          assert.equal(isDeadEnd(s), false, `seed ${seed}, Draw ${drawMode}, before move ${i}`);
          s = replay(s, [m]);
          positions++;
        }
      }
    }
    assert.ok(positions > 1_000, `${positions} positions`);
  });

  /** Whether a position can be won, from nothing but the rules of the game; undefined when that is too much to try. */
  function bruteForce(start: KlondikeState, limit: number): boolean | undefined {
    const seen = new Set([positionKey(start)]);
    const stack = [start];
    for (let s = stack.pop(); s; s = stack.pop()) {
      if (isWon(s)) return true;
      for (const next of successors(s)) {
        const k = positionKey(next);
        if (seen.has(k)) continue;
        if (seen.size >= limit) return undefined;
        seen.add(k);
        stack.push(next);
      }
    }
    return false;
  }

  test('the exhaustive search agrees with trying every legal move', () => {
    let rng = 1;
    const rand = (n: number) => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff), rng % n);
    const astray = (s: KlondikeState, moves: number) => {
      for (let i = moves; i > 0; i--) {
        const next = steps(s);
        if (next.length === 0) break;
        s = next[rand(next.length)]!.state;
      }
      return s;
    };
    const positions: KlondikeState[] = [];
    // Near the end of a win, then a few random moves: mostly still winnable.
    for (let seed = 1; seed <= 12; seed++) {
      for (const drawMode of [1, 3] as const) {
        const start = deal(seed, drawMode, Infinity);
        const r = solve(start, FAST);
        if (r.status === 'solved') positions.push(astray(replay(start, r.moves.slice(0, r.moves.length - 2 - rand(8))), rand(4)));
      }
    }
    // Random play with no redeal: mostly lost, in a small way.
    for (let seed = 1; seed <= 40; seed++) positions.push(astray(deal(seed, 3, 0), 20 + rand(25)));

    const tally = { won: 0, lost: 0 };
    for (const [i, s] of positions.entries()) {
      const truth = bruteForce(s, 1_500);
      if (truth === undefined) continue;
      assert.equal(isSolvable(s, { exhaustive: true }).status, truth ? 'solved' : 'unsolvable', `position ${i}`);
      if (truth) assert.equal(isDeadEnd(s), false, `position ${i}`);
      else assert.notEqual(isSolvable(s).status, 'solved', `position ${i}`);
      tally[truth ? 'won' : 'lost']++;
    }
    assert.ok(tally.won >= 5 && tally.lost >= 30, JSON.stringify(tally));
  });
});
