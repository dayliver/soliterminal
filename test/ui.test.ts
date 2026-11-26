import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deal, pile } from '../src/core/klondike.ts';
import { ansi, diff, paint } from '../src/ui/ansi.ts';
import { keyLabel, pileForKey } from '../src/ui/keymap.ts';
import { BOARD_WIDTH, COLUMN_PITCH, COMPACT, MIN_WIDTH, type View, renderKlondike, screenHeight } from '../src/ui/layout.ts';
import { ScreenBuffer, charWidth, isEmoji, textWidth } from '../src/ui/screen.ts';
import { mulberry32 } from '../src/core/deck.ts';
import { colorTheme, monoTheme, pickTheme, truecolorTheme } from '../src/ui/theme.ts';
import { board } from './helpers.ts';

const view: View = { cursor: pile.tableau(0) };
const left = Math.floor((MIN_WIDTH - BOARD_WIDTH) / 2);
const colX = (i: number) => left + i * COLUMN_PITCH;
/** The text of `n` cells from (x, y); a wide character's right half adds nothing. */
const cells = (buf: ScreenBuffer, x: number, y: number, n: number) => {
  let out = '';
  for (let i = 0; i < n; i++) out += buf.get(x + i, y).ch;
  return out;
};

describe('ScreenBuffer', () => {
  test('clips text at the edges', () => {
    const buf = new ScreenBuffer(5, 1);
    assert.equal(buf.put(3, 0, 'abc'), 6);
    buf.put(-1, 0, 'xy');
    assert.equal(buf.toText(), 'y  ab');
  });

  test('wide characters take two cells and are never split', () => {
    const buf = new ScreenBuffer(4, 1);
    buf.put(0, 0, '한a');
    assert.equal(buf.get(1, 0).ch, '');
    assert.equal(buf.toText(), '한a');
    buf.put(1, 0, 'z'); // overwrite the right half
    assert.equal(buf.toText(), ' za');
    const edge = new ScreenBuffer(3, 1);
    edge.put(2, 0, '한'); // does not fit in the last cell
    assert.equal(edge.toText(), '');
  });
});

describe('ANSI output', () => {
  test('diff of identical buffers is empty', () => {
    const a = renderKlondike(deal(3), view);
    const b = renderKlondike(deal(3), view);
    assert.equal(diff(a, b, colorTheme), '');
  });

  test('diff rewrites only the changed run', () => {
    const a = new ScreenBuffer(10, 2);
    const b = new ScreenBuffer(10, 2);
    b.put(4, 1, 'hi');
    const out = diff(a, b, monoTheme);
    assert.ok(out.startsWith(ansi.moveTo(4, 1)));
    assert.equal(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), 'hi');
  });

  test('first frame or a resize redraws everything', () => {
    const b = new ScreenBuffer(4, 2);
    assert.ok(diff(undefined, b, monoTheme).includes(ansi.clear));
    assert.ok(diff(new ScreenBuffer(3, 2), b, monoTheme).includes(ansi.clear));
  });

  test('mono theme never emits color codes', () => {
    const out = paint(renderKlondike(deal(3), { ...view, held: { from: pile.tableau(0) } }), monoTheme);
    assert.doesNotMatch(out, /\x1b\[[0-9;]*(3[0-9]|4[0-9]|38;5|48;5)[;m]/);
  });

  test('NO_COLOR and pipes get the mono theme', () => {
    assert.equal(pickTheme({ NO_COLOR: '1' }, true), monoTheme);
    assert.equal(pickTheme({}, false), monoTheme);
    assert.equal(pickTheme({}, true), colorTheme);
  });
});

describe('keymap', () => {
  test('keys follow the keyboard rows', () => {
    // The top letter row for the board's top row, the home row for the columns straight below.
    assert.deepEqual(pileForKey('q'), { kind: 'stock' });
    assert.deepEqual(pileForKey('w'), pile.waste);
    assert.equal(pileForKey('e'), undefined); // over column 3, where the top row has a gap
    assert.deepEqual(pileForKey('r'), pile.foundation(0));
    assert.deepEqual(pileForKey('u'), pile.foundation(3));
    assert.deepEqual(pileForKey('i'), { kind: 'auto-foundation' });
    assert.deepEqual(pileForKey('a'), pile.tableau(0));
    assert.deepEqual(pileForKey('J'), pile.tableau(6));
    for (const gone of ['`', '~', '1', 'f5', 'f9', 'k']) assert.equal(pileForKey(gone), undefined, gone);
    assert.equal(keyLabel({ kind: 'auto-foundation' }), 'i');
    assert.equal(keyLabel(pile.foundation(0)), 'r');
  });
});

describe('layout', () => {
  test('a fresh deal fits a 24-row terminal', () => {
    const s = deal(11);
    // Header, top row, keys, then one row per card: the longest column has 7.
    assert.equal(screenHeight(s), 18);
    assert.equal(renderKlondike(s, view).height, 18);
  });

  test('hotkeys sit above their piles', () => {
    // Large cards: keys are fullwidth, as big as the ranks.
    const buf = renderKlondike(deal(11), view);
    assert.equal(cells(buf, colX(0) + 2, 2, 2), 'ｑ');
    assert.equal(cells(buf, colX(1) + 2, 2, 2), 'ｗ');
    assert.equal(cells(buf, colX(3) + 2, 2, 2), 'ｒ');
    assert.equal(cells(buf, colX(6) + 2, 2, 2), 'ｕ');
    assert.equal([0, 1, 2, 3, 4, 5, 6].map((i) => cells(buf, colX(i) + 2, 5, 2)).join(''), 'ａｓｄｆｇｈｊ');
    // Compact cards keep plain keys.
    const small = renderKlondike(deal(11), view, { compact: true }).toText().split('\n');
    assert.equal(small[5]!.trim().split(/\s+/).join(''), 'asdfghj');
    assert.equal(small[2]!.trim().split(/\s+/).join(''), 'qwrtyu');
  });

  test('draws each card as one row: fullwidth ranks, emoji suits, ten as plain 10', () => {
    const s = board({ tableau: ['3C | XH 9S'] });
    const buf = renderKlondike(s, view);
    const at = (y: number) => cells(buf, colX(0), y, 6);
    assert.equal(at(6), '      '); // the face-down 3♣ is a grey block
    assert.equal(at(7), ' 10♥\uFE0F '); // ten is plain 10: already two characters
    assert.equal(at(8), ' ９♠\uFE0F ');
    assert.equal(at(9).trim(), ''); // nothing below the last card
    assert.equal(textWidth(' ９♠\uFE0F '), 6);
    assert.doesNotMatch(buf.toText().split('\n').slice(3, 10).join('\n'), /[╭╮╰╯─│┌┐└┘]/);
  });

  test('compact cards are four cells, ten as X, plain one-cell suits, columns 6 apart', () => {
    const s = board({ waste: '2C 3D 4S 5H', drawMode: 3, foundations: [, 'AH'], tableau: ['3C | XH 9S', ''] });
    const buf = renderKlondike(s, view, { compact: true });
    const cx = (i: number) => Math.floor((MIN_WIDTH - COMPACT.board) / 2) + i * COMPACT.pitch;
    assert.equal(COMPACT.board, 40);
    assert.equal(cells(buf, cx(0), 6, 4), '    ');
    assert.equal(cells(buf, cx(0), 7, 4), ' X♥ ');
    assert.equal(cells(buf, cx(0), 8, 4), ' 9♠ ');
    assert.equal(cells(buf, cx(1), 6, 4), '[K ]');
    assert.equal(cells(buf, cx(3), 3, 16), '[A ]   A♥   [A ]');
    assert.equal(cells(buf, cx(1), 3, 10), ' 3♦ 4♠ 5♥ ');
    assert.equal(buf.toText().split('\n')[5]!.indexOf('a'), cx(0) + 1);
    assert.doesNotMatch(buf.toText(), /\uFE0F|[Ａ-Ｚ０-９]/u);
  });

  test('stock count: one digit is fullwidth, two digits stay plain', () => {
    const many = renderKlondike(deal(1), view);
    assert.equal(cells(many, colX(0), 3, 6), '  24  ');
    const few = renderKlondike(board({ stock: '2C 3C 4C 5C 6C 7C 8C 9C XC' }), view);
    assert.equal(cells(few, colX(0), 3, 6), '  ９  ');
    // Compact cards keep plain digits.
    const small = renderKlondike(board({ stock: '2C' }), view, { compact: true });
    assert.equal(cells(small, Math.floor((MIN_WIDTH - COMPACT.board) / 2), 3, 4), '  1 ');
  });

  test('the empty stock shows the redeals left, or × when there are none', () => {
    const mark = (redealsLeft: number) => cells(renderKlondike(board({ waste: '2C', redealsLeft }), view), colX(0), 3, 6);
    assert.equal(mark(2), '[ ↺2 ]');
    assert.equal(mark(0), '[ ×  ]');
    assert.equal(mark(Infinity), '[ ↺  ]');
  });

  test('redeals left show under the stock the whole time', () => {
    const under = (redealsLeft: number, compact = false) => {
      const buf = renderKlondike(board({ stock: '2C 3C', redealsLeft }), view, { compact });
      const x = compact ? Math.floor((MIN_WIDTH - COMPACT.board) / 2) : colX(0);
      return { text: cells(buf, x, 4, compact ? 4 : 6), fg: buf.get(x + (compact ? 1 : 2), 4).fg };
    };
    assert.deepEqual(under(3), { text: '  ↺3  ', fg: 'dim' });
    assert.deepEqual(under(0), { text: '  ↺0  ', fg: 'red' });
    assert.deepEqual(under(2, true), { text: ' ↺2 ', fg: 'dim' });
    assert.equal(under(Infinity).text.trim(), '');
  });

  test('the record for this draw mode sits in the divider line', () => {
    const record = { played: 20, won: 12, streak: 3, bestStreak: 5, bestMs: 190_000 };
    const line = (width: number) => {
      const lines = renderKlondike(deal(1), { ...view, record }, { width }).toText().split('\n');
      return lines.at(-3)!;
    };
    const full = '── Draw 1  won 12/20 (60%)  streak 3  longest 5  best 03:10 ';
    assert.equal(line(80), full + '─'.repeat(80 - full.length));
    // At the minimum width the best time drops off rather than spill over.
    const short = '── Draw 1  won 12/20 (60%)  streak 3  longest 5 ';
    assert.equal(line(MIN_WIDTH), short + '─'.repeat(MIN_WIDTH - short.length));
    assert.match(renderKlondike(deal(1), view).toText().split('\n').at(-3)!, /^─+$/); // no record, plain divider
  });

  test('confetti falls during the ceremony and keeps cards whole', () => {
    const s = board({ tableau: ['| KH', '| KS'] });
    const plain = renderKlondike(s, view);
    const party = renderKlondike(s, { ...view, celebration: 1_500 });
    let falling = 0;
    for (let y = 1; y < party.height - 5; y++) {
      for (let x = 0; x < party.width; x++) {
        const c = party.get(x, y);
        if ('♠♥♦♣✦'.includes(c.ch) && c.ch !== '') falling++;
        // Wherever a card was, a card still is.
        if (plain.get(x, y).bg === 'card') assert.equal(c.bg, 'card', `${x},${y}`);
      }
    }
    assert.ok(falling > 10, `only ${falling} pieces`);
    // It keeps raining: a minute on, pieces are still falling, and cards are still whole.
    const later = renderKlondike(s, { ...view, celebration: 60_000 });
    let still = 0;
    for (let y = 1; y < later.height - 5; y++) {
      for (let x = 0; x < later.width; x++) {
        if ('♠♥♦♣✦'.includes(later.get(x, y).ch) && later.get(x, y).ch !== '') still++;
        if (plain.get(x, y).bg === 'card') assert.equal(later.get(x, y).bg, 'card', `${x},${y}`);
      }
    }
    assert.ok(still > 10, `only ${still} pieces a minute on`);
    // Without a celebration there is none.
    assert.equal(renderKlondike(s, view).toText(), plain.toText());
  });

  test('ascii cards keep the same width', () => {
    const buf = renderKlondike(board({ tableau: ['| XH 9S'] }), view, { ascii: true });
    assert.equal(cells(buf, colX(0), 6, 6), ' 10H  ');
    assert.equal(cells(buf, colX(0), 7, 6), '  9S  ');
  });

  test('ascii mode uses no box drawing or suit symbols', () => {
    const text = renderKlondike(deal(4, 3), { ...view, message: 'hi' }, { ascii: true }).toText();
    assert.doesNotMatch(text, /[^\x20-\x7e\n]/);
  });

  test('highlights sit on key labels and never on cards', () => {
    const s = board({ waste: '5D', tableau: ['| 9H 8S 7D'] });
    const cardsPlain = (buf: ScreenBuffer) => {
      for (let y = 3; y < 10; y++) for (let x = 0; x < buf.width; x++) {
        const bg = buf.get(x, y).bg;
        if (y !== 5) assert.ok(bg !== 'hold' && bg !== 'cursor', `card cell ${x},${y} is ${bg}`);
      }
    };
    const qLabel = (buf: ScreenBuffer) => cells(buf, colX(0) + 2, 5, 4).trim();

    const sel = renderKlondike(s, { cursor: pile.tableau(0) });
    cardsPlain(sel);
    assert.equal(sel.get(colX(0) + 2, 5).bg, 'cursor');
    assert.equal(qLabel(sel), 'ａ'); // no count: how many is worked out on the drop

    const held = renderKlondike(s, { cursor: pile.tableau(0), held: { from: pile.waste } });
    cardsPlain(held);
    assert.equal(held.get(colX(1) + 2, 2).bg, 'hold'); // w, the waste
    assert.equal(held.get(colX(0) + 2, 5).bg, 'cursor'); // the cursor still shows the target

    const own = renderKlondike(s, { cursor: pile.tableau(0), held: { from: pile.tableau(0) } });
    assert.equal(own.get(colX(0) + 2, 5).bg, 'hold');
    assert.equal(qLabel(own), 'ａ');

    // The cursor can sit on a foundation, and its quiet label lights up.
    const onF = renderKlondike(s, { cursor: pile.foundation(1) });
    assert.equal(onF.get(colX(4) + 2, 2).bg, 'cursor');
    assert.equal(onF.get(colX(4) + 2, 2).fg, 'key');
  });

  test('a held foundation lights up its quiet label', () => {
    const s = board({ foundations: ['AS'] });
    const buf = renderKlondike(s, { cursor: pile.tableau(0), held: { from: pile.foundation(0) } });
    assert.equal(buf.get(colX(3) + 2, 2).bg, 'hold');
    assert.equal(buf.get(colX(3) + 2, 2).fg, 'key');
  });

  test('empty foundations show A, not a suit', () => {
    const buf = renderKlondike(board({ foundations: [, 'AH'] }), view);
    assert.equal(cells(buf, colX(3), 3, 30), '[ Ａ ]   Ａ♥\uFE0F   [ Ａ ]  [ Ａ ]');
  });

  test('draw 3 fans the top three waste cards', () => {
    const s = board({ waste: '2C 3D 4S 5H', drawMode: 3 });
    const buf = renderKlondike(s, view);
    // Each covered card keeps its rank and suit; a blank cell is left before the foundations.
    assert.equal(cells(buf, colX(1), 3, 16), ' ３♦\uFE0F ４♠\uFE0F ５♥\uFE0F ');
    assert.equal(buf.get(colX(1) + 15, 3).bg, 'none');
    assert.equal(buf.get(colX(1) + 14, 3).bg, 'card');
  });

  test('status bar promotes i and fits the minimum width', () => {
    const buf = renderKlondike(deal(1), view);
    const lines = buf.toText().split('\n');
    const status = lines.slice(-2);
    assert.match(status[0]!, /i to foundation/);
    assert.match(status[1]!, /esc menu/);
    assert.doesNotMatch(status.join('\n'), /\br\b|\bu\b/);
    assert.equal(buf.get(colX(3) + 2, 2).fg, 'dim'); // the r label is quiet
    for (const line of status) assert.ok(line.length <= MIN_WIDTH, `too wide: "${line}"`);
  });

  test('the board is centred in wider terminals', () => {
    const buf = renderKlondike(deal(1), view, { width: 100 });
    assert.equal(buf.width, 100);
    assert.equal(buf.get(Math.floor((100 - BOARD_WIDTH) / 2) + 2, 5).ch, 'ａ');
  });
});

describe('cards and dialogs', () => {
  test('faces are white, backs are grey, slots and labels have no card background', () => {
    const buf = renderKlondike(board({ waste: 'KH', tableau: ['3C | 9S'] }), view);
    const waste = buf.get(colX(1) + 1, 3); // the K of K♥
    assert.deepEqual([waste.ch, waste.bg, waste.fg], ['Ｋ', 'card', 'red']);
    assert.equal(buf.get(colX(1), 3).bg, 'card'); // the padding is face too
    assert.equal(buf.get(colX(1), 4).bg, 'none'); // and the card ends there
    const spade = buf.get(colX(0) + 3, 7); // the ♠ of 9♠
    assert.deepEqual([spade.ch, spade.bg, spade.fg], ['♠\uFE0F', 'card', 'black']);
    assert.equal(buf.get(colX(0), 6).bg, 'back'); // the face-down 3♣
    assert.equal(buf.get(colX(3), 3).bg, 'none'); // empty foundation slot
    assert.equal(buf.get(colX(0) + 2, 5).bg, 'cursor'); // the q label
  });

  test('cards use exact colors; everything else stays on the 16-color palette', () => {
    const view2: View = { ...view, held: { from: pile.tableau(1) } };
    const sgrs = (theme: typeof colorTheme) =>
      [...paint(renderKlondike(deal(2), view2), theme).matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]!);
    const basic = new Set([0, 1, 4, 30, 32, 39, 42, 90, 92, 102]);
    for (const [theme, face, black, red, back] of [
      [colorTheme, '48;5;253', '38;5;16', '38;5;160', '48;5;242'],
      [truecolorTheme, '48;2;221;221;221', '38;2;0;0;0', '38;2;204;0;0', '48;2;108;108;108'],
    ] as const) {
      const all = sgrs(theme);
      assert.ok(all.some((x) => x.includes(face) && x.includes(red)), `${theme.name}: red on white`);
      assert.ok(all.some((x) => x.includes(face) && x.includes(black)), `${theme.name}: black on white`);
      assert.ok(all.some((x) => x.includes(back)), `${theme.name}: grey back`);
      // Strip the fixed card colors; what remains must be basic codes.
      const rest = all.map((x) => x.replace(/[34]8;(5;\d+|2;\d+;\d+;\d+)|58:[\d:]+/g, '')).flatMap((x) => x.split(';')).filter(Boolean).map(Number);
      for (const c of rest) assert.ok(basic.has(c), `${theme.name}: code ${c}`);
    }
  });

  test('card text is bold, and every card with one below it has an edge', () => {
    const buf = renderKlondike(board({ waste: 'KH', tableau: ['3C 4C | 9S 8H'] }), view);
    assert.equal(buf.get(colX(1) + 1, 3).bold, true);
    assert.equal(buf.get(colX(1), 3).edge, false); // a lone waste card
    const edges = [6, 7, 8, 9].map((y) => buf.get(colX(0), y).edge);
    assert.deepEqual(edges, [true, true, true, false]); // back, back, 9♠ edged; 8♥ is last
    const tc = truecolorTheme.sgr(buf.get(colX(0) + 1, 8));
    assert.match(tc, /;4;58:2::153:153:153/); // faint grey hairline on the face
    assert.match(colorTheme.sgr(buf.get(colX(0) + 1, 8)), /;1;4$/);
  });

  test('cards default to the soft ddd face; SOLITERMINAL_CARD=fff gives pure white', () => {
    const red = { ch: 'K', fg: 'red', bg: 'card', bold: true, edge: true } as const;
    assert.equal(truecolorTheme.sgr(red), '0;38;2;204;0;0;48;2;221;221;221;1;4;58:2::153:153:153');
    assert.equal(colorTheme.sgr(red), '0;38;5;160;48;5;253;1;4');
    for (const v of [undefined, '', 'ddd', '#DDD', 'purple']) {
      assert.equal(pickTheme({ SOLITERMINAL_CARD: v }, true), colorTheme, String(v));
    }
    const white = pickTheme({ COLORTERM: 'truecolor', SOLITERMINAL_CARD: '#FFF' }, true);
    assert.equal(white.name, 'color-truecolor-fff-green');
    assert.equal(white.sgr(red), '0;38;2;255;0;0;48;2;255;255;255;1;4;58:2::170:170:170');
    assert.equal(pickTheme({ SOLITERMINAL_CARD: 'fff' }, true).sgr(red), '0;38;5;196;48;5;231;1;4');
    // Only the face changes; backs stay the same grey.
    const back = { ch: ' ', fg: 'back', bg: 'back', bold: false, edge: false } as const;
    assert.equal(white.sgr(back), truecolorTheme.sgr(back));
  });

  test('themes take one color family from the basic palette, strong and weak', () => {
    const key = { ch: 'q', fg: 'key', bg: 'none', bold: false, edge: false } as const;
    const header = { ...key, fg: 'header' } as const;
    const cursor = { ...key, bg: 'cursor' } as const;
    const hold = { ...key, bg: 'hold' } as const;
    // Default green: bright green keys, green header, green cursor, bright green hold.
    assert.deepEqual([key, header, cursor, hold].map((c) => colorTheme.sgr(c)), ['0;92', '0;32', '0;30;42;1', '0;30;102;1']);
    const blue = pickTheme({}, true, 'blue');
    assert.deepEqual([key, header, cursor, hold].map((c) => blue.sgr(c)), ['0;94', '0;34', '0;30;44;1', '0;30;104;1']);
    assert.equal(pickTheme({ SOLITERMINAL_THEME: 'Magenta' }, true).sgr(key), '0;95');
    assert.equal(pickTheme({ SOLITERMINAL_THEME: 'magenta' }, true, 'cyan').sgr(key), '0;96'); // --theme wins
    assert.equal(pickTheme({ SOLITERMINAL_THEME: 'plaid' }, true), colorTheme);
    // A chosen card: the theme's bright shade behind the card's own suit colors.
    const chosen = { ch: '7', fg: 'red', bg: 'chosen', bold: true, edge: false } as const;
    assert.equal(colorTheme.sgr(chosen), '0;38;5;160;102;1');
    assert.equal(blue.sgr({ ...chosen, fg: 'black' }), '0;38;5;16;104;1');
    assert.equal(monoTheme.sgr(chosen), '0;1;4');
    // Bad news stays red in every theme; cards do not change.
    const red = { ...key, fg: 'red' } as const;
    const face = { ch: 'K', fg: 'red', bg: 'card', bold: true, edge: false } as const;
    assert.equal(blue.sgr(red), '0;31');
    assert.equal(blue.sgr(face), colorTheme.sgr(face));
  });

  test('labels are centred over their cards, large and compact', () => {
    const big = renderKlondike(deal(1), view);
    assert.equal(cells(big, colX(0), 2, 6), '  ｑ  ');
    assert.equal(cells(big, colX(3), 2, 6), '  ｒ  ');
    assert.equal(cells(big, colX(6), 5, 6), '  ｊ  ');
    const small = renderKlondike(deal(1), view, { compact: true });
    const cx = (i: number) => Math.floor((MIN_WIDTH - COMPACT.board) / 2) + i * COMPACT.pitch;
    assert.equal(cells(small, cx(0), 2, 4), ' q  ');
    assert.equal(cells(small, cx(3), 2, 4), ' r  ');
  });

  test('truecolor only when the terminal says so', () => {
    assert.equal(pickTheme({ COLORTERM: 'truecolor' }, true), truecolorTheme);
    assert.equal(pickTheme({ COLORTERM: '24bit' }, true), truecolorTheme);
    assert.equal(pickTheme({}, true), colorTheme);
  });

  test('a dialog is a box over the board with its title, text and choices', () => {
    const dialog = { title: 'Restart this deal?', lines: ['Every move so far will be undone.'], choices: ['Restart', 'Keep playing'], selected: 0 };
    const lines = renderKlondike(deal(1), { ...view, dialog }).toText().split('\n');
    const top = lines.findIndex((l) => l.includes('Restart this deal?'));
    assert.ok(top > 0);
    assert.match(lines[top]!, /╭─ Restart this deal\? ─+╮/);
    assert.match(lines[top + 1]!, /│ Every move so far will be undone\. +│/);
    assert.match(lines[top + 3]!, /│ › \(R\)estart +│/);
    assert.match(lines[top + 4]!, /│   \(K\)eep playing +│/);
    assert.match(lines[top + 6]!, /│ ↑↓ or letter choose {2}enter select {2}esc back +│/);
    assert.match(lines[top + 7]!, /╰─+╯/);
    // The box spans the board exactly, and nothing of the board shows beside or under it.
    const x = colX(0);
    for (let i = top; i < top + 8; i++) {
      assert.match(lines[i]!.slice(x, x + BOARD_WIDTH), /^[╭│╰].*[╮│╯]$/, `row ${i}`);
      assert.equal(lines[i]!.slice(x + BOARD_WIDTH).trim(), '', `row ${i}`);
    }
    assert.equal(lines[top + 8]!.trim(), '');
    // The highlighted choice is a bar across the box.
    const buf = renderKlondike(deal(1), { ...view, dialog: { ...dialog, selected: 1 } });
    assert.equal(buf.get(x + 5, top + 4).bg, 'cursor');
    assert.equal(buf.get(x + 5, top + 3).bg, 'none');
  });
});

describe('diff against a virtual terminal', () => {
  /**
   * Understands what our renderer emits: clear, cursor moves, SGR, text. Wide
   * characters take two cells as in a real terminal (`''` marks the right half).
   * `suitWidth` is how wide this terminal draws ♠♥♦♣.
   */
  function makeTerminal(width: number, height: number, suitWidth: 1 | 2) {
    let grid = Array.from({ length: height }, () => Array<string>(width).fill(' '));
    let x = 0;
    let y = 0;
    const clearHalf = (cx: number) => {
      const row = grid[y]!;
      if (row[cx] === '' && cx > 0) row[cx - 1] = ' ';
      if (row[cx + 1] === '') row[cx + 1] = ' ';
    };
    return {
      write(out: string) {
        const re = /\x1b\[([0-9;:?]*)([A-Za-z])|([\s\S]\uFE0F?)/gu;
        for (const m of out.matchAll(re)) {
          if (m[3] !== undefined) {
            const w = isEmoji(m[3]) ? suitWidth : charWidth(m[3]);
            clearHalf(x);
            if (w === 2) clearHalf(x + 1);
            grid[y]![x] = m[3];
            if (w === 2) grid[y]![x + 1] = '';
            x += w;
          } else if (m[2] === 'J') grid = grid.map((row) => row.fill(' '));
          else if (m[2] === 'G') x = Number(m[1] || 1) - 1;
          else if (m[2] === 'H') {
            const [r = 1, c = 1] = (m[1] || '1;1').split(';').map(Number);
            y = r - 1;
            x = c - 1;
          }
        }
      },
      text: () => grid.map((row) => row.join('').trimEnd()).join('\n'),
    };
  }

  test('partial redraws always leave the screen matching the latest frame', async () => {
    const { createApp, handleKey, viewOf } = await import('../src/app.ts');
    const keys = ['q', 'w', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'i', 'r', 'left', 'right', 'up', 'down', 'space', 'escape', 'tab', 'z', 'enter'];
    const rng = mulberry32(2024);
    for (let seed = 1; seed <= 6; seed++) {
      // Half the runs on a terminal that draws suits one cell wide, half two.
      const suitWidth = seed % 2 === 0 ? 2 : 1;
      let app = createApp(deal(seed));
      const term = makeTerminal(70, 26, suitWidth);
      let shown: ScreenBuffer | undefined;
      for (let step = 0; step < 300; step++) {
        app = handleKey(app, keys[Math.floor(rng() * keys.length)]!, step * 1000, () => ({ seed: seed * 1000 + step, verified: false }));
        const next = renderKlondike(app.game, viewOf(app, step * 1000), { width: 70, height: 26 });
        term.write(diff(shown, next, colorTheme));
        shown = next;
        // A one-cell suit leaves the blank the renderer painted beside it.
        const seen = suitWidth === 1 ? term.text().replace(/([♠♥♦♣]\uFE0F) /g, '$1') : term.text();
        assert.equal(seen, next.toText(), `seed ${seed} step ${step}`);
      }
    }
  });
});
