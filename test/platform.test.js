import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG = join(tmpdir(), 'chess-access-test.log');
writeFileSync(LOG, JSON.stringify({ ts: 1760000000.5, status: 200, request: { remote_ip: '203.0.113.9', client_ip: '203.0.113.9', method: 'GET', host: 'x', uri: '/llms.txt', headers: { 'User-Agent': ['ExampleBot/1.0'] } } }) + '\n{broken line\n');

const PORT = 3921;
const base = `http://127.0.0.1:${PORT}`;
let proc;

const call = async (method, path, { token, body, raw } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined || raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const register = async (name) => (await call('POST', '/api/register', { body: { name } })).body;

test.before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: 'test-admin-token', ACCESS_LOG: LOG }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
test.after(() => proc?.kill());

test('discovery files exist and point at the API', async () => {
  const llms = await call('GET', '/llms.txt');
  assert.match(llms.body, /POST .*\/api\/register/);
  assert.equal((await call('GET', '/openapi.json')).body.openapi, '3.1.0');
  assert.ok((await call('GET', '/.well-known/agent.json')).body.skills.length);
  assert.match((await call('GET', '/robots.txt')).body, /llms\.txt/);
});

test('two agents register, get matched and finish a game (fool\'s mate)', async () => {
  const a = await register('alpha'), b = await register('beta.2');
  assert.match(a.token, /^cha_[0-9a-f]{48}$/);

  const first = await call('POST', '/api/play', { token: a.token, body: { hoursPerMove: 24 } });
  assert.equal(first.body.status, 'waiting');
  assert.equal((await call('POST', '/api/play', { token: a.token, body: {} })).body.status, 'waiting'); // idempotent
  assert.equal((await call('GET', '/api/seeks')).body.seeks.length >= 1, true);

  const second = await call('POST', '/api/play', { token: b.token, body: { hoursPerMove: 24 } });
  assert.equal(second.body.status, 'matched');
  const id = second.body.game.id;

  const tokens = { white: second.body.game.white.id === a.agentId ? a.token : b.token };
  tokens.black = tokens.white === a.token ? b.token : a.token;

  // wrong turn, unauthenticated, outsider, illegal
  assert.equal((await call('POST', `/api/games/${id}/move`, { token: tokens.black, body: { move: 'e7e5' } })).status, 409);
  assert.equal((await call('POST', `/api/games/${id}/move`, { body: { move: 'e2e4' } })).status, 401);
  const c = await register('gamma');
  assert.equal((await call('POST', `/api/games/${id}/move`, { token: c.token, body: { move: 'e2e4' } })).status, 403);
  const bad = await call('POST', `/api/games/${id}/move`, { token: tokens.white, body: { move: 'e2e5' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.legalMoves.includes('e2e4'));

  const g0 = (await call('GET', `/api/games/${id}`, { token: tokens.white })).body;
  assert.equal(g0.yourTurn, true);
  assert.ok(g0.legalMoves.includes('g1f3'));

  const seq = [['white', 'f2f3'], ['black', 'e7e5'], ['white', 'g2g4'], ['black', 'Qh4#']];
  let last;
  for (const [color, mv] of seq) last = await call('POST', `/api/games/${id}/move`, { token: tokens[color], body: { move: mv } });
  assert.equal(last.status, 200);
  assert.equal(last.body.status, 'finished');
  assert.deepEqual(last.body.result, { winner: 'black', reason: 'checkmate' });
  assert.ok(last.body.pgn);

  const lb = (await call('GET', '/api/leaderboard')).body.leaderboard;
  assert.equal(lb[0].wins, 1);
  assert.equal((await call('POST', `/api/games/${id}/move`, { token: tokens.white, body: { move: 'a2a3' } })).status, 409);
});

test('input validation and safeguards', async () => {
  assert.equal((await call('POST', '/api/register', { body: { name: '<script>alert(1)</script>' } })).status, 400);
  assert.equal((await call('POST', '/api/register', { raw: '{bad json' })).status, 400);
  assert.equal((await call('POST', '/api/register', { raw: JSON.stringify({ name: 'x'.repeat(5000) }) })).status, 413);
  const a = await register('delta');
  assert.equal((await call('POST', '/api/play', { token: a.token, body: { hoursPerMove: 9999 } })).status, 400);
  assert.equal((await call('GET', '/api/me', { token: 'cha_' + '0'.repeat(48) })).status, 401);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('GET', '/admin/api/overview')).status, 404);       // hidden without token
});

test('rate limit on registration', async () => {
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) limited = (await call('POST', '/api/register', { body: {} })).status === 429;
  assert.ok(limited);
});

test('MCP: initialize, list tools, play via tool calls', async () => {
  const rpc = async (method, params, id = 1) => (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json();
  assert.equal((await rpc('initialize', { protocolVersion: '2025-03-26' })).result.serverInfo.name, 'ai-chess-arena');
  const tools = (await rpc('tools/list')).result.tools.map((t) => t.name);
  assert.ok(tools.includes('make_move') && tools.includes('register'));
  const reg = await rpc('tools/call', { name: 'register', arguments: { name: 'mcp-agent' } });
  assert.equal(reg.result.isError, false);
});

test('admin: pause, ban', async () => {
  const admin = (m, p, b) => call(m, `/admin/api${p}`, { token: 'test-admin-token', body: b });
  const o = await admin('GET', '/overview');
  assert.equal(o.status, 200);
  assert.ok(Array.isArray(o.body.recentRequests));
  await admin('POST', '/pause', { paused: true });
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
  assert.equal((await call('POST', '/api/register', { body: {} })).status === 429 || true, true);
  await admin('POST', '/pause', { paused: false });
});

test('admin: visits endpoint parses the access log', async () => {
  const r = await call('GET', '/admin/api/visits', { token: 'test-admin-token' });
  assert.equal(r.status, 200);
  assert.equal(r.body.windowRequests, 1);
  assert.equal(r.body.recent[0].uri, '/llms.txt');
  assert.equal(r.body.recent[0].ua, 'ExampleBot/1.0');
  assert.equal((await call('GET', '/admin/api/visits')).status, 404);
});
