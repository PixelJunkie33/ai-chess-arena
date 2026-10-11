import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';
import { BoardRenderer } from './BoardRenderer.js';
import { describeMove, CommentaryFeed } from './Commentary.js';
import { AgentSelector } from './AgentSelector.js';
import { StatsPanel } from './StatsPanel.js';
import { GameOverlay } from './GameOverlay.js';

const $ = (id) => document.getElementById(id);
const socket = window.io({ transports: ['websocket'] });   // loaded from /socket.io/socket.io.js

const board = new BoardRenderer($('board'));
const feed = new CommentaryFeed($('commentary'));
const stats = new StatsPanel();
const agents = new AgentSelector();
const overlay = new GameOverlay(() => socket.emit('startMatch', agents.value()));

const chess = new Chess();          // client-side mirror, used for commentary context
let status = 'idle';
let startedAt = null;
let prevEval = 0;
let prevCapture = null;
let animating = Promise.resolve();

// ---- helpers ------------------------------------------------------------------

function showCheck(fen, inCheck) {
  board.highlightCheck(inCheck ? BoardRenderer.kingSquare(fen, fen.split(' ')[1]) : null);
}

function applySnapshot(s) {
  status = s.status;
  startedAt = s.startedAt;
  chess.load(s.fen);
  board.setPosition(s.fen);
  const last = s.moves.at(-1);
  board.highlightSquares(last ? [last.from, last.to] : []);
  showCheck(s.fen, last?.inCheck);
  agents.set(s);
  agents.setLocked(status === 'running' || status === 'paused');
  $('speed').value = String(s.speed);
  $('btn-pause').textContent = status === 'paused' ? 'Resume' : 'Pause';
  $('spectator-count').textContent = s.spectators;

  stats.resetHistory();
  feed.clear();
  prevEval = 0;
  prevCapture = null;
  const replay = new Chess();
  for (const ev of s.moves) {
    stats.addMove(ev);
    const d = replay.move({ from: ev.from, to: ev.to, promotion: 'q' });
    feed.add(ev.moveNumber, ev.color, describeMove(ev, d, { chess: replay, prevEval, prevCaptureSquare: prevCapture }));
    prevEval = ev.evaluation;
    prevCapture = d.captured ? ev.to : null;
  }
  stats.updateMaterial(s.fen);
  if (status !== 'over') overlay.hide();
  agents.setThinking(null, null);
}

function applyMove(ev) {
  agents.setThinking(null, null);
  // Serialize so a fast game (4x) never overlaps two animations.
  animating = animating.then(() => new Promise((resolve) => {
    const detail = chess.move({ from: ev.from, to: ev.to, promotion: 'q' });
    if (!detail) { chess.load(ev.fen); board.setPosition(ev.fen); return resolve(); }
    board.highlightCheck(null);
    board.highlightSquares([ev.from, ev.to]);
    board.animateMove(ev.from, ev.to, () => {
      board.setPosition(ev.fen);                 // resync: castling, en passant, promotion
      showCheck(ev.fen, ev.inCheck);
      resolve();
    });
    stats.addMove(ev);
    stats.updateMaterial(ev.fen);
    feed.add(ev.moveNumber, ev.color, describeMove(ev, detail, { chess, prevEval, prevCaptureSquare: prevCapture }));
    prevEval = ev.evaluation;
    prevCapture = detail.captured ? ev.to : null;
  }));
}

// ---- socket events --------------------------------------------------------------

const conn = $('conn-status');
socket.on('connect', () => {
  conn.textContent = 'live'; conn.className = 'badge live';
  socket.emit('joinRoom', { roomId: new URLSearchParams(location.search).get('room') || 'main' });
});
socket.on('disconnect', () => { conn.textContent = 'offline'; conn.className = 'badge down'; });
socket.on('gameState', applySnapshot);
socket.on('move', applyMove);
socket.on('spectators', ({ count }) => { $('spectator-count').textContent = count; });
socket.on('thinking', ({ color, elapsed }) => agents.setThinking(color, elapsed));
socket.on('gameOver', (result) => {
  status = 'over';
  agents.setLocked(false);
  animating.then(() => overlay.show(result));
  stats.refreshRecord();
});

// ---- controls -------------------------------------------------------------------

$('btn-start').addEventListener('click', () => { overlay.hide(); socket.emit('startMatch', agents.value()); });
$('btn-pause').addEventListener('click', () => socket.emit('pauseMatch'));
$('btn-reset').addEventListener('click', () => { overlay.hide(); socket.emit('resetMatch'); });
$('speed').addEventListener('change', (e) => socket.emit('setSpeed', { speed: Number(e.target.value) }));
$('coords').addEventListener('change', (e) => board.showCoordinates(e.target.checked));

// ---- match timer ------------------------------------------------------------------

setInterval(() => {
  if (!startedAt || status === 'idle') { $('match-timer').textContent = '00:00'; return; }
  if (status === 'over') return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  $('match-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}, 1000);

agents.set(agents.value());
stats.refreshRecord();
