# Development notes

These notes are for whoever works on soliterminal next. The README covers what
the game does for players. This file covers how the code is laid out, the
decisions behind it, the share server, and what is still open.

## Commands

```sh
npm install      # TypeScript and Node types, for type checking only
npm start        # play from source (Node 22.18+ runs the .ts files directly)
npm run check    # type check and run the tests
npm run build    # compile to dist/ for the npm package
npm run preview  # print one static frame
npm run peek     # show the game in progress and whether it can still be won
node scripts/solver-stats.ts --count 200 --draw 1   # how many deals the solver decides, and how fast
```

`npm publish` runs `check` and `build` first (`prepublishOnly`). The package
ships only `dist/` and the two READMEs. Nothing at runtime depends on another
package.

## Layout

| Path | What it holds |
|---|---|
| `src/core/` | The rules: cards, the seeded deck, Klondike moves (`klondike.ts`), and the solver (`solver.ts`). Pure, no I/O. |
| `src/app.ts` | The whole app as a pure state machine: `handleKey`, `tick` and `applyVerdict` take an `App` and return the next one, and `viewOf` turns it into a `View`. Time and new deals are passed in, so tests run without timers. |
| `src/ui/` | Key input, the key map, the layout that draws a `View` into a screen buffer, and the diff that writes only changed cells to the terminal. |
| `src/cli.ts` | The runner. It owns the terminal, timers, files and solver workers, and feeds their results into the state machine. |
| `src/solver-client.ts`, `src/solver-worker.ts` | Solver lanes on `worker_threads`. Each lane takes one job at a time. A newer job cancels an older one, and a lane whose worker crashes or runs out of memory (1 GB cap) is replaced, its job answered as undecided. |
| `src/stats.ts`, `src/stats-file.ts` | Statistics as an event log, and the files they live in. |
| `src/saved-game.ts` | The game in progress: the deal plus the steps between positions, replayed on load. |
| `src/share.ts`, `server/` | Sharing results, and the Cloudflare Worker that receives them. |
| `scripts/` | `peek.ts` and `solver-stats.ts`, developer tools only. |

## Decisions worth knowing

**Files.** Everything lives in one state folder (`$XDG_STATE_HOME/soliterminal`
or `%LOCALAPPDATA%\soliterminal`):

- `games.jsonl` is append-only. It holds one line per event: a finished game, a
  difficulty level found later, or a batch marked as sent. Reading it folds
  the lines, and a game counts once by its id: the first finish wins. Damaged
  lines are skipped, and a write cut short never swallows the next line. Several
  windows can play at once without overwriting each other.
- `current.json` is the game in progress. It is one file, and the last window to
  save wins. Losing an unfinished game from another window is accepted.
- `share.json` records where sharing stands. It is rewritten whole through a
  temporary file.
- An older `stats.json` is moved into the log once, only when there is no log
  yet. Its unfinished games are dropped, and the old file is left in place.

**Statistics are written only when a game ends.** A win, a proven loss, or
giving up counts as an end. Starting another deal or a seed over a game in
progress counts as giving up, and the game asks first.

**Keys sit in rows of a QWERTY keyboard, with no F-keys.**

- `q` is the stock and `w` the waste. `r t y u` are the foundations and `i`
  sends a card to its foundation.
- `a s d f g h j` are the seven columns.
- `e` sits over the gap in the top row and only says so.
- Everything that is not a move is in the Esc menu.
- `x` asks before quitting. Ctrl+Q and Ctrl+C quit at once. All three keep the
  game.

**Dialogs** share one model, `DialogSpec`: a list of choices and a cancel
action.

- The arrows choose, and Enter or Space takes the choice. The first letter of a
  choice takes it at once. Esc cancels.
- Labels in each dialog must start with different letters, and a test checks
  this.
- Some dialogs come up on their own: a loss found, the share question, the seed
  question at start. These ignore Enter, Space and letters for 700 ms, so a key
  meant for the board is not taken as the answer. Dialogs the player opens
  answer at once.

**Small rules of play:**

- The cursor stays where cards came from, on the card turned up there.
  Following the cards cost about 14% more arrow presses over the solver's
  winning lines.
- `?` gives a hint at any time, as often as asked, after one question.
- The share question comes only right after a win, before the results.

## Share server

The share server runs at `https://soliterminal-share.dayliver.workers.dev`,
and the game posts to `/v1/games` (`SHARE_URL` in `src/share.ts`). The D1
database is `soliterminal`. Its id is in `server/wrangler.toml` and is not a
secret.

| Endpoint | What it does |
|---|---|
| `POST /v1/games` | A batch: `{ v: 1, id, client, games: [...] }`, 100 to 1,000 games, each with its own `id` |
| `GET /v1/summary` | Games, wins and installations so far |

The server refuses a batch under 100 games (400). It also refuses a second
batch from the same installation within a day (429). A game sent twice is
stored once, keyed by installation and game id. Point the game at another
server with `SOLITERMINAL_SHARE_URL`.

Deploy from scratch:

```sh
cd server
npx wrangler login
npx wrangler d1 create soliterminal         # put the database_id it prints into wrangler.toml
npx wrangler d1 execute soliterminal --remote --file=schema.sql
npx wrangler deploy                         # prints the worker's URL
```

Read the data:

```sh
npx wrangler d1 execute soliterminal --remote --command \
  "SELECT draw_mode, COUNT(*), AVG(result = 'won') FROM games GROUP BY draw_mode"
npx wrangler d1 export soliterminal --remote --output=games.sql
```

## Code review before release (2026-11-26)

A review for minimal, efficient code removed duplication, dead code and stale
comments without changing features. `src/` and `scripts/` went from 5,208 to
5,131 lines. No design flaw turned up.

| Was | Now |
|---|---|
| `formatTime` copied in 4 files | One export |
| Card comparison written 3 ways | `sameCard`, which also takes `undefined` |
| Pile-kind branches repeated in `maxTake`, `take`, `leadCard`, `cardAt` | `cardsIn()`; `cardAt` removed |
| Every move one step on, listed twice (`successors`, `stepBetween`) | `steps()`, with the `Step` type in the rules module |
| `samePosition` comparing by hand in 12 lines | A 2-line comparison of serialized positions |
| `exactMoves` repeating the destination order of `destinations` | `destinations(state, from, count?)`; `exactMoves` removed |
| Worker messages branching per job type in 3 places, with an `id` never checked | Job-agnostic `Lane`; `id` and `busy` removed |
| `newGame` and `playSeed` nearly the same | `startDeal`; `newGame(app, dealer, now, drawMode?)` |
| Write-through-a-temporary-file code in 2 files | Shared `writeWhole` |
| Default redeals, game id pattern and solver budget written in several places | `DEFAULT_REDEALS`, `GAME_ID`, `MAX_NODES` / `TIME_LIMIT_MS` |
| Unused `CARD_WIDTH`, `ansi.home`, color name `'border'` | Removed |
| Comments naming old keys (F9, `g`, `n`), or sitting on the wrong declaration | Fixed. The `abandon` comment now matches what the runner does. |

The review changed one behaviour. Enter on a whole column, chosen with the
arrows, no longer moves a king with nothing under it to another empty column.
That move gains nothing, and pressing the column's key twice already skipped
it. Both paths now use `destinations`, and so does the warning about held
cards. Naming the empty column with its key still makes the move, and
`test/klondike.test.ts` covers it.

The review checked its changes in four ways:

- `npm run check` passes with 238 tests, and `tsc --noUnusedLocals` finds
  nothing unused.
- A scratch script ran the real solver workers through judge, deep judge,
  finding a deal, looking one move ahead with a cancel, and rating.
- The built `dist/cli.js` ran in a pseudo-terminal, through moves, hints,
  undo, the menu, quitting and saving.
- `preview` and `peek` both ran.

## Open items

| Item | Notes |
|---|---|
| Undecided deals | With the default budget (300,000 nodes, 5 s, 3 redeals) the solver leaves Draw 1 seeds 1-150 undecided 22.0% of the time (76.7% solved, 1.3% lost, median 74 ms). For Draw 3 seeds 1-100 it is 10.0% (69.0% solved, 21.0% lost, median 117 ms). These are measured before the review, and the search did not change. Improving the search is research, not cleanup. |
| Worker crash handling | It has been checked only by scratch scripts. There is no automated test. |
| Ctrl+Q in VS Code / Cursor | Not checked whether the editor takes the key first. If it does, say in the README to use Ctrl+C there. |
| Saving by working out steps | Each save finds the step between every pair of positions (`stepBetween`). Recording the step as each move is made would remove that, but changes the shape of `App`. |
| Kept on purpose | `input.ts` passes F1-F12 through, and a test checks it. Several exports exist only for tests (`parseCard`, `reachablePositions`, `COLUMN_PITCH`, `BOARD_WIDTH`). Reading `stats.json` and version 1 save files stays for players upgrading. |
| First npm release | This is `0.1.0-alpha.1`, on GitHub only. After more play-testing, `0.1.0` is the first release and goes to npm. The name `soliterminal` was free on npm on 2026-11-26. |
