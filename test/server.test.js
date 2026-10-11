import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 3917;
const base = `http://127.0.0.1:${PORT}`;
let proc;

test.before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
test.after(() => proc?.kill());

test('REST endpoints', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: 'ok' });
  const { roomId } = await (await fetch(`${base}/api/match/new`, { method: 'POST' })).json();
  assert.match(roomId, /^[\w-]+$/);
  const snap = await (await fetch(`${base}/api/match/${roomId}`)).json();
  assert.equal(snap.status, 'idle');
  assert.equal((await fetch(`${base}/api/match/nope`)).status, 404);
  assert.equal(typeof (await (await fetch(`${base}/api/stats`)).json()).total, 'number');
});

test('spectator gets snapshot, then live moves for a self-starting game', async () => {
  const s = io(base, { transports: ['websocket'] });
  const seen = { state: null, moves: [] };
  s.on('gameState', (g) => { seen.state ??= g; });
  s.on('move', (m) => seen.moves.push(m));
  s.emit('joinRoom', { roomId: 'main' });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no moves received')), 15000);
    s.on('move', () => { if (seen.moves.length >= 2) { clearTimeout(t); resolve(); } });
  });
  s.close();
  assert.ok(seen.state.fen);
  const [m1, m2] = seen.moves;
  for (const k of ['from', 'to', 'promotion', 'san', 'fen', 'moveNumber', 'evaluation', 'inCheck', 'thinkingLine']) assert.ok(k in m1, k);
  assert.equal(m1.color, 'white');
  assert.equal(m2.color, 'black');
});
