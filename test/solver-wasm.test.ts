import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { type KlondikeState, deal, isWon } from '../src/core/klondike.ts';
import { type SolveResult, isSolvable, judge, replay, solve, useEngine } from '../src/core/solver.ts';
import { installWasmEngine, wasmEngine } from '../src/solver-wasm.ts';
import { board } from './helpers.ts';

/** Time never decides here, so both searches stop at the same position. */
const budget = (maxNodes: number, exhaustive = false) => ({ maxNodes, timeLimitMs: 600_000, exhaustive });

function both(state: KlondikeState, options: Parameters<typeof solve>[1]): [SolveResult, SolveResult] {
  useEngine(undefined);
  const reference = solve(state, options);
  assert.equal(installWasmEngine(), true, 'src/solver.wasm did not load: npm run build:wasm');
  return [reference, solve(state, options)];
}

/** Everything but the time taken. */
const answer = (r: SolveResult) => ({ status: r.status, nodes: r.nodes, moves: r.status === 'solved' ? r.moves : undefined });

describe('the WebAssembly search', () => {
  afterEach(() => useEngine(undefined));

  test('gives the answer of the TypeScript search: status, positions visited and every move', () => {
    const seen = { solved: 0, unsolvable: 0, unknown: 0 };
    for (let seed = 1; seed <= 6; seed++) {
      for (const drawMode of [1, 3] as const) {
        for (const redeals of [0, 3, Infinity]) {
          for (const exhaustive of [false, true]) {
            const [reference, wasm] = both(deal(seed, drawMode, redeals), budget(6_000, exhaustive));
            assert.deepEqual(answer(wasm), answer(reference), `seed ${seed}, Draw ${drawMode}, ${redeals} redeals, exhaustive ${exhaustive}`);
            seen[reference.status]++;
          }
        }
      }
    }
    // The deals above must put all three answers to the test.
    assert.ok(seen.solved > 10 && seen.unsolvable > 10 && seen.unknown > 10, JSON.stringify(seen));
  });

  test('agrees on hand-built boards: won at once, blocked, and missing cards', () => {
    const boards = [
      board({ tableau: ['AS 2S | KH'] }),
      board({ tableau: ['| AS'] }),
      board({ foundations: ['AS 2S 3S 4S 5S 6S 7S 8S 9S XS JS QS', 'AH 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH KH', 'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD', 'AC 2C 3C 4C 5C 6C 7C 8C 9C XC JC QC KC'], tableau: ['| KS'] }),
      board({ stock: '3D 2S', waste: 'AS', tableau: ['2D | AD', '| 3S'], redealsLeft: 1 }),
    ];
    for (const [i, b] of boards.entries()) {
      for (const exhaustive of [false, true]) {
        const [reference, wasm] = both(b, budget(5_000, exhaustive));
        assert.deepEqual(answer(wasm), answer(reference), `board ${i}, exhaustive ${exhaustive}`);
      }
    }
  });

  test('its solutions replay to a win under the game rules', () => {
    installWasmEngine();
    let solved = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const drawMode of [1, 3] as const) {
        const start = deal(seed, drawMode);
        const r = isSolvable(start, budget(20_000)); // throws if a solution does not win
        if (r.status !== 'solved') continue;
        assert.equal(isWon(replay(start, r.moves)), true);
        solved++;
      }
    }
    assert.ok(solved >= 10, `only ${solved} deals solved`);
  });

  test('a board too large for it is searched in TypeScript instead', () => {
    let calls = 0;
    const real = wasmEngine(readFileSync(new URL('../src/solver.wasm', import.meta.url)));
    useEngine((...args) => (calls++, real(...args)));
    // Twenty-five cards in the talon: one more than a real game can have.
    const big = board({ stock: '2S 3S 4S 5S 6S 7S 8S 9S XS JS QS KS 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH KH', waste: 'AS', tableau: ['| AH'] });
    assert.notEqual(solve(big, budget(2_000)).status, 'solved');
    assert.equal(calls, 0);
    solve(deal(1, 1), budget(2_000));
    assert.equal(calls, 1);
  });

  test('judges as before: winnable with a move, lost only when proven, unclear on a tiny budget', () => {
    installWasmEngine();
    const won = judge(deal(1, 1));
    assert.equal(won.verdict, 'winnable');
    assert.ok(won.next);
    assert.equal(judge(board({ tableau: ['AS 2S | KH'] })).verdict, 'lost');
    assert.equal(judge(deal(3, 1), { quick: { maxNodes: 5 } }).verdict, 'unclear');
  });

  test('stops at the time limit', () => {
    installWasmEngine();
    const started = Date.now();
    const r = solve(deal(27, 1, Infinity), { maxNodes: 50_000_000, timeLimitMs: 150, exhaustive: true });
    assert.equal(r.status, 'unknown');
    assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started}ms`);
  });
});
