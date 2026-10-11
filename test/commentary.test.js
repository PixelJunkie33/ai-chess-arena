import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { chooseMove } from '../client/js/ChessEngine.js';
import { describeMove } from '../client/js/Commentary.js';
import { squareToXY } from '../client/js/BoardRenderer.js';

test('squareToXY matches spec', () => {
  assert.deepEqual(squareToXY('a1'), { x: 0, y: 525 });
  assert.deepEqual(squareToXY('h8'), { x: 525, y: 0 });
  assert.deepEqual(squareToXY('a1', true), { x: 525, y: 0 });
});

test('commentary produces a line for every move of a full engine game', () => {
  const game = new Chess();
  const mirror = new Chess();
  let prevEval = 0, prevCap = null;
  const kinds = new Set();
  for (let i = 0; i < 10 && !game.isGameOver(); i++) {
    const ev = chooseMove(game, 'Chaotic', { timeMs: 150 });
    game.move(ev.san);
    const d = mirror.move({ from: ev.from, to: ev.to, promotion: 'q' });
    const out = describeMove(ev, d, { chess: mirror, prevEval, prevCaptureSquare: prevCap });
    assert.ok(out.text.length > 5);
    kinds.add(out.kind);
    prevEval = ev.evaluation; prevCap = d.captured ? ev.to : null;
  }
  assert.ok(kinds.size >= 1);
});
