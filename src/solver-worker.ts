/**
 * Runs the solver off the main thread so the screen never freezes while it
 * thinks. Requests are handled one at a time, in order.
 */
import { parentPort } from 'node:worker_threads';
import { randomSeed } from './core/deck.ts';
import type { DrawMode, KlondikeState } from './core/klondike.ts';
import { type Level, type SolverMove, type Verdict, findWinnableSeed, judge, judgeDeeply, limitMemory, rateDeal } from './core/solver.ts';
import { installWasmEngine } from './solver-wasm.ts';

installWasmEngine();

/**
 * Bun, which the standalone binaries run on, ignores a worker's heap limit, so
 * there the search itself stops once the whole process uses this much.
 */
const BUN_PROCESS_MEMORY = 2 * 1024 ** 3;
if (process.versions.bun) limitMemory(() => process.memoryUsage.rss() > BUN_PROCESS_MEMORY);

export type WorkerRequest =
  | { readonly type: 'judge'; readonly state: KlondikeState; readonly deep: boolean }
  | { readonly type: 'deal'; readonly drawMode: DrawMode; readonly redeals: number }
  | { readonly type: 'rate'; readonly state: KlondikeState };

/** The answer to a request of each type. */
export interface WorkerAnswer {
  readonly judge: { readonly verdict: Verdict; readonly next?: SolverMove };
  readonly deal: number | undefined;
  readonly rate: Level;
}

function answer(req: WorkerRequest): WorkerAnswer[WorkerRequest['type']] {
  switch (req.type) {
    case 'judge': {
      const { verdict, next } = (req.deep ? judgeDeeply : judge)(req.state);
      return { verdict, next };
    }
    case 'rate':
      return rateDeal(req.state).level;
    case 'deal':
      return findWinnableSeed(req.drawMode, randomSeed, { redeals: req.redeals });
  }
}

parentPort!.on('message', (req: WorkerRequest) => parentPort!.postMessage({ answer: answer(req) }));
