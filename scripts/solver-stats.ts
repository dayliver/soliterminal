/**
 * Measures how many deals the solver can decide and how fast.
 *
 *   node scripts/solver-stats.ts [--count 200] [--draw 1|3] [--nodes 300000] [--ms 5000] [--from 1] [--redeals 3|unlimited] [--js]
 *
 * `--js` measures the TypeScript search instead of the WebAssembly engine.
 */
import { parseArgs } from 'node:util';
import { deal } from '../src/core/klondike.ts';
import { isSolvable } from '../src/core/solver.ts';
import { installWasmEngine } from '../src/solver-wasm.ts';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '200' },
    draw: { type: 'string', default: '1' },
    nodes: { type: 'string', default: '300000' },
    ms: { type: 'string', default: '5000' },
    from: { type: 'string', default: '1' },
    redeals: { type: 'string', default: '3' },
    js: { type: 'boolean', default: false },
  },
});

if (!values.js && !installWasmEngine()) throw new Error('src/solver.wasm could not be loaded: npm run build:wasm');

const count = Number(values.count);
const first = Number(values.from);
const drawMode = values.draw === '3' ? 3 : 1;
const tally = { solved: 0, unsolvable: 0, unknown: 0 };
const times: number[] = [];
const solvedTimes: number[] = [];
const started = Date.now();
const redeals = values.redeals === 'unlimited' ? Infinity : Number(values.redeals);
for (let seed = first; seed < first + count; seed++) {
  const r = isSolvable(deal(seed, drawMode, redeals), { maxNodes: Number(values.nodes), timeLimitMs: Number(values.ms) });
  tally[r.status]++;
  times.push(r.ms);
  if (r.status === 'solved') solvedTimes.push(r.ms);
}
times.sort((a, b) => a - b);
solvedTimes.sort((a, b) => a - b);
const pct = (n: number) => `${((100 * n) / count).toFixed(1)}%`;
const q = (p: number, xs = times) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
console.log(`Draw ${drawMode}, seeds ${first}..${first + count - 1}, ${values.js ? 'TypeScript' : 'WebAssembly'} search`);
console.log(`solved ${tally.solved} (${pct(tally.solved)})  unsolvable ${tally.unsolvable} (${pct(tally.unsolvable)})  unknown ${tally.unknown} (${pct(tally.unknown)})`);
console.log(`time per deal: median ${q(0.5)}ms  p90 ${q(0.9)}ms  p99 ${q(0.99)}ms  max ${times.at(-1)}ms  total ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`solved deals only: median ${q(0.5, solvedTimes)}ms  p90 ${q(0.9, solvedTimes)}ms  p99 ${q(0.99, solvedTimes)}ms  max ${solvedTimes.at(-1)}ms`);
