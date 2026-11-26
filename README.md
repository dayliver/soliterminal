# soliterminal

**Klondike solitaire for the terminal, played entirely from the keyboard.**
Every deal can be won, a built-in solver tells you the moment it no longer
can, and your game waits for you whenever you have to go.

[한국어](README.ko.md)

```
 soliterminal · Klondike · Draw 1      Moves 46  03:41  Win ✓

            ~     1           F5    F6    F7    F8
           ░15░   4♦          A♦   [A ]  [A ]  [A ]
            ↺2
            q     w     e     r     t     y     u
            K♣   ░░░░   3♣   ░░░░   X♣   ░░░░  ░░░░
            Q♥    8♠         ░░░░        ░░░░  ░░░░
            J♣    7♦         ░░░░        ░░░░  ░░░░
            X♦    6♣          6♦         ░░░░  ░░░░
            9♠    5♦          5♠          J♠    5♥
            8♦    4♣          4♥
            7♠    3♥          3♠
            6♥    2♠

 › Holding column 4. Where does it go?
── Draw 1  won 29/42 (69%)  streak 3  longest 7  best 02:52 ──
 ~ draw  1 waste  q-u columns  F9 to foundation
 arrows select  space pick/drop  z undo  ? help  x quit
```

<sub>Compact cards, as drawn in any terminal; X is a ten. Large cards draw their suits as emoji.</sub>

## Why

More and more of a developer's day goes to handing work to an AI agent and
waiting for it to finish. Those minutes are too short to start something else
and too long to stare at a scrolling log. soliterminal is something to do with
them: a quick game in the terminal you already have open, which you can drop the
moment your agent needs you and pick up again later, exactly where you left it.

## Highlights

- **Keys where the piles are.** The key above each pile is the key in the same
  place on your keyboard: `~` for the stock, `1` for the waste, `q` to `u` for
  the seven columns, `F5` to `F8` for the foundations. Arrow keys work too.
- **Every deal can be won.** The solver proves each new deal winnable before
  you see it.
- **It tells you when you have lost.** The header shows, move by move, whether
  the game can still be won. A losing move is caught at once, and `z` takes it
  back.
- **Warnings before you make a mistake.** While you think, the solver looks one
  move ahead. Pick up cards with a losing place to go and you are warned,
  without being told which place. When winning takes every redeal you have
  left, the header says so too.
- **Your game keeps.** Quit any time; the next start carries on with the board,
  the undo history and the clock. The clock also stops while you are in another
  window.
- **A record of every deal.** Each game is kept with its seed: won or lost,
  time, moves, the move that lost it, and how hard the deal was. Replay any of
  them, or type in a seed.
- **Follows your terminal.** Everything but the cards uses your terminal's own
  16-color palette, in one color family of your choice. Large or compact cards,
  plain-ASCII and no-color modes.

## Install

soliterminal needs [Node.js](https://nodejs.org) 20 or later.

```sh
npm install -g soliterminal
soliterminal
```

Or try it without installing:

```sh
npx soliterminal
```

## How to play

Klondike in one paragraph: build the four foundations up from ace to king, one
suit each. In the seven columns, cards go down in alternating colors (a red 6
on a black 7), and only a king may start an empty column. A face-down card
turns over once it is uncovered. When you are stuck, draw from the stock.

### Moving cards

Press the key of the pile the cards come **from**, then the key of the pile they
go **to**. `r` then `t` moves cards from column 4 onto column 5; how many is
worked out from where they land. Press the same key twice (`r` `r`) and they go
to the best spot, a foundation if they can.

| Key | Pile |
|---|---|
| `~` (or `` ` ``, the same key) | Draw from the stock. When it is empty, turn the waste over (a redeal) |
| `1` | The waste |
| `q` `w` `e` `r` `t` `y` `u` | Columns 1 to 7 |
| `F9` | The right foundation for the card: the usual way to send a card home |
| `F5` `F6` `F7` `F8` | One particular foundation |

Foundations are not tied to a suit: an ace starts any empty one, and `F9` picks
for you. When every card is face up, the game plays itself out.

### The cursor

If you would rather point than press pile keys:

| Key | Action |
|---|---|
| `←` `→` | Move along the row |
| `↑` `↓` | Move to the pile straight above or below (`q`↔stock, `w` and `e`↔waste, `r` to `u`↔foundations) |
| `↓` in a column | Choose how many cards to move: the cursor goes onto the top card of the run (say a K), then one card further down each press (Q, J, …). The chosen card is tinted, and it moves with every card below it. `↑` goes back |
| `Space` | Pick up or put down at the cursor. On the stock, draw |
| `Enter` | Send the cursor's cards to the best spot |
| `Esc` | Put held cards back. With nothing held, switch large and compact cards |

### Everything else

| Key | Action |
|---|---|
| `z` | Undo, as far back as the deal |
| `h` | Hint, once you are stuck (see [Hints](#hints)) |
| `n` | New deal (asks first if a game is under way) |
| `F2` | Start this deal over (asks first; not once it is won) |
| `g` | Choose a deal: type a seed, or pick one of your games |
| `d` | Draw 1 or Draw 3: at once on an untouched deal, otherwise from the next one |
| `s` | Statistics |
| `?` | Help |
| `x` | Quit (asks first; your game is kept) |
| `Ctrl+C` | Quit at once (your game is still kept) |

Three redeals are allowed by default (`--redeals` changes it). How many are
left is always shown under the stock: `↺2`, in red at `↺0`.

## Playing with the solver

### The header

The header always says where you stand:

| Header | Meaning |
|---|---|
| `Win ✓` | This position can still be won |
| `Win ✓!` | It can still be won, but only by using every redeal left: no trip through the stock to spare |
| `Win ⚠` | The cards in your hand have a place to go that loses |
| `Win …` | Checking, usually for a fraction of a second |
| `Win ?` | Not settled yet; a longer look carries on in the background |
| `Win 0%` | It can no longer be won |

At `Win 0%` you choose: back to the last winnable position (`z`), start the deal
over (`F2`), a new deal (`n`), quit (`x`), or play on (`Esc`). If the game was
lost a few moves back, the dialog says how many, and `z` goes back to just
before them.

### Warnings

While you think, the solver looks at every position one move away. When you
pick up cards that have a losing place to go, the message line turns red:
`⚠ Careful: one of its two places loses the game.` It does not say which place;
that is still your call. Put them there anyway and it is `Win 0%` straight
away, with `z` taking back just that move.

Everything the solver works out is remembered for the deal, restarts included,
so a mistake made once is caught instantly the next time.

### Hints

The solver sees the face-down cards, so it may know of a win you cannot see:
moving part of a run, say, or taking a card back down from a foundation. Go once
through the whole stock without playing a card (or press `~` with nothing left
to draw) and the game tells you a move is there; from then on `h` shows the
solver's next move. Play any card and the hint closes again.

## Your games

### Saved as you play

Quit whenever you like: the next `soliterminal` carries on with the same board,
the whole undo history and the clock. Only a finished game is not kept. The seed
of the deal is printed when you quit.

The clock runs only while the game's terminal has focus, so time spent with your
agent does not count. Most terminals report focus (kitty, WezTerm, iTerm2,
Windows Terminal, GNOME Terminal, Konsole); in tmux, turn on
`set -g focus-events on`. Where focus is never reported, the clock just runs.

If you start a second soliterminal while one is running, it plays a fresh deal
and leaves the first one's game alone.

### Statistics

Every game is kept with its seed, and the statistics (`s`) are worked out from
those games, separately for Draw 1 and Draw 3: games played, won, win rate,
current and longest streak, best time and fewest moves.

A game counts from the first card moved; drawing from the stock alone does not
count. Starting a deal over carries on the same game. Quitting only pauses it,
but leaving it unfinished for another deal counts as a loss and ends your
streak.

### Choosing a deal

`g` lists your games, newest first:

```
 soliterminal · Deals

   Seed                 Draw 1  (d switches)

   Your games
     Seed        Draw  Result     Time   Moves  Redeals Level   When
     2902541007  1     playing    01:35     23                  11-26 09:12
   › 707746170   1     lost @86   06:40     86          hard    11-25 15:07
     109483114   1     won        06:52    131    2             11-25 13:40
     46732994    1     gave up    12:10     36          medium  11-25 11:50
     3291647763  3     won        03:05     98    0             11-24 18:03

 Type a seed, or choose a game with ↑ ↓. Enter plays it; esc goes back.
 Playing another deal gives up the game in progress.
```

Choose a game with the arrows and press `Enter` to play it again, or type any
seed (`d` switches the draw mode). A typed seed is not checked first: the header
tells you once the solver has judged it.

- **Result.** `lost @86` means the 86th move (counted as in the header) made the
  game unwinnable. `gave up` means it was left while it might still have been
  won. `no win` means the deal itself could not be won.
- **Redeals.** For a win, how many times the waste was turned over.
- **Level.** A lost deal is rated in the background, a few seconds on a spare
  thread. The solver follows a winning line and counts the places where a move
  loses and the places with only one way on: `easy`, `medium` or `hard`, and
  `…` while it is being rated.

A deal you have won is never dealt again, and cannot be chosen again in the same
draw mode. A deal you lost before says so when it comes back, with the date
(`lost before 11-25 15:07` above the status bar).

### Sharing results

Nothing leaves your computer on its own. When your finished games reach 1,000,
and again at 2,000, 3,000 and so on, soliterminal asks once, between games,
whether to send them to open Klondike research data. Say no and it asks again
at the next thousand; agree then, and every game not sent yet goes. There is no
way to send smaller batches: a server taking a few games at a time from
everyone would only be kept busy for nothing.

What is sent for each game: the seed, draw mode, redeal limit, won or lost,
time, moves, redeals used (wins), the move that lost it and its level (losses),
and the day it was played. Besides that, a random name for your installation,
made up on your computer so that a batch sent twice counts once, and the
soliterminal version. Nothing else: no name, account, address, file paths or
times of day. The server code is in [`server/`](server/).

## Options

```sh
soliterminal --draw 3 --theme blue
```

| Option | Meaning |
|---|---|
| `--draw 1\|3` | Draw one or three cards at a time (default 1) |
| `--redeals N` | Times the waste can be turned over: 0 to 99, or `unlimited` (default 3). Deals are proven winnable under the same limit |
| `--compact` | Start with compact cards |
| `--theme NAME` | Color family: `green` (default), `cyan`, `blue`, `magenta`, `yellow`, `red`, `white` |
| `--seed N` | Play a particular deal (not checked first). Gives up a kept game |
| `--any-deal` | Deal any shuffle, not only winnable ones |
| `--ascii` | Plain ASCII: no box drawing, suit symbols or emoji |
| `-h`, `--help` | Show usage |

| Environment variable | Meaning |
|---|---|
| `SOLITERMINAL_THEME=NAME` | Same as `--theme` (the option wins) |
| `SOLITERMINAL_CARD=ddd\|fff` | Card face: soft grey-white (default) or pure white |
| `SOLITERMINAL_STATS=PATH` | Your games and statistics |
| `SOLITERMINAL_GAME=PATH` | The game in progress (default `current.json` next to the statistics) |
| `SOLITERMINAL_SHARE_URL=URL` | Where shared results go, for testing a share server |
| `COLORTERM=truecolor` | Exact card colors (otherwise the nearest 256-color ones) |
| `NO_COLOR=1` | No color at all |

Your data lives in `~/.local/state/soliterminal/` (`$XDG_STATE_HOME` if set), or
in `%LOCALAPPDATA%\soliterminal\` on Windows: `stats.json` holds your games and
`current.json` the game in progress. Both are plain JSON.

## Terminals

- **Size.** At least 56 columns. Height adapts: tall stacks of face-down cards
  fold into one row when space runs short.
- **Large cards** draw their suits as emoji, which needs a terminal and font
  that render emoji, such as kitty, WezTerm, Ghostty, iTerm2 or Windows
  Terminal. Elsewhere the suits come out smaller; compact cards (`Esc`) look
  right everywhere.
- **Colors.** The interface uses your terminal's 16-color palette, so it fits
  your theme, light or dark. Only the cards have fixed colors.

## Development

```sh
npm install      # TypeScript and Node types, for type checking only
npm start        # play from source (Node 22.18+ runs the .ts files directly)
npm run check    # type check and run the tests
npm run build    # compile to dist/ for the npm package
npm run preview  # print one static frame
npm run peek     # show the game in progress and whether it can still be won
```

The game has no runtime dependencies. The rules are in `src/core/klondike.ts`,
the solver in `src/core/solver.ts` (it runs on worker threads, so the screen
never waits for it), the app's state machine in `src/app.ts`, and the drawing in
`src/ui/`. The share server, a Cloudflare Worker with a D1 database, is in
`server/`.

## License

MIT
