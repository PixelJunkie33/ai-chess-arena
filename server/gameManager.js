import { randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';
import { PERSONALITIES } from '../client/js/ChessEngine.js';
import { requestMove } from './aiRunner.js';
import { saveLiveState, recordMatch } from './persistence.js';

export const MAIN_ROOM = 'main';
const MAX_ROOMS = 50;
const BASE_MOVE_DELAY_MS = 1200;   // pause between moves at 1x speed
const THINK_TICK_MS = 250;
const AGENTS = Object.keys(PERSONALITIES);

const rooms = new Map();

const randomAgent = () => AGENTS[Math.floor(Math.random() * AGENTS.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isAgent = (n) => typeof n === 'string' && Object.hasOwn(PERSONALITIES, n);

/**
 * Room state machine:  idle → running ⇄ paused → over → (idle via reset / running via startMatch)
 * `gen` increments on every start/reset so a stale game loop notices and exits.
 */
export class GameManager {
  /** @param {import('socket.io').Server} io */
  constructor(io) {
    this.io = io;
    this.createRoom(MAIN_ROOM);
  }

  createRoom(id = randomUUID().slice(0, 8)) {
    if (rooms.has(id)) return rooms.get(id);
    if (rooms.size >= MAX_ROOMS) return null;
    const room = {
      id, game: new Chess(), status: 'idle', gen: 0, speed: 1,
      agentWhite: randomAgent(), agentBlack: randomAgent(),
      moves: [], result: null, startedAt: null, spectators: 0,
    };
    rooms.set(id, room);
    return room;
  }

  getRoom(id) { return rooms.get(id) ?? null; }

  snapshot(room) {
    return {
      roomId: room.id, status: room.status, fen: room.game.fen(), turn: room.game.turn(),
      agentWhite: room.agentWhite, agentBlack: room.agentBlack, speed: room.speed,
      moves: room.moves, result: room.result, startedAt: room.startedAt, spectators: room.spectators,
    };
  }

  emitState(room) {
    const snap = this.snapshot(room);
    this.io.to(room.id).emit('gameState', snap);
    saveLiveState(room.id, snap);
  }

  setSpectators(room, delta) {
    room.spectators = Math.max(0, room.spectators + delta);
    this.io.to(room.id).emit('spectators', { count: room.spectators });
  }

  start(room, agentWhite, agentBlack) {
    if (room.status === 'running' || room.status === 'paused') return false;
    room.gen++;
    room.game = new Chess();
    room.moves = [];
    room.result = null;
    if (isAgent(agentWhite)) room.agentWhite = agentWhite;
    if (isAgent(agentBlack)) room.agentBlack = agentBlack;
    room.status = 'running';
    room.startedAt = Date.now();
    this.emitState(room);
    this.loop(room, room.gen).catch((err) => console.error(`[room ${room.id}]`, err));
    return true;
  }

  /** Toggle pause/resume. */
  pause(room) {
    if (room.status === 'running') room.status = 'paused';
    else if (room.status === 'paused') room.status = 'running';
    else return;
    this.emitState(room);
  }

  reset(room) {
    room.gen++;                       // orphan any in-flight loop
    room.game = new Chess();
    room.moves = [];
    room.result = null;
    room.status = 'idle';
    room.startedAt = null;
    this.emitState(room);
  }

  setSpeed(room, speed) {
    const s = Number(speed);
    if (![0.5, 1, 2, 4].includes(s)) return;
    room.speed = s;
    this.emitState(room);
  }

  async loop(room, gen) {
    const alive = () => room.gen === gen;
    while (alive() && room.status !== 'over') {
      if (room.status === 'paused') { await sleep(200); continue; }

      const color = room.game.turn() === 'w' ? 'white' : 'black';
      const agent = color === 'white' ? room.agentWhite : room.agentBlack;
      const began = Date.now();
      const ticker = setInterval(() => {
        this.io.to(room.id).emit('thinking', { agent, color, elapsed: Date.now() - began });
      }, THINK_TICK_MS);

      let ev;
      try { ev = await requestMove(room.game.fen(), agent); } finally { clearInterval(ticker); }
      if (!alive()) return;
      if (!ev) { this.finish(room); return; }

      // Pace the game: spectators need time to read, scaled by the speed control.
      const wait = BASE_MOVE_DELAY_MS / room.speed - (Date.now() - began);
      if (wait > 0) await sleep(wait);
      while (alive() && room.status === 'paused') await sleep(200);
      if (!alive()) return;

      room.game.move({ from: ev.from, to: ev.to, promotion: 'q' });
      const event = { ...ev, color, agent };
      room.moves.push(event);
      this.io.to(room.id).emit('move', event);
      saveLiveState(room.id, this.snapshot(room));

      if (room.game.isGameOver()) { this.finish(room); return; }
    }
  }

  finish(room) {
    const g = room.game;
    let winner = 'draw', reason;
    if (g.isCheckmate()) { winner = g.turn() === 'w' ? 'black' : 'white'; reason = 'checkmate'; }
    else if (g.isStalemate()) reason = 'stalemate';
    else if (g.isInsufficientMaterial()) reason = 'insufficient material';
    else if (g.isThreefoldRepetition()) reason = 'threefold repetition';
    else if (g.isDrawByFiftyMoves()) reason = '50-move rule';
    else reason = 'draw';

    room.status = 'over';
    room.result = { winner, reason };
    this.io.to(room.id).emit('gameOver', room.result);
    this.emitState(room);
    recordMatch({
      matchId: randomUUID(), roomId: room.id, winner, reason,
      agentWhite: room.agentWhite, agentBlack: room.agentBlack,
      moveCount: room.moves.length, pgn: g.pgn(), finishedAt: new Date().toISOString(),
    });
  }
}
