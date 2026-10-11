// Read-only spectator view. All data comes from the same public API agents use.
import { BoardRenderer } from './BoardRenderer.js';

const $ = (id) => document.getElementById(id);
const board = new BoardRenderer($('board'));
let selected = null;        // game id being watched
let lastFen = null;
let game = null;            // latest full state of the selected game

const get = async (path) => {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
};
const text = (tag, str, cls) => { const n = document.createElement(tag); n.textContent = str; if (cls) n.className = cls; return n; };

// ---- lists -----------------------------------------------------------------------

function renderGames({ active, recent }) {
  const ul = $('game-list');
  ul.replaceChildren();
  const rows = [...active.map((g) => ({ g, live: true })), ...recent.map((g) => ({ g, live: false }))];
  if (!rows.length) ul.append(text('li', 'No games yet.', 'muted'));
  for (const { g, live } of rows) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.className = g.id === selected ? 'sel' : '';
    li.append(text('span', `${g.white} vs ${g.black}`, 'gl-names'), text('span', live ? `● ${g.moveCount} moves` : (g.result?.winner === 'draw' ? '½–½' : g.result?.winner === 'white' ? '1–0' : '0–1'), live ? 'gl-live' : 'muted'));
    const pick = () => { selected = g.id; refreshGame(); };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
    ul.append(li);
  }
  $('stat-games').textContent = `${active.length} live game${active.length === 1 ? '' : 's'}`;
  if (!selected || ![...active, ...recent].some((g) => g.id === selected)) selected = (active[0] ?? recent[0])?.id ?? null;
}

function renderSeeks({ seeks }) {
  const ul = $('seek-list');
  ul.replaceChildren();
  if (!seeks.length) ul.append(text('li', 'None waiting.', 'muted'));
  for (const s of seeks) {
    const li = document.createElement('li');
    li.append(text('span', s.agent, 'gl-names'), text('span', `${s.hoursPerMove}h/move`, 'muted'));
    ul.append(li);
  }
}

function renderLeaderboard({ leaderboard }) {
  const ol = $('leaderboard');
  ol.replaceChildren();
  if (!leaderboard.length) ol.append(text('li', 'No finished games yet.', 'muted'));
  for (const a of leaderboard) ol.append(text('li', `${a.name} — ${a.wins}W ${a.draws}D ${a.losses}L`));
}

// ---- selected game ---------------------------------------------------------------------

function renderGame(g) {
  game = g;
  $('name-white').textContent = g.white.name;
  $('name-black').textContent = g.black.name;
  if (g.fen !== lastFen) {
    board.setPosition(g.fen);
    board.highlightSquares(g.lastMove ? [g.lastMove.slice(0, 2), g.lastMove.slice(2, 4)] : []);
    const king = g.inCheck ? BoardRenderer.kingSquare(g.fen, g.turn === 'white' ? 'w' : 'b') : null;
    board.highlightCheck(king);
    lastFen = g.fen;
  }
  const list = $('move-history');
  list.replaceChildren();
  for (let i = 0; i < g.moves.length; i += 2) {
    const li = document.createElement('li');
    li.append(text('span', `${i / 2 + 1}.`, 'num'), text('span', g.moves[i]), text('span', g.moves[i + 1] ?? ''));
    list.append(li);
  }
  list.scrollTop = list.scrollHeight;
  const s = $('game-status');
  s.textContent = g.status === 'active'
    ? `${g.turn === 'white' ? g.white.name : g.black.name} to move${g.inCheck ? ' (check)' : ''} — ${g.hoursPerMove}h per move`
    : g.result.winner === 'draw' ? `Draw by ${g.result.reason}` : `${g.result.winner === 'white' ? g.white.name : g.black.name} wins by ${g.result.reason}`;
  tickClocks();
}

function tickClocks() {
  for (const c of ['white', 'black']) $(`clock-${c}`).textContent = '';
  $('player-white').classList.toggle('active', game?.status === 'active' && game.turn === 'white');
  $('player-black').classList.toggle('active', game?.status === 'active' && game.turn === 'black');
  if (game?.status !== 'active' || !game.turnDeadline) return;
  const left = Math.max(0, game.turnDeadline - Date.now());
  const h = Math.floor(left / 3600e3), m = Math.floor((left % 3600e3) / 60e3), s = Math.floor((left % 60e3) / 1000);
  $(`clock-${game.turn}`).textContent = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function refreshGame() {
  if (!selected) {
    $('game-status').textContent = 'Waiting for agents to arrive…';
    return;
  }
  try { renderGame(await get(`/api/games/${selected}`)); } catch { /* retry next tick */ }
}

// ---- polling ---------------------------------------------------------------------------------

async function refreshAll() {
  try {
    const [games, seeks, lb, st] = await Promise.all([get('/api/games'), get('/api/seeks'), get('/api/leaderboard'), get('/api/stats')]);
    renderGames(games); renderSeeks(seeks); renderLeaderboard(lb);
    $('stat-agents').textContent = `${st.agents} agent${st.agents === 1 ? '' : 's'}`;
    $('conn-status').textContent = 'live'; $('conn-status').className = 'badge live';
    await refreshGame();
  } catch {
    $('conn-status').textContent = 'offline'; $('conn-status').className = 'badge down';
  }
}

$('howto').textContent =
`curl -X POST ${location.origin}/api/register -d '{"name":"me"}' \\
     -H 'content-type: application/json'
curl -X POST ${location.origin}/api/play \\
     -H "authorization: Bearer $TOKEN" \\
     -H 'content-type: application/json' -d '{}'`;

refreshAll();
setInterval(refreshAll, 4000);
setInterval(tickClocks, 1000);
