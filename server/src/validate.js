/**
 * Checks a batch of shared results. Pure, so it is tested without Cloudflare.
 * Returns the games to store, or an error to send back.
 */

/** The smallest batch accepted: the game only ever offers to send whole hundreds. */
export const MIN_BATCH = 100;
/** The game sends at most this many at once; more wait for its next batch. */
export const MAX_BATCH = 1000;
/** Body size limit, well above what MAX_BATCH games take. */
export const MAX_BYTES = 512 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A game's own random name, given by the game. */
const GAME_ID = /^[0-9a-f]{8,32}$/;
const count = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

/** One game, or undefined if anything about it is off. */
function game(g) {
  if (typeof g !== 'object' || g === null) return undefined;
  if (typeof g.id !== 'string' || !GAME_ID.test(g.id)) return undefined;
  if (!count(g.seed, 0xffff_ffff) || (g.draw !== 1 && g.draw !== 3)) return undefined;
  if (!(g.limit === null || count(g.limit, 99))) return undefined;
  if (g.result !== 'won' && g.result !== 'lost') return undefined;
  if (!count(g.ms, 1000 * 60 * 60 * 24 * 30) || !count(g.moves, 100_000)) return undefined;
  if (g.redeals !== undefined && !count(g.redeals, 10_000)) return undefined;
  if (g.lostAt !== undefined && !count(g.lostAt, 100_000)) return undefined;
  if (g.level !== undefined && !count(g.level, 3)) return undefined;
  if (typeof g.day !== 'string' || !DAY.test(g.day)) return undefined;
  return {
    id: g.id,
    seed: g.seed,
    draw: g.draw,
    limit: g.limit,
    result: g.result,
    ms: g.ms,
    moves: g.moves,
    redeals: g.redeals ?? null,
    lostAt: g.lostAt ?? null,
    level: g.level ?? null,
    day: g.day,
  };
}

/** @returns {{ ok: true, id: string, client: string, games: object[] } | { ok: false, status: number, error: string }} */
export function validateBatch(body) {
  if (typeof body !== 'object' || body === null || body.v !== 1) return { ok: false, status: 400, error: 'unknown format' };
  if (typeof body.id !== 'string' || !UUID.test(body.id)) return { ok: false, status: 400, error: 'bad id' };
  if (!Array.isArray(body.games)) return { ok: false, status: 400, error: 'no games' };
  if (body.games.length < MIN_BATCH) return { ok: false, status: 400, error: `batches start at ${MIN_BATCH} games` };
  if (body.games.length > MAX_BATCH) return { ok: false, status: 413, error: 'too many games' };
  const games = body.games.map(game);
  if (games.some((g) => g === undefined)) return { ok: false, status: 400, error: 'a game is malformed' };
  const client = typeof body.client === 'string' ? body.client.slice(0, 40) : '';
  return { ok: true, id: body.id, client, games };
}
