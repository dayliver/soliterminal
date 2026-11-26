import { Worker } from 'node:worker_threads';
import type { DrawMode, KlondikeState } from './core/klondike.ts';
import type { Level, SolverMove, Verdict } from './core/solver.ts';
import type { WorkerRequest, WorkerResponse } from './solver-worker.ts';

type Job =
  | { readonly type: 'judge'; readonly state: KlondikeState; readonly deep: boolean; readonly done: (v: Verdict, next?: SolverMove) => void }
  | { readonly type: 'deal'; readonly drawMode: DrawMode; readonly redeals: number; readonly done: (seed: number | undefined) => void }
  | { readonly type: 'rate'; readonly state: KlondikeState; readonly done: (level: Level) => void };

/** One solver worker and the jobs waiting for it, run one at a time. */
class Lane {
  #worker: Worker | undefined;
  #queue: Job[] = [];
  #running: Job | undefined;
  #nextId = 1;

  get busy(): boolean {
    return this.#running !== undefined;
  }

  /** Adds a job. `replace` drops waiting jobs of the same type first, so only the newest is done. */
  add(job: Job, front: boolean, replace: boolean): void {
    if (replace) this.#queue = this.#queue.filter((j) => j.type !== job.type);
    if (front) this.#queue.unshift(job);
    else this.#queue.push(job);
    this.#pump();
  }

  /** Drops everything, stopping the job in progress. Its answer never arrives. */
  cancel(): void {
    this.#queue = [];
    if (this.#running) {
      this.#running = undefined;
      void this.#worker?.terminate();
      this.#worker = undefined;
    }
  }

  close(): Promise<number> {
    this.#queue = [];
    return this.#worker?.terminate() ?? Promise.resolve(0);
  }

  #start(): Worker {
    // From source this file is .ts; in the published package it is compiled .js.
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const worker = new Worker(new URL(`./solver-worker${ext}`, import.meta.url));
    worker.unref();
    worker.on('message', (res: WorkerResponse) => {
      if (worker !== this.#worker) return; // cancelled
      const job = this.#running;
      this.#running = undefined;
      if (job?.type === 'judge' && res.type === 'judge') job.done(res.verdict, res.next);
      if (job?.type === 'deal' && res.type === 'deal') job.done(res.seed);
      if (job?.type === 'rate' && res.type === 'rate') job.done(res.level);
      this.#pump();
    });
    return worker;
  }

  #pump(): void {
    if (this.#running || this.#queue.length === 0) return;
    const job = this.#queue.shift()!;
    this.#running = job;
    this.#worker ??= this.#start();
    const id = this.#nextId++;
    const req: WorkerRequest =
      job.type === 'judge'
        ? { id, type: 'judge', state: job.state, deep: job.deep }
        : job.type === 'rate'
          ? { id, type: 'rate', state: job.state }
          : { id, type: 'deal', drawMode: job.drawMode, redeals: job.redeals };
    this.#worker.postMessage(req);
  }
}

/**
 * Talks to the solver workers. One judges each new position quickly and finds
 * deals; only the newest position is worth judging, so a waiting judge request
 * is replaced by a newer one. The second takes the long looks at positions the
 * quick judge could not settle, so those never hold up the quick ones. The
 * third looks one move ahead while the player thinks.
 */
export class SolverClient {
  #main = new Lane();
  #deep = new Lane();
  #ahead = new Lane();
  #rate = new Lane();

  /**
   * Resolves with the verdict, and with `winnable` the first move of a win,
   * or never if a newer position replaced this one first.
   */
  judge(state: KlondikeState, done: (v: Verdict, next?: SolverMove) => void): void {
    this.#main.add({ type: 'judge', state, deep: false, done }, true, true);
  }

  /** A long look at one position. Replaces any earlier long look, finished or not. */
  judgeDeeply(state: KlondikeState, done: (v: Verdict) => void): void {
    this.#deep.cancel();
    this.#deep.add({ type: 'judge', state, deep: true, done }, true, true);
  }

  /** Stops the long look, if one is running; its answer will not arrive. */
  cancelDeep(): void {
    this.#deep.cancel();
  }

  /** Queues a look at a position the player could move to next; quick ones first. */
  lookAhead(state: KlondikeState, deep: boolean, done: (v: Verdict, next?: SolverMove) => void): void {
    this.#ahead.add({ type: 'judge', state, deep, done }, false, false);
  }

  /** Drops every look ahead: the player has moved and they no longer apply. */
  cancelAhead(): void {
    this.#ahead.cancel();
  }

  /** A seed whose deal, with `redeals` allowed, the solver has won. */
  deal(drawMode: DrawMode, redeals: number, done: (seed: number | undefined) => void): void {
    this.#main.add({ type: 'deal', drawMode, redeals, done }, false, false);
  }

  /** Rates a finished deal on a worker of its own, so play never waits for it. */
  rate(state: KlondikeState, done: (level: Level) => void): void {
    this.#rate.add({ type: 'rate', state, done }, false, false);
  }

  async close(): Promise<void> {
    await Promise.all([this.#main.close(), this.#deep.close(), this.#ahead.close(), this.#rate.close()]);
  }
}
