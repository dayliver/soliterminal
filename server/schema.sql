-- soliterminal shared results. Apply with:
--   npx wrangler d1 execute soliterminal --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS games (
  install_id   TEXT    NOT NULL,  -- random per installation; nothing about the player
  seed         INTEGER NOT NULL,
  draw_mode    INTEGER NOT NULL,  -- 1 or 3
  redeal_limit INTEGER,           -- NULL: no limit
  result       TEXT    NOT NULL,  -- 'won' or 'lost'
  ms           INTEGER NOT NULL,
  moves        INTEGER NOT NULL,
  redeals      INTEGER,           -- for a win: times the waste was turned over
  lost_at      INTEGER,           -- for a loss proven in play: the move that lost it
  level        INTEGER,           -- for a loss: 0 unrated, 1 easy, 2 medium, 3 hard
  day          TEXT    NOT NULL,  -- YYYY-MM-DD, UTC
  -- A batch sent twice (the answer lost on the way back) is stored once.
  UNIQUE (install_id, seed, draw_mode, day, ms, moves, result)
);
CREATE INDEX IF NOT EXISTS games_by_deal ON games (seed, draw_mode);

CREATE TABLE IF NOT EXISTS installs (
  id           TEXT PRIMARY KEY,
  client       TEXT,
  first_upload INTEGER NOT NULL,
  last_upload  INTEGER NOT NULL,
  batches      INTEGER NOT NULL
);
