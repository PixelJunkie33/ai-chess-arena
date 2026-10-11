import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { ChessEngine, chooseMove, PERSONALITIES } from '../client/js/ChessEngine.js';

test('every personality returns a legal move within the hard cutoff', () => {
  for (const name of Object.keys(PERSONALITIES)) {
    const game = new Chess();
    const t = Date.now();
    const ev = chooseMove(game, name);
    assert.ok(Date.now() - t < 2600, `${name} exceeded time budget`);
    assert.ok(game.moves().includes(ev.san), `${name} produced illegal move ${ev.san}`);
    assert.equal(ev.promotion, 'q');
    assert.equal(typeof ev.evaluation, 'number');
    assert.ok(Array.isArray(ev.thinkingLine));
  }
});

test('finds mate in one', () => {
  const game = new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
  const ev = chooseMove(game, 'Positional');
  assert.equal(ev.san, 'Ra8#');
});

test('evaluation is symmetric at the start position', () => {
  const e = new ChessEngine('Positional');
  assert.equal(e.evaluate(new Chess()), 0);
});

test('queen promotion is used', () => {
  const game = new Chess('5r1k/6P1/7K/8/8/8/8/8 w - - 0 1');
  const ev = chooseMove(game, 'Defender');
  assert.ok(ev.san.includes('=Q'));
});
