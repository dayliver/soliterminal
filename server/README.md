# soliterminal share server

Receives the results players choose to share and keeps them in Cloudflare D1.
The game asks once every hundred finished games and sends nothing unless the
player says yes. See "Sharing results" in the main README for what is sent.

## Deploy

```sh
cd server
npx wrangler login
npx wrangler d1 create soliterminal         # put the database_id it prints into wrangler.toml
npx wrangler d1 execute soliterminal --remote --file=schema.sql
npx wrangler deploy                         # prints the worker's URL
```

Then set `SHARE_URL` in `src/share.ts` to `https://<worker>/v1/games` and
publish the game. Until then the game never asks. To try it first, run the game
with `SOLITERMINAL_SHARE_URL=https://<worker>/v1/games`.

## Endpoints

| | |
|---|---|
| `POST /v1/games` | A batch: `{ v: 1, id, client, games: [...] }`, 100 to 1,000 games, each with its own `id` |
| `GET /v1/summary` | Games, wins and installations so far |

Batches under 100 games are refused (400), and so is a second batch from the
same installation within a day (429). A game sent twice is stored once, by its
installation and its own id.

## Reading the data

```sh
npx wrangler d1 execute soliterminal --remote --command \
  "SELECT draw_mode, COUNT(*), AVG(result = 'won') FROM games GROUP BY draw_mode"
npx wrangler d1 export soliterminal --remote --output=games.sql
```
