/**
 * Prints one static frame of a freshly dealt game and exits. No input yet.
 *
 *   node src/preview.ts [--seed N] [--draw 1|3] [--compact] [--ascii] [--width N] [--select]
 */
import { parseArgs } from 'node:util';
import { randomSeed } from './core/deck.ts';
import { deal, draw, pile } from './core/klondike.ts';
import { paint } from './ui/ansi.ts';
import { renderKlondike } from './ui/layout.ts';
import { pickTheme } from './ui/theme.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
    draw: { type: 'string', default: '1' },
    ascii: { type: 'boolean', default: false },
    compact: { type: 'boolean', default: false },
    width: { type: 'string' },
    select: { type: 'boolean', default: false },
  },
});

const seed = values.seed === undefined ? randomSeed() : Number(values.seed);
const drawMode = values.draw === '3' ? 3 : 1;
let state = deal(seed, drawMode);
if (values.select) {
  // Turn a few cards so the waste and highlights have something to show.
  for (let i = 0; i < 3; i++) {
    const r = draw(state);
    if (r.ok) state = r.state;
  }
}

const buf = renderKlondike(
  state,
  {
    cursor: values.select ? pile.tableau(6) : pile.tableau(0),
    held: values.select ? { from: pile.waste } : undefined,
    message: `Seed ${seed}. Static preview, keys are not wired up yet.`,
    elapsedMs: 0,
  },
  { ascii: values.ascii, compact: values.compact, width: values.width ? Number(values.width) : undefined },
);

process.stdout.write(paint(buf, pickTheme(process.env, process.stdout.isTTY ?? false)) + '\n');
