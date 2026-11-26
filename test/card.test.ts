import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardLabel, colorOf, parseCard } from '../src/core/card.ts';

test('ten is labelled X so every label is two cells', () => {
  assert.equal(cardLabel({ suit: 'H', rank: 10 }), 'X♥');
  assert.equal(cardLabel({ suit: 'S', rank: 1 }), 'A♠');
  assert.equal(cardLabel({ suit: 'C', rank: 13 }, true), 'KC');
  for (let rank = 1; rank <= 13; rank++) {
    assert.equal([...cardLabel({ suit: 'D', rank: rank as 1 })].length, 2);
  }
});

test('hearts and diamonds are red', () => {
  assert.equal(colorOf({ suit: 'H', rank: 5 }), 'red');
  assert.equal(colorOf({ suit: 'D', rank: 5 }), 'red');
  assert.equal(colorOf({ suit: 'S', rank: 5 }), 'black');
  assert.equal(colorOf({ suit: 'C', rank: 5 }), 'black');
});

test('parseCard accepts letters, symbols and 10', () => {
  assert.deepEqual(parseCard('XH'), { suit: 'H', rank: 10 });
  assert.deepEqual(parseCard('10h'), { suit: 'H', rank: 10 });
  assert.deepEqual(parseCard('K♠'), { suit: 'S', rank: 13 });
  assert.deepEqual(parseCard('as'), { suit: 'S', rank: 1 });
  assert.throws(() => parseCard('1S'));
  assert.throws(() => parseCard('KX'));
});
