import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { colorOf } from '../src/core/card.ts';
import { mulberry32 } from '../src/core/deck.ts';
import {
  type KlondikeState,
  type PileId,
  autoComplete,
  autoMove,
  canAutoComplete,
  deal,
  destinations,
  draw,
  fittingCount,
  isWon,
  maxTake,
  move,
  moveTo,
  moveToFoundation,
  pile,
} from '../src/core/klondike.ts';
import { allCards, board, label, labels } from './helpers.ts';

const { waste, foundation: f, tableau: t } = pile;

function expectOk(result: ReturnType<typeof move>): KlondikeState {
  if (!result.ok) assert.fail(`expected ok, got ${result.error}`);
  return result.state;
}

describe('deal', () => {
  test('lays out 1..7 cards with one face up per column', () => {
    const s = deal(1);
    s.tableau.forEach((col, i) => {
      assert.equal(col.down.length, i);
      assert.equal(col.up.length, 1);
    });
    assert.equal(s.stock.length, 24);
    assert.equal(s.waste.length, 0);
    assert.deepEqual(s.foundations.map((p) => p.length), [0, 0, 0, 0]);
  });

  test('uses all 52 cards exactly once', () => {
    const keys = allCards(deal(99)).map(label);
    assert.equal(keys.length, 52);
    assert.equal(new Set(keys).size, 52);
  });

  test('is reproducible from the seed', () => {
    assert.deepEqual(deal(5), deal(5));
    assert.notDeepEqual(deal(5).tableau, deal(6).tableau);
  });
});

describe('draw', () => {
  test('draw 1 turns the top stock card onto the waste', () => {
    const s = expectOk(draw(board({ stock: '2C 3C 4C' })));
    assert.equal(labels(s.stock), '2C 3C');
    assert.equal(labels(s.waste), '4C');
    assert.equal(s.moves, 1);
  });

  test('draw 3 leaves the third card turned on top', () => {
    const s = expectOk(draw(board({ stock: '2C 3C 4C 5C', drawMode: 3 })));
    assert.equal(labels(s.stock), '2C');
    assert.equal(labels(s.waste), '5C 4C 3C');
  });

  test('draw 3 with fewer than 3 left turns what is there', () => {
    const s = expectOk(draw(board({ stock: '2C 3C', waste: 'KH', drawMode: 3 })));
    assert.equal(labels(s.stock), '');
    assert.equal(labels(s.waste), 'KH 3C 2C');
  });

  test('empty stock recycles the waste in original order', () => {
    const start = board({ stock: '2C 3C 4C' });
    let s = start;
    for (let i = 0; i < 3; i++) s = expectOk(draw(s));
    s = expectOk(draw(s));
    assert.equal(labels(s.stock), labels(start.stock));
    assert.equal(s.waste.length, 0);
  });

  test('nothing to draw or recycle is an error', () => {
    assert.deepEqual(draw(board({})), { ok: false, error: 'stock-empty' });
  });
});

describe('redeals', () => {
  test('a deal allows three redeals by default', () => {
    assert.equal(deal(1).redealsLeft, 3);
    assert.equal(deal(1, 3, Infinity).redealsLeft, Infinity);
  });

  test('each redeal uses one up, and with none left the waste stays put', () => {
    let s = board({ waste: '2C 3C', redealsLeft: 1 });
    s = expectOk(draw(s));
    assert.equal(s.redealsLeft, 0);
    assert.equal(labels(s.stock), '3C 2C');
    s = expectOk(draw(expectOk(draw(s)))); // turn both again
    const stuck = draw(s);
    assert.deepEqual(stuck, { ok: false, error: 'no-redeals' });
  });

  test('turning cards from the stock costs no redeal', () => {
    assert.equal(expectOk(draw(deal(1))).redealsLeft, 3);
  });

  test('no limit means the waste can always be turned over', () => {
    let s = board({ waste: '2C', redealsLeft: Infinity });
    for (let i = 0; i < 20; i++) s = expectOk(draw(s));
    assert.equal(s.redealsLeft, Infinity);
  });
});

describe('tableau moves', () => {
  test('places on opposite color, one rank higher', () => {
    const s = board({ tableau: ['| 9H', '| 8S'] });
    const next = expectOk(move(s, t(1), t(0)));
    assert.equal(labels(next.tableau[0]!.up), '9H 8S');
    assert.equal(next.tableau[1]!.up.length, 0);
  });

  test('rejects same color or wrong rank', () => {
    const s = board({ tableau: ['| 9H', '| 8D', '| 7S'] });
    assert.deepEqual(move(s, t(1), t(0)), { ok: false, error: 'not-allowed' });
    assert.deepEqual(move(s, t(2), t(0)), { ok: false, error: 'not-allowed' });
  });

  test('turns over the next face-down card', () => {
    const s = board({ tableau: ['| 9H', '4C 5D | 8S'] });
    const next = expectOk(move(s, t(1), t(0)));
    assert.equal(labels(next.tableau[1]!.down), '4C');
    assert.equal(labels(next.tableau[1]!.up), '5D');
  });

  test('moves a run of several cards', () => {
    const s = board({ tableau: ['| XS', '3D | 9H 8C 7D'] });
    const next = expectOk(move(s, t(1), t(0), 3));
    assert.equal(labels(next.tableau[0]!.up), 'XS 9H 8C 7D');
    assert.equal(labels(next.tableau[1]!.up), '3D');
  });

  test('only a king goes into an empty column', () => {
    const s = board({ tableau: ['', '| QH', 'AS | KC QD'] });
    assert.deepEqual(move(s, t(1), t(0)), { ok: false, error: 'not-allowed' });
    const next = expectOk(move(s, t(2), t(0), 2));
    assert.equal(labels(next.tableau[0]!.up), 'KC QD');
  });

  test('rejects counts the source cannot give', () => {
    const s = board({ tableau: ['| XS', '| 9H 8C'] });
    assert.deepEqual(move(s, t(1), t(0), 3), { ok: false, error: 'bad-count' });
    assert.deepEqual(move(s, t(1), t(0), 0), { ok: false, error: 'bad-count' });
    assert.deepEqual(move(s, t(3), t(0)), { ok: false, error: 'empty-source' });
    assert.deepEqual(move(s, t(1), t(1)), { ok: false, error: 'same-pile' });
  });

  test('never changes the original state', () => {
    const s = board({ tableau: ['| 9H', '4C | 8S'] });
    const snapshot = structuredClone(s);
    expectOk(move(s, t(1), t(0)));
    assert.deepEqual(s, snapshot);
  });

  test('bad pile index throws', () => {
    const s = board({});
    assert.throws(() => move(s, t(7), t(0)), RangeError);
    assert.throws(() => move(s, waste, f(4)), RangeError);
  });
});

describe('waste and foundations', () => {
  test('any ace starts any empty foundation', () => {
    const s = board({ waste: 'AH' });
    for (let i = 0; i < 4; i++) {
      const next = expectOk(move(s, waste, f(i)));
      assert.equal(labels(next.foundations[i]!), 'AH');
      assert.equal(next.waste.length, 0);
    }
  });

  test('only an ace goes on an empty foundation', () => {
    assert.deepEqual(move(board({ waste: '2H' }), waste, f(0)), { ok: false, error: 'not-allowed' });
  });

  test('the ace fixes that pile\'s suit', () => {
    const s = board({ foundations: [, 'AD'], tableau: ['| 2H', '| 2D'] });
    assert.deepEqual(move(s, t(0), f(1)), { ok: false, error: 'not-allowed' });
    assert.equal(labels(expectOk(move(s, t(1), f(1))).foundations[1]!), 'AD 2D');
  });

  test('a foundation key is exact and says when another pile would take the card', () => {
    const s = board({ foundations: ['AC', 'AD'], waste: 'AS', tableau: ['| 2D', '| 5H'] });
    // 2D belongs on the second pile, not the fourth.
    assert.deepEqual(moveTo(s, t(0), f(3)), { ok: false, error: 'wrong-foundation' });
    assert.equal(labels(expectOk(moveTo(s, t(0), f(1))).foundations[1]!), 'AD 2D');
    // An ace goes exactly where it was sent if that pile is empty.
    assert.equal(labels(expectOk(moveTo(s, waste, f(3))).foundations[3]!), 'AS');
    assert.deepEqual(moveTo(s, waste, f(0)), { ok: false, error: 'wrong-foundation' });
    // A card that fits no foundation at all is plainly not allowed.
    assert.deepEqual(moveTo(s, t(1), f(0)), { ok: false, error: 'not-allowed' });
  });

  test('foundations build up by suit one card at a time', () => {
    const s = board({ foundations: ['AS 2S'], tableau: ['| 4D 3S', '| 4S'] });
    // 4S skips a rank, and the 3S run of two cannot go up at once.
    assert.deepEqual(move(s, t(1), f(0)), { ok: false, error: 'not-allowed' });
    assert.deepEqual(move(s, t(0), f(0), 2), { ok: false, error: 'not-allowed' });
    const next = expectOk(move(s, t(0), f(0)));
    assert.equal(labels(next.foundations[0]!), 'AS 2S 3S');
  });

  test('a foundation card can come back to the tableau', () => {
    const s = board({ foundations: [, 'AH 2H 3H'], tableau: ['| 4C'] });
    const next = expectOk(move(s, f(1), t(0)));
    assert.equal(labels(next.tableau[0]!.up), '4C 3H');
    assert.equal(labels(next.foundations[1]!), 'AH 2H');
  });

  test('nothing can be placed on the waste', () => {
    const s = board({ waste: 'KH', tableau: ['| QS'] });
    assert.deepEqual(move(s, t(0), waste), { ok: false, error: 'not-allowed' });
  });

  test('only one waste card can be taken', () => {
    assert.equal(maxTake(board({ waste: '2C 3C' }), waste), 1);
    assert.equal(maxTake(board({}), waste), 0);
  });
});

describe('moveToFoundation (F9)', () => {
  test('goes on the pile that already has the suit', () => {
    const s = board({ foundations: ['AC', 'AD'], tableau: ['3S | 2D'] });
    const next = expectOk(moveToFoundation(s, t(0)));
    assert.equal(labels(next.foundations[1]!), 'AD 2D');
    assert.equal(labels(next.tableau[0]!.up), '3S'); // and the card below turns over
  });

  test('an ace takes the first empty pile', () => {
    const s = board({ foundations: ['AC', , 'AH'], waste: 'AS' });
    assert.equal(labels(expectOk(moveToFoundation(s, waste)).foundations[1]!), 'AS');
  });

  test('fails when the card fits no foundation', () => {
    const s = board({ foundations: ['AC'], waste: '3C', tableau: ['| 2H'] });
    assert.deepEqual(moveToFoundation(s, waste), { ok: false, error: 'not-allowed' });
    assert.deepEqual(moveToFoundation(s, t(0)), { ok: false, error: 'not-allowed' });
    assert.deepEqual(moveToFoundation(s, t(1)), { ok: false, error: 'empty-source' });
    assert.deepEqual(moveToFoundation(s, f(0)), { ok: false, error: 'same-pile' });
  });
});

describe('moveTo picks the card count', () => {
  test('finds the run that fits the destination', () => {
    const s = board({ tableau: ['| 8D', '| KS QH JC XD 9S 8H 7C'] });
    assert.equal(fittingCount(s, t(1), t(0)), 1);
    const s2 = board({ tableau: ['| XH', '| KS QH JC XD 9S 8H 7C'] });
    assert.equal(fittingCount(s2, t(1), t(0)), 3);
    const next = expectOk(moveTo(s2, t(1), t(0)));
    assert.equal(labels(next.tableau[0]!.up), 'XH 9S 8H 7C');
  });

  test('moves the whole king-led run into an empty column', () => {
    const s = board({ tableau: ['', '2D | KS QH JC'] });
    const next = expectOk(moveTo(s, t(1), t(0)));
    assert.equal(labels(next.tableau[0]!.up), 'KS QH JC');
    assert.equal(labels(next.tableau[1]!.up), '2D');
  });

  test('reports why nothing moved', () => {
    const s = board({ tableau: ['| 9H', '| 9S'] });
    assert.deepEqual(moveTo(s, t(1), t(0)), { ok: false, error: 'not-allowed' });
    assert.deepEqual(moveTo(s, t(2), t(0)), { ok: false, error: 'empty-source' });
  });
});

describe('autoMove (same key twice)', () => {
  test('sends an ace to the first empty foundation', () => {
    const s = board({ foundations: ['AC'], tableau: ['| AH'] });
    assert.equal(labels(expectOk(autoMove(s, t(0))).foundations[1]!), 'AH');
  });

  test('prefers the foundation', () => {
    const s = board({ foundations: ['AS'], tableau: ['| 3H', '| 2S'] });
    const next = expectOk(autoMove(s, t(1)));
    assert.equal(labels(next.foundations[0]!), 'AS 2S');
  });

  test('then a column with cards, then an empty column', () => {
    const s = board({ tableau: ['', '| XH', '4C | 9S'] });
    assert.deepEqual(destinations(s, t(2)), [t(1)]);
    // Unlisted columns are empty too, so every one of them can take the king.
    const king = board({ tableau: ['', '4C | KD'] });
    assert.deepEqual(destinations(king, t(1)), [0, 2, 3, 4, 5, 6].map(t));
  });

  test('skips moving a bare king column into another empty column', () => {
    const s = board({ tableau: ['', '| KD QS'] });
    assert.deepEqual(destinations(s, t(1)), []);
    assert.deepEqual(autoMove(s, t(1)), { ok: false, error: 'no-move' });
    // The same goes for exactly those cards, chosen with the arrows.
    assert.deepEqual(destinations(s, t(1), 2), []);
  });

  test('with a count, only places that take exactly that many cards', () => {
    const s = board({ tableau: ['| 9H 8S AD', '| 9D', '| 2C'], foundations: [] });
    // However many fit: the ace alone goes home or on the 2, the 8 with it goes on the 9.
    assert.deepEqual(destinations(s, t(0)), [f(0), t(1), t(2)]);
    assert.deepEqual(destinations(s, t(0), 1), [f(0), t(2)]);
    assert.deepEqual(destinations(s, t(0), 2), [t(1)]);
    assert.deepEqual(destinations(s, t(0), 3), []);
    assert.deepEqual(destinations(s, t(0), 4), []); // more than the column has
  });

  test('moves the waste card too', () => {
    const s = board({ waste: '7D', tableau: ['| 8S'] });
    const next = expectOk(autoMove(s, waste));
    assert.equal(labels(next.tableau[0]!.up), '8S 7D');
  });
});

describe('winning', () => {
  const nearlyDone = () =>
    board({
      foundations: ['AS 2S 3S 4S 5S 6S 7S 8S 9S XS JS', 'AH 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH', 'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD', 'AC 2C 3C 4C 5C 6C 7C 8C 9C XC JC'],
      tableau: ['| KS', '| KC QS', '| KH QC'],
    });

  test('auto-complete works whatever order the suits landed in', () => {
    const s = board({
      foundations: ['AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD', 'AC 2C 3C 4C 5C 6C 7C 8C 9C XC JC QC', 'AH 2H 3H 4H 5H 6H 7H 8H 9H XH JH QH', 'AS 2S 3S 4S 5S 6S 7S 8S 9S XS JS QS'],
      tableau: ['| KS', '| KH', '| KC', '| KD'],
    });
    const last = autoComplete(s).at(-1)!;
    assert.equal(isWon(last), true);
    assert.deepEqual(last.foundations.map((p) => p[0]!.suit), ['D', 'C', 'H', 'S']);
  });

  test('auto-complete starts new foundations with aces', () => {
    const s = board({ foundations: [, 'AD 2D 3D 4D 5D 6D 7D 8D 9D XD JD QD KD'], tableau: ['| 2H', '| AH'] });
    assert.equal(canAutoComplete(s), true);
    const last = autoComplete(s).at(-1)!;
    assert.equal(labels(last.foundations[0]!), 'AH 2H');
  });

  test('auto-complete plays every card home', () => {
    const s = nearlyDone();
    assert.equal(canAutoComplete(s), true);
    const steps = autoComplete(s);
    assert.equal(steps.length, 5);
    assert.equal(isWon(steps[steps.length - 1]!), true);
  });

  test('auto-complete waits while cards are hidden or in the stock', () => {
    assert.equal(canAutoComplete(board({ stock: '2C', tableau: ['| KS'] })), false);
    assert.equal(canAutoComplete(board({ tableau: ['2C | KS'] })), false);
    assert.deepEqual(autoComplete(board({ tableau: ['2C | KS'] })), []);
  });
});

describe('random play keeps the game consistent', () => {
  test('cards are conserved and face-up runs stay valid', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed * 7919);
      let s = deal(seed, seed % 2 ? 1 : 3);
      const piles: PileId[] = [waste, ...[0, 1, 2, 3].map(f), ...[0, 1, 2, 3, 4, 5, 6].map(t)];
      for (let step = 0; step < 400; step++) {
        const legal = piles.flatMap((from) => destinations(s, from).map((to) => ({ from, to })));
        const pick = Math.floor(rng() * (legal.length + 1));
        const choice = legal[pick];
        const result = choice ? moveTo(s, choice.from, choice.to) : draw(s);
        if (!result.ok) break;
        s = result.state;

        const keys = allCards(s).map(label);
        assert.equal(new Set(keys).size, 52, `seed ${seed} step ${step}`);
        for (const col of s.tableau) {
          if (col.down.length > 0) assert.ok(col.up.length > 0, 'face-down card left uncovered');
          for (let i = 1; i < col.up.length; i++) {
            const [a, b] = [col.up[i - 1]!, col.up[i]!];
            assert.ok(a.rank === b.rank + 1 && colorOf(a) !== colorOf(b), `bad run ${labels(col.up)}`);
          }
        }
        s.foundations.forEach((p) => p.forEach((c, r) => {
          assert.equal(c.rank, r + 1);
          assert.equal(c.suit, p[0]!.suit);
        }));
      }
    }
  });
});

describe('positions', () => {
  test('positionKey ignores the move count and which foundation holds which suit', async () => {
    const { positionKey } = await import('../src/core/klondike.ts');
    const a = board({ foundations: ['AS', 'AH'], tableau: ['| 8S'] });
    const b = { ...board({ foundations: ['AH', 'AS'], tableau: ['| 8S'] }), moves: 9 };
    assert.equal(positionKey(a), positionKey(b));
    assert.notEqual(positionKey(a), positionKey(board({ foundations: ['AS', 'AH'], tableau: ['', '| 8S'] })));
    assert.notEqual(positionKey(a), positionKey({ ...a, redealsLeft: 1 }));
  });

  test('successors: the draw and every legal move of any count, each position once', async () => {
    const { positionKey, successors } = await import('../src/core/klondike.ts');
    // The draw; 7D or 7H onto 8S or 8C. Only a king may go to the empty column.
    const s = board({ stock: '2C', waste: '7D', tableau: ['| 8S', '| 8C', '| 9D 8S 7H', ''] });
    const keys = successors(s).map(positionKey);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(keys.length, 1 + 2 + 2);
    // Only the whole king run can go to an empty column: one position for each of the six empty ones.
    const kings = successors(board({ tableau: ['2C | KH QS'] })).map(positionKey);
    assert.equal(kings.length, 6);
  });
});
