import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { GameManager, MAIN_ROOM } from './gameManager.js';
import { loadSecrets, initPersistence, getStats } from './persistence.js';

await loadSecrets();
initPersistence();

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
const ROOM_ID = /^[\w-]{1,32}$/;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));
app.use(express.static(CLIENT_DIR));

const server = http.createServer(app);
const io = new Server(server, { serveClient: true });
const games = new GameManager(io);

// ---- REST -------------------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/match/new', (_req, res) => {
  const room = games.createRoom();
  if (!room) return res.status(429).json({ error: 'too many rooms' });
  res.status(201).json({ roomId: room.id });
});

app.get('/api/match/:id', (req, res) => {
  const room = ROOM_ID.test(req.params.id) && games.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'no such match' });
  res.json(games.snapshot(room));
});

app.get('/api/stats', async (_req, res) => {
  try { res.json(await getStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Socket.io ----------------------------------------------------------------

// 30 spectator connections per second per IP (handshake level, applied to the engine).
const joinLimiter = rateLimit({
  windowMs: 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: 'Too many spectators joining from this address',
});
io.engine.use(joinLimiter);

io.on('connection', (socket) => {
  const roomOf = () => games.getRoom(socket.data.roomId);

  socket.on('joinRoom', (payload) => {
    const id = payload?.roomId ?? MAIN_ROOM;
    if (typeof id !== 'string' || !ROOM_ID.test(id)) return socket.emit('error', { message: 'bad roomId' });
    const room = games.getRoom(id);
    if (!room) return socket.emit('error', { message: 'no such room' });

    if (socket.data.roomId) {                       // leaving a previous room
      socket.leave(socket.data.roomId);
      const prev = roomOf();
      if (prev) games.setSpectators(prev, -1);
    }
    socket.data.roomId = id;
    socket.join(id);
    games.setSpectators(room, +1);
    socket.emit('gameState', games.snapshot(room));   // late-join snapshot
    if (room.status === 'idle') games.start(room);    // first spectator kicks off a match
  });

  socket.on('startMatch', (p) => {
    const room = roomOf();
    if (!room) return;
    games.start(room, p?.agentWhite, p?.agentBlack);
  });
  socket.on('pauseMatch', () => { const r = roomOf(); if (r) games.pause(r); });
  socket.on('resetMatch', () => { const r = roomOf(); if (r) games.reset(r); });
  socket.on('setSpeed', (p) => { const r = roomOf(); if (r) games.setSpeed(r, p?.speed); });

  socket.on('disconnect', () => {
    const room = roomOf();
    if (room) games.setSpectators(room, -1);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`AI Chess Arena listening on http://0.0.0.0:${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { io.close(); server.close(() => process.exit(0)); });
