/**
 * Runs the solver off the main thread so the screen never freezes while it
 * thinks. Requests are handled one at a time, in order.
 */
import { parentPort } from 'node:worker_threads';
import { randomSeed } from './core/deck.ts';
import type { DrawMode, KlondikeState } from './core/klondike.ts';
import { type Level, type SolverMove, type Verdict, findWinnableSeed, judge, judgeDeeply, rateDeal } from './core/solver.ts';

export type WorkerRequest =
  | { readonly id: number; readonly type: 'judge'; readonly state: KlondikeState; readonly deep?: boolean }
  | { readonly id: number; readonly type: 'deal'; readonly drawMode: DrawMode; readonly redeals: number }
  | { readonly id: number; readonly type: 'rate'; readonly state: KlondikeState };

export type WorkerResponse =
  | { readonly id: number; readonly type: 'judge'; readonly verdict: Verdict; readonly next?: SolverMove }
  | { readonly id: number; readonly type: 'deal'; readonly seed: number | undefined }
  | { readonly id: number; readonly type: 'rate'; readonly level: Level };

parentPort!.on('message', (req: WorkerRequest) => {
  let res: WorkerResponse;
  if (req.type === 'judge') {
    const { verdict, next } = (req.deep ? judgeDeeply : judge)(req.state);
    res = { id: req.id, type: 'judge', verdict, next };
  } else if (req.type === 'rate') {
    res = { id: req.id, type: 'rate', level: rateDeal(req.state).level };
  } else {
    res = { id: req.id, type: 'deal', seed: findWinnableSeed(req.drawMode, randomSeed, { redeals: req.redeals }) };
  }
  parentPort!.postMessage(res);
});
