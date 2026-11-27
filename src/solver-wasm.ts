import { readFileSync } from 'node:fs';
import { type Engine, useEngine } from './core/solver.ts';

/**
 * The solver's search compiled from Rust (`solver/`) to WebAssembly: the same
 * search as `core/solver.ts`, several times faster and in a fraction of the
 * memory. `solver.wasm` sits next to this file, in `src/` and in `dist/`.
 */

/** A search stops, unanswered, once its memory passes this. */
const MEMORY_LIMIT = 1024 ** 3;
/** WebAssembly memory only grows, so after a search that took more than this the next one starts afresh. */
const KEEP_BELOW = 64 * 1024 ** 2;

const STATUS = ['unknown', 'solved', 'unsolvable'] as const;

interface Exports {
  readonly memory: WebAssembly.Memory;
  input(): number;
  run(columns: number, drawMode: number, maxNodes: number, timeLimitMs: number, exhaustive: number, memoryLimit: number): number;
}

export function wasmEngine(bytes: Uint8Array): Engine {
  const module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>);
  const start = () => new WebAssembly.Instance(module, { env: { now: Date.now } }).exports as unknown as Exports;
  let wasm: Exports | undefined;
  return (root, columns, drawMode, maxNodes, timeLimitMs, exhaustive) => {
    wasm ??= start();
    new Uint8Array(wasm.memory.buffer, wasm.input(), root.length).set(root);
    let at: number;
    try {
      at = wasm.run(columns, drawMode, maxNodes, timeLimitMs, exhaustive ? 1 : 0, MEMORY_LIMIT);
    } catch (e) {
      wasm = undefined; // a trapped instance is in no state to use again
      throw e;
    }
    const [status, nodes, count] = new Uint32Array(wasm.memory.buffer, at, 3);
    const moves = Array.from(new Uint32Array(wasm.memory.buffer, at + 12, count));
    if (wasm.memory.buffer.byteLength > KEEP_BELOW) wasm = undefined;
    return { status: STATUS[status!]!, nodes: nodes!, moves };
  };
}

/**
 * Makes every search in this thread use the WebAssembly engine. False when it
 * could not be loaded, in which case the TypeScript search carries on as before.
 */
export function installWasmEngine(): boolean {
  try {
    useEngine(wasmEngine(readFileSync(new URL('./solver.wasm', import.meta.url))));
    return true;
  } catch {
    return false;
  }
}
