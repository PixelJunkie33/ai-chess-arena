import { Worker } from 'node:worker_threads';
import { Chess } from 'chess.js';
import { chooseMove } from '../client/js/ChessEngine.js';

const SEARCH_MS = 2000;       // engine hard cutoff
const GRACE_MS = 600;         // worker start-up / teardown allowance before we give up on it

/**
 * Ask the engine for a move. Resolves with a move event (see README), or null if the
 * position has no legal moves. Never rejects: if the worker fails or overruns the time
 * limit it is terminated and a random legal move is played instead.
 */
export function requestMove(fen, personality) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(ev);
    };
    const worker = new Worker(new URL('./aiWorker.js', import.meta.url), {
      workerData: { fen, personality, timeMs: SEARCH_MS },
    });
    const timer = setTimeout(() => finish(fallbackMove(fen)), SEARCH_MS + GRACE_MS);
    worker.once('message', finish);
    worker.once('error', () => finish(fallbackMove(fen)));
    worker.once('exit', () => finish(fallbackMove(fen)));
  });
}

function fallbackMove(fen) {
  const game = new Chess(fen);
  const moves = game.moves({ verbose: true }).filter((m) => !m.promotion || m.promotion === 'q');
  if (!moves.length) return null;
  const m = moves[Math.floor(Math.random() * moves.length)];
  game.move({ from: m.from, to: m.to, promotion: 'q' });
  return {
    from: m.from, to: m.to, promotion: 'q', san: m.san, fen: game.fen(),
    moveNumber: parseInt(fen.split(' ')[5], 10), evaluation: 0,
    inCheck: game.inCheck(), thinkingLine: [m.san],
  };
}

export { chooseMove };
