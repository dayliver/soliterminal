/**
 * Takes shared soliterminal results and keeps them in D1 for Klondike research.
 *
 *   POST /v1/games   a batch from the game (1,000 games or more)
 *   GET  /v1/summary games, wins and installations so far
 *
 * One batch per installation a day: the game only asks every thousand games,
 * so anything more often is not the game.
 */
import { MAX_BYTES, validateBatch } from './validate.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** D1 allows 100 bound values per statement: 11 columns, so 9 rows. */
const ROWS_PER_INSERT = 9;

const json = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/summary' && request.method === 'GET') {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS games, SUM(result = 'won') AS won, COUNT(DISTINCT install_id) AS installs FROM games",
      ).first();
      return json(200, row);
    }
    if (url.pathname !== '/v1/games' || request.method !== 'POST') return json(404, { error: 'not found' });

    const size = Number(request.headers.get('content-length') ?? 0);
    if (size > MAX_BYTES) return json(413, { error: 'too large' });
    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BYTES) return json(413, { error: 'too large' });
      body = JSON.parse(text);
    } catch {
      return json(400, { error: 'not JSON' });
    }
    const batch = validateBatch(body);
    if (!batch.ok) return json(batch.status, { error: batch.error });

    const now = Date.now();
    const seen = await env.DB.prepare('SELECT last_upload FROM installs WHERE id = ?').bind(batch.id).first();
    if (seen && now - seen.last_upload < DAY_MS) return json(429, { error: 'one batch a day' });

    const statements = [];
    for (let i = 0; i < batch.games.length; i += ROWS_PER_INSERT) {
      const rows = batch.games.slice(i, i + ROWS_PER_INSERT);
      const values = [];
      for (const g of rows) values.push(batch.id, g.seed, g.draw, g.limit, g.result, g.ms, g.moves, g.redeals, g.lostAt, g.level, g.day);
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO games (install_id, seed, draw_mode, redeal_limit, result, ms, moves, redeals, lost_at, level, day) VALUES ${rows
            .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .join(', ')}`,
        ).bind(...values),
      );
    }
    statements.push(
      env.DB.prepare(
        'INSERT INTO installs (id, client, first_upload, last_upload, batches) VALUES (?, ?, ?, ?, 1) ' +
          'ON CONFLICT(id) DO UPDATE SET client = excluded.client, last_upload = excluded.last_upload, batches = batches + 1',
      ).bind(batch.id, batch.client, now, now),
    );
    await env.DB.batch(statements);
    return json(200, { stored: batch.games.length });
  },
};
