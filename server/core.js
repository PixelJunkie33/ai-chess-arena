// Platform rules. The server is a referee: it validates moves, keeps clocks and records results.
// It never plays. Every function returns { status, body } so HTTP and MCP share one implementation.
import { Chess } from 'chess.js';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { saveItem, deleteItem, loadAll } from './persistence.js';

export const LIMITS = {
  maxAgents: 5000,
  maxOpenSeeks: 300,
  maxActiveGamesPerAgent: 3,
  maxGamesPerAgentPerDay: 30,
  seekTtlMs: 7 * 24 * 3600e3,
  minHours: 1, maxHours: 72, defaultHours: 24,
  maxFinishedInMemory: 2000,
};

const agents = new Map();     // id -> agent
const tokenIndex = new Map(); // sha256(token) -> agent id
const seeks = new Map();      // id -> seek
const games = new Map();      // id -> game
const boards = new Map();     // game id -> Chess (replayed from game.moves)
export const platform = { paused: false };

const ok = (body, status = 200) => ({ status, body });
const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,23}$/;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const SAN_RE = /^[A-Za-z0-9=+#\-]{2,10}$/;

// ---- persistence --------------------------------------------------------------

export async function restore() {
  const items = await loadAll();
  for (const { kind, data } of items) {
    if (kind === 'agent') { agents.set(data.id, data); tokenIndex.set(data.tokenHash, data.id); }
    else if (kind === 'seek') seeks.set(data.id, data);
    else if (kind === 'game') games.set(data.id, data);
  }
  if (items.length) console.log(`[restore] ${agents.size} agents, ${seeks.size} seeks, ${games.size} games`);
}
const saveAgent = (a) => saveItem('agent', a.id, a);
const saveGame = (g) => saveItem('game', g.id, g);

// ---- agents ---------------------------------------------------------------------

export function register(name) {
  if (agents.size >= LIMITS.maxAgents) return fail(503, 'agent capacity reached; try again later');
  if (name != null && (typeof name !== 'string' || !NAME_RE.test(name))) {
    return fail(400, 'name must be 1-24 chars: letters, digits, space, _ . - (starting with a letter or digit)');
  }
  const token = 'cha_' + randomBytes(24).toString('hex');
  const agent = {
    id: randomUUID().slice(0, 12), name: name ?? `agent-${randomBytes(2).toString('hex')}`,
    tokenHash: sha(token), createdAt: Date.now(), lastSeen: Date.now(), banned: false,
    wins: 0, losses: 0, draws: 0, dayStart: Date.now(), dayCount: 0,
  };
  agents.set(agent.id, agent);
  tokenIndex.set(agent.tokenHash, agent.id);
  saveAgent(agent);
  return ok({
    agentId: agent.id, name: agent.name, token,
    note: 'Store the token now; it is shown once. Send it as "Authorization: Bearer <token>".',
    next: 'POST /api/play to be matched or to wait for an opponent.',
  }, 201);
}

export function authenticate(header) {
  const m = /^Bearer (cha_[0-9a-f]{48})$/.exec(header ?? '');
  const agent = m && agents.get(tokenIndex.get(sha(m[1])));
  if (!agent) return { error: fail(401, 'missing or invalid token; POST /api/register to get one') };
  if (agent.banned) return { error: fail(403, 'this agent has been suspended') };
  agent.lastSeen = Date.now();
  return { agent };
}

export const publicAgent = (a) => ({ id: a.id, name: a.name, wins: a.wins, losses: a.losses, draws: a.draws });

export function me(agent) {
  return ok({
    ...publicAgent(agent),
    activeGames: activeGamesOf(agent).map((g) => g.id),
    openSeek: openSeekOf(agent)?.id ?? null,
  });
}

const activeGamesOf = (a) => [...games.values()].filter((g) => g.status === 'active' && (g.white === a.id || g.black === a.id));
const openSeekOf = (a) => [...seeks.values()].find((s) => s.agentId === a.id);

// ---- seeks and matchmaking -----------------------------------------------------------

function parseHours(h) {
  if (h == null) return LIMITS.defaultHours;
  return Number.isInteger(h) && h >= LIMITS.minHours && h <= LIMITS.maxHours ? h : null;
}

function quotaError(agent) {
  if (activeGamesOf(agent).length >= LIMITS.maxActiveGamesPerAgent) {
    return fail(429, `at most ${LIMITS.maxActiveGamesPerAgent} active games per agent; finish one first`);
  }
  if (Date.now() - agent.dayStart > 24 * 3600e3) { agent.dayStart = Date.now(); agent.dayCount = 0; }
  if (agent.dayCount >= LIMITS.maxGamesPerAgentPerDay) return fail(429, 'daily game limit reached');
  return null;
}

const seekView = (s) => ({
  id: s.id, agent: agents.get(s.agentId)?.name ?? '?', hoursPerMove: s.hoursPerMove,
  createdAt: s.createdAt, expiresAt: s.expiresAt,
});

export const listSeeks = () => ok({ seeks: [...seeks.values()].map(seekView) });

function createSeek(agent, hours) {
  const existing = openSeekOf(agent);
  if (existing) return ok({ status: 'waiting', seek: seekView(existing), next: 'Poll GET /api/me or GET /api/games until a game appears.' });
  if (seeks.size >= LIMITS.maxOpenSeeks) return fail(503, 'too many open seeks; try again later');
  const seek = { id: randomUUID().slice(0, 8), agentId: agent.id, hoursPerMove: hours, createdAt: Date.now(), expiresAt: Date.now() + LIMITS.seekTtlMs };
  seeks.set(seek.id, seek);
  saveItem('seek', seek.id, seek);
  return ok({ status: 'waiting', seek: seekView(seek), next: 'Poll GET /api/me (activeGames) until an opponent accepts.' }, 201);
}

function startGame(a, b, hours) {
  const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
  const game = {
    id: randomUUID().slice(0, 10), white: white.id, black: black.id,
    whiteName: white.name, blackName: black.name,
    moves: [], status: 'active', result: null, hoursPerMove: hours,
    createdAt: Date.now(), updatedAt: Date.now(), turnDeadline: Date.now() + hours * 3600e3,
  };
  games.set(game.id, game);
  for (const p of [a, b]) { p.dayCount++; saveAgent(p); }
  saveGame(game);
  return game;
}

function dropSeek(seek) { seeks.delete(seek.id); deleteItem('seek', seek.id); }

/** One-call matchmaking: join a compatible open seek, or post one and wait. */
export function play(agent, hoursIn) {
  const hours = parseHours(hoursIn);
  if (hours == null) return fail(400, `hoursPerMove must be an integer ${LIMITS.minHours}-${LIMITS.maxHours}`);
  const q = quotaError(agent);
  if (q) return q;
  const mine = openSeekOf(agent);
  if (!mine) {
    const match = [...seeks.values()]
      .filter((s) => s.agentId !== agent.id && s.hoursPerMove === hours && agents.get(s.agentId) && !agents.get(s.agentId).banned)
      .sort((x, y) => x.createdAt - y.createdAt)[0];
    if (match) return acceptSeek(agent, match.id);
  }
  return createSeek(agent, hours);
}

export function seek(agent, hoursIn) {
  const hours = parseHours(hoursIn);
  if (hours == null) return fail(400, `hoursPerMove must be an integer ${LIMITS.minHours}-${LIMITS.maxHours}`);
  const q = quotaError(agent);
  return q ?? createSeek(agent, hours);
}

export function acceptSeek(agent, seekId) {
  const s = seeks.get(seekId);
  if (!s) return fail(404, 'no such open seek');
  if (s.agentId === agent.id) return fail(400, 'you cannot accept your own seek');
  const q = quotaError(agent);
  if (q) return q;
  const opponent = agents.get(s.agentId);
  dropSeek(s);
  if (!opponent || opponent.banned) return fail(410, 'that seek is no longer available');
  const game = startGame(agent, opponent, s.hoursPerMove);
  return ok({ status: 'matched', game: view(game, agent), next: 'Make your move with POST /api/games/{id}/move if it is your turn; otherwise poll GET /api/games/{id}.' }, 201);
}

// ---- games -----------------------------------------------------------------------------

function board(game) {
  let c = boards.get(game.id);
  if (!c) {
    c = new Chess();
    for (const m of game.moves) c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
    boards.set(game.id, c);
  }
  return c;
}

export function view(game, agent = null) {
  const c = board(game);
  const turn = c.turn() === 'w' ? 'white' : 'black';
  const color = !agent ? null : game.white === agent.id ? 'white' : game.black === agent.id ? 'black' : null;
  const active = game.status === 'active';
  const legal = active ? c.moves({ verbose: true }) : [];
  return {
    id: game.id, status: game.status, result: game.result,
    white: { id: game.white, name: game.whiteName }, black: { id: game.black, name: game.blackName },
    fen: c.fen(), turn, moveCount: game.moves.length, moves: game.moves.map((m) => m.san),
    lastMove: game.moves.at(-1)?.uci ?? null, inCheck: c.inCheck(),
    hoursPerMove: game.hoursPerMove, turnDeadline: active ? game.turnDeadline : null,
    createdAt: game.createdAt, updatedAt: game.updatedAt,
    ...(color && { yourColor: color, yourTurn: active && turn === color }),
    ...(active && { legalMoves: legal.map((m) => m.lan), legalMovesSan: legal.map((m) => m.san) }),
    ...(!active && { pgn: c.pgn() }),
  };
}

const summary = (g) => ({
  id: g.id, status: g.status, result: g.result, white: g.whiteName, black: g.blackName,
  moveCount: g.moves.length, fen: board(g).fen(), lastMove: g.moves.at(-1)?.uci ?? null, updatedAt: g.updatedAt,
});

export function getGame(id, agent = null) {
  const g = games.get(id);
  return g ? ok(view(g, agent)) : fail(404, 'no such game');
}

export function listGames() {
  const all = [...games.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return ok({
    active: all.filter((g) => g.status === 'active').slice(0, 50).map(summary),
    recent: all.filter((g) => g.status === 'finished').slice(0, 20).map(summary),
  });
}

function finish(game, winner, reason) {
  game.status = 'finished';
  game.result = { winner, reason };
  game.turnDeadline = null;
  game.updatedAt = Date.now();
  const w = agents.get(game.white), b = agents.get(game.black);
  if (winner === 'white') { w && w.wins++; b && b.losses++; }
  else if (winner === 'black') { b && b.wins++; w && w.losses++; }
  else { w && w.draws++; b && b.draws++; }
  for (const a of [w, b]) if (a) saveAgent(a);
  saveGame(game);
  pruneFinished();
}

function pruneFinished() {
  const done = [...games.values()].filter((g) => g.status === 'finished');
  if (done.length <= LIMITS.maxFinishedInMemory) return;
  done.sort((a, b) => a.updatedAt - b.updatedAt);
  for (const g of done.slice(0, done.length - LIMITS.maxFinishedInMemory)) { games.delete(g.id); boards.delete(g.id); }
}

function parseMove(c, text) {
  if (UCI_RE.test(text)) {
    const from = text.slice(0, 2), to = text.slice(2, 4);
    let promotion = text[4];
    if (!promotion && c.moves({ verbose: true }).some((m) => m.from === from && m.to === to && m.promotion)) promotion = 'q';
    return { from, to, promotion };
  }
  if (SAN_RE.test(text)) return text;
  return null;
}

export function move(agent, gameId, text) {
  const game = games.get(gameId);
  if (!game) return fail(404, 'no such game');
  const color = game.white === agent.id ? 'white' : game.black === agent.id ? 'black' : null;
  if (!color) return fail(403, 'you are not a player in this game');
  if (game.status !== 'active') return fail(409, 'game is over', { game: view(game, agent) });
  const c = board(game);
  if ((c.turn() === 'w' ? 'white' : 'black') !== color) return fail(409, 'not your turn', { game: view(game, agent) });
  if (typeof text !== 'string') return fail(400, 'body must be {"move": "e2e4"} (UCI) or {"move": "Nf3"} (SAN)');
  const parsed = parseMove(c, text.trim());
  let played;
  try { played = parsed && c.move(parsed); } catch { played = null; }
  if (!played) {
    return fail(400, 'illegal or unreadable move', { legalMoves: c.moves({ verbose: true }).map((m) => m.lan) });
  }
  game.moves.push({ san: played.san, uci: played.lan, at: Date.now() });
  game.updatedAt = Date.now();
  game.turnDeadline = Date.now() + game.hoursPerMove * 3600e3;
  if (c.isCheckmate()) finish(game, color, 'checkmate');
  else if (c.isStalemate()) finish(game, 'draw', 'stalemate');
  else if (c.isInsufficientMaterial()) finish(game, 'draw', 'insufficient material');
  else if (c.isThreefoldRepetition()) finish(game, 'draw', 'threefold repetition');
  else if (c.isDrawByFiftyMoves()) finish(game, 'draw', '50-move rule');
  else saveGame(game);
  return ok(view(game, agent));
}

export function resign(agent, gameId) {
  const game = games.get(gameId);
  if (!game) return fail(404, 'no such game');
  const color = game.white === agent.id ? 'white' : game.black === agent.id ? 'black' : null;
  if (!color) return fail(403, 'you are not a player in this game');
  if (game.status !== 'active') return fail(409, 'game is already over');
  finish(game, color === 'white' ? 'black' : 'white', 'resignation');
  return ok(view(game, agent));
}

/** Periodic housekeeping: forfeit overdue moves, drop expired seeks. */
export function sweep(now = Date.now()) {
  for (const g of games.values()) {
    if (g.status === 'active' && now > g.turnDeadline) {
      const turn = board(g).turn() === 'w' ? 'white' : 'black';
      finish(g, turn === 'white' ? 'black' : 'white', 'timeout');
    }
  }
  for (const s of seeks.values()) if (now > s.expiresAt) dropSeek(s);
}

// ---- public stats ----------------------------------------------------------------------------

export function leaderboard() {
  const rows = [...agents.values()].filter((a) => !a.banned && a.wins + a.losses + a.draws > 0)
    .sort((a, b) => (b.wins + 0.5 * b.draws) - (a.wins + 0.5 * a.draws) || b.wins - a.wins)
    .slice(0, 25).map(publicAgent);
  return ok({ leaderboard: rows });
}

export function stats() {
  const all = [...games.values()];
  const fin = all.filter((g) => g.status === 'finished');
  return ok({
    agents: agents.size, openSeeks: seeks.size,
    activeGames: all.length - fin.length, finishedGames: fin.length,
    white: fin.filter((g) => g.result.winner === 'white').length,
    black: fin.filter((g) => g.result.winner === 'black').length,
    draw: fin.filter((g) => g.result.winner === 'draw').length,
  });
}

// ---- admin ---------------------------------------------------------------------------------------

export function adminOverview() {
  return {
    paused: platform.paused, ...stats().body,
    agentList: [...agents.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 100)
      .map((a) => ({ ...publicAgent(a), banned: a.banned, createdAt: a.createdAt, lastSeen: a.lastSeen })),
  };
}

export function banAgent(id, banned = true) {
  const a = agents.get(id);
  if (!a) return fail(404, 'no such agent');
  a.banned = !!banned;
  saveAgent(a);
  for (const s of [...seeks.values()]) if (s.agentId === id) dropSeek(s);
  return ok({ id, banned: a.banned });
}

/** Operator tool: remove a game entirely and undo its effect on the agents' win/loss records. */
export function adminDeleteGame(id) {
  const g = games.get(id);
  if (!g) return fail(404, 'no such game');
  if (g.status === 'finished' && g.result) {
    const w = agents.get(g.white), b = agents.get(g.black);
    const undo = (a, field) => { if (a && a[field] > 0) a[field]--; };
    if (g.result.winner === 'white') { undo(w, 'wins'); undo(b, 'losses'); }
    else if (g.result.winner === 'black') { undo(b, 'wins'); undo(w, 'losses'); }
    else { undo(w, 'draws'); undo(b, 'draws'); }
    for (const a of [w, b]) if (a) saveAgent(a);
  }
  games.delete(id);
  boards.delete(id);
  deleteItem('game', id);
  return ok({ deleted: id });
}
