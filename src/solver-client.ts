import { Worker } from 'node:worker_threads';
import type { DrawMode, KlondikeState } from './core/klondike.ts';
import type { Level, SolverMove, Verdict } from './core/solver.ts';
import type { WorkerAnswer, WorkerRequest } from './solver-worker.ts';

/**
 * JavaScript heap for one solver worker, which bounds the TypeScript search.
 * The WebAssembly engine's memory is outside it and has its own limit (see solver-wasm.ts).
 */
const WORKER_MEMORY_MB = 1024;

/** A request and what to do with its answer, which is `undefined` when the worker failed before giving one. */
interface Job {
  readonly req: WorkerRequest;
  readonly done: (answer: unknown) => void;
}

type Type = WorkerRequest['type'];

function job<T extends Type>(req: Extract<WorkerRequest, { type: T }>, done: (answer: WorkerAnswer[T] | undefined) => void): Job {
  return { req, done: done as Job['done'] };
}

type Judged = (v: Verdict, next?: SolverMove) => void;

/** A failed judge job gets the answer that claims nothing, so play goes on as if the solver ran out of time. */
const judging = (state: KlondikeState, deep: boolean, done: Judged): Job =>
  job({ type: 'judge', state, deep }, (a) => done(a?.verdict ?? 'unclear', a?.next));

/** One solver worker and the jobs waiting for it, run one at a time. */
class Lane {
  #worker: Worker | undefined;
  #queue: Job[] = [];
  #running: Job | undefined;
  #closed = false;

  /** Adds a job. `replace` drops waiting jobs of the same type first, so only the newest is done. */
  add(job: Job, front: boolean, replace: boolean): void {
    if (replace) this.#queue = this.#queue.filter((j) => j.req.type !== job.req.type);
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
    this.#closed = true;
    this.#queue = [];
    return this.#worker?.terminate() ?? Promise.resolve(0);
  }

  #start(): Worker {
    // From source this file is .ts; in the published package it is compiled .js.
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    // A search that would take more memory than this ends the worker, not the game.
    const worker = new Worker(new URL(`./solver-worker${ext}`, import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB } });
    worker.unref();
    // An error ends the worker; 'exit' below deals with what it was doing.
    worker.on('error', () => {});
    worker.on('exit', () => {
      if (worker !== this.#worker || this.#closed) return; // cancelled or closed: nobody waits
      this.#worker = undefined;
      this.#finish(undefined);
    });
    worker.on('message', (res: { readonly answer: unknown }) => {
      if (worker === this.#worker) this.#finish(res.answer); // else cancelled
    });
    return worker;
  }

  #finish(answer: unknown): void {
    const job = this.#running;
    this.#running = undefined;
    job?.done(answer);
    this.#pump();
  }

  #pump(): void {
    if (this.#running || this.#queue.length === 0) return;
    this.#running = this.#queue.shift()!;
    this.#worker ??= this.#start();
    this.#worker.postMessage(this.#running.req);
  }
}

/**
 * Talks to the solver workers. One judges each new position quickly and finds
 * deals; only the newest position is worth judging, so a waiting judge request
 * is replaced by a newer one. The second takes the long looks at positions the
 * quick judge could not settle, so those never hold up the quick ones. The
 * third looks one move ahead while the player thinks, and the fourth rates
 * finished deals. A worker that fails is replaced; its job gets an answer that
 * claims nothing (`unclear`, no seed, or level 0).
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
  judge(state: KlondikeState, done: Judged): void {
    this.#main.add(judging(state, false, done), true, true);
  }

  /** A long look at one position. Replaces any earlier long look, finished or not. */
  judgeDeeply(state: KlondikeState, done: (v: Verdict) => void): void {
    this.#deep.cancel();
    this.#deep.add(judging(state, true, done), false, false);
  }

  /** Stops the long look, if one is running; its answer will not arrive. */
  cancelDeep(): void {
    this.#deep.cancel();
  }

  /** Queues a look at a position the player could move to next; quick ones first. */
  lookAhead(state: KlondikeState, deep: boolean, done: Judged): void {
    this.#ahead.add(judging(state, deep, done), false, false);
  }

  /** Drops every look ahead: the player has moved and they no longer apply. */
  cancelAhead(): void {
    this.#ahead.cancel();
  }

  /** A seed whose deal, with `redeals` allowed, the solver has won. */
  deal(drawMode: DrawMode, redeals: number, done: (seed: number | undefined) => void): void {
    this.#main.add(job({ type: 'deal', drawMode, redeals }, done), false, false);
  }

  /** Rates a finished deal on a worker of its own, so play never waits for it. */
  rate(state: KlondikeState, done: (level: Level) => void): void {
    this.#rate.add(job({ type: 'rate', state }, (level) => done(level ?? 0)), false, false);
  }

  async close(): Promise<void> {
    await Promise.all([this.#main.close(), this.#deep.close(), this.#ahead.close(), this.#rate.close()]);
  }
}
