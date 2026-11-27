/**
 * Shows the game in progress, as kept on disk: the board, the clock, and
 * whether it can still be won. Read-only: the running game is not touched.
 *
 *   node scripts/peek.ts [--ascii] [--no-judge]
 */
import { parseArgs } from 'node:util';
import { createApp, viewOf } from '../src/app.ts';
import { judge } from '../src/core/solver.ts';
import { installWasmEngine } from '../src/solver-wasm.ts';

installWasmEngine();
import { loadSavedGame, replaySaved, savedGamePath } from '../src/saved-game.ts';
import { statsPath } from '../src/stats-file.ts';
import { formatTime } from '../src/ui/help.ts';
import { renderKlondike } from '../src/ui/layout.ts';

const { values } = parseArgs({ options: { ascii: { type: 'boolean', default: false }, 'no-judge': { type: 'boolean', default: false } } });

const path = savedGamePath(process.env, statsPath(process.env));
const saved = loadSavedGame(path);
if (!saved) {
  console.log(`No game in progress (${path}).`);
  process.exit(1);
}
const states = replaySaved(saved);
if (!states) {
  console.log(`The saved game in ${path} does not replay: it is damaged.`);
  process.exit(1);
}
const game = states[states.length - 1]!;
console.log(`Seed ${saved.seed}, Draw ${saved.drawMode}, ${game.moves} moves, ${formatTime(saved.ms)} on the clock; saved ${saved.savedAt}.`);

const judged = values['no-judge'] ? undefined : judge(game, { thorough: true });
const view = viewOf(createApp(game), 0);
console.log(renderKlondike(game, { ...view, status: judged?.verdict, message: undefined, elapsedMs: saved.ms }, { ascii: values.ascii }).toText().trimEnd());

if (judged) {
  const { verdict, next, ms } = judged;
  const where = (p: { kind: string; index?: number }) => p.kind + (p.index === undefined ? '' : ` ${p.index + 1}`);
  const step = next ? ` First move of a win: ${next.card.rank}${next.card.suit} x${next.count} from ${where(next.from)} to ${where(next.to)}.` : '';
  console.log(`Solver: ${verdict} (${ms} ms).${step}`);
}
