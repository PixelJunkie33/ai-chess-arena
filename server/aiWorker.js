// Runs one engine search off the main thread so the 2 s search never blocks Socket.io.
import { parentPort, workerData } from 'node:worker_threads';
import { Chess } from 'chess.js';
import { chooseMove } from '../client/js/ChessEngine.js';

const { fen, personality, timeMs } = workerData;
parentPort.postMessage(chooseMove(new Chess(fen), personality, { timeMs }));
