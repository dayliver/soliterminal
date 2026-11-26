import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, mulberry32, shuffle } from '../src/core/deck.ts';

const key = (c: { suit: string; rank: number }) => c.suit + c.rank;

test('deck has 52 distinct cards', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map(key)).size, 52);
});

test('the same seed always shuffles the same way', () => {
  const a = shuffle(createDeck(), mulberry32(42)).map(key);
  const b = shuffle(createDeck(), mulberry32(42)).map(key);
  const c = shuffle(createDeck(), mulberry32(43)).map(key);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('shuffle keeps every card and leaves the input alone', () => {
  const deck = createDeck();
  const before = deck.map(key);
  const out = shuffle(deck, mulberry32(7));
  assert.deepEqual(deck.map(key), before);
  assert.deepEqual([...out.map(key)].sort(), [...before].sort());
});

test('rng stays in [0, 1)', () => {
  const rng = mulberry32(1);
  for (let i = 0; i < 10_000; i++) {
    const x = rng();
    assert.ok(x >= 0 && x < 1);
  }
});
