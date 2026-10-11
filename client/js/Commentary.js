const COMMENTARY = {
  capture:    (attacker, victim, sq) =>
    `${attacker} takes the ${victim} on ${sq} — material shifts!`,
  check:      (piece, sq) =>
    `${piece} delivers check from ${sq}. The king must respond.`,
  castle:     (side, color) =>
    `${color} castles ${side}side — king safety secured.`,
  promotion:  (sq) =>
    `Pawn promotes on ${sq}! A new queen enters the battle.`,
  blunder:    (san, delta) =>
    `${san} — a blunder! Evaluation swings by ${delta} centipawns.`,
  brilliancy: (san) =>
    `${san} — a brilliant sacrifice! The engine sees deep.`,
  fork:       (piece, sq) =>
    `${piece} on ${sq} forks two pieces simultaneously!`,
  pin:        (piece, sq) =>
    `${piece} pins the enemy piece to ${sq}.`,
  pawnPush:   (sq) =>
    `Pawn advances to ${sq}, seizing space.`,
  exchange:   () =>
    `Pieces come off the board — the position simplifies.`,
  skewer:     (sq) =>
    `A skewer through ${sq} wins material.`,
  zugzwang:   () =>
    `Zugzwang! Every move worsens the position.`,
};

const NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const RAYS = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};
const sqName = (f, r) => String.fromCharCode(97 + f) + (r + 1);

/** Walk a slider's rays from `to` and report the first two enemy pieces on each. */
function lineTactics(chess, to, moverColor, moverType) {
  const found = { pin: null, skewer: null };
  for (const [df, dr] of RAYS[moverType] ?? []) {
    const hits = [];
    let f = to.charCodeAt(0) - 97 + df, r = parseInt(to[1]) - 1 + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8 && hits.length < 2) {
      const p = chess.get(sqName(f, r));
      if (p) { if (p.color === moverColor) break; hits.push({ ...p, square: sqName(f, r) }); }
      f += df; r += dr;
    }
    if (hits.length < 2) continue;
    const [front, back] = hits;
    if (front.type === 'k') continue;                       // that is a check, reported as such
    if (back.type === 'k' || VALUE[back.type] > VALUE[front.type]) found.pin ??= back.square;
    else if (VALUE[front.type] > VALUE[back.type]) found.skewer ??= back.square;
  }
  return found;
}

/** Enemy pieces that the moved piece attacks and that are worth winning. */
function forkTargets(chess, to, moverColor, moverType) {
  const enemy = moverColor === 'w' ? 'b' : 'w';
  let n = 0;
  for (let f = 0; f < 8; f++) for (let r = 0; r < 8; r++) {
    const sq = sqName(f, r);
    const p = chess.get(sq);
    if (!p || p.color !== enemy || p.type === 'p') continue;
    if (VALUE[p.type] < VALUE[moverType] && p.type !== 'k') continue;
    if (chess.attackers(sq, moverColor).includes(to)) n++;
  }
  return n;
}

/**
 * Turn one move event into a commentary line.
 * @param {object} ev        move event from the server
 * @param {object} detail    verbose chess.js move (piece, captured, flags, from, to, color)
 * @param {object} ctx       { chess (position AFTER the move), prevEval, prevCaptureSquare }
 * @returns {{ kind: string, text: string }}
 */
export function describeMove(ev, detail, ctx) {
  const mover = detail.color;                                  // 'w' | 'b'
  const piece = cap(NAMES[detail.piece]);
  const lossForMover = ((ctx.prevEval ?? 0) - ev.evaluation) * (mover === 'w' ? 1 : -1);
  const wasCapture = Boolean(detail.captured);

  if (ev.san.includes('=Q') || detail.promotion) return { kind: 'promotion', text: COMMENTARY.promotion(ev.to) };
  if (ev.san.startsWith('O-O')) {
    return { kind: 'castle', text: COMMENTARY.castle(ev.san.startsWith('O-O-O') ? 'queen' : 'king', mover === 'w' ? 'White' : 'Black') };
  }
  if (lossForMover > 150) return { kind: 'blunder', text: COMMENTARY.blunder(ev.san, Math.round(lossForMover)) };
  if (lossForMover < -100 && !wasCapture) return { kind: 'brilliancy', text: COMMENTARY.brilliancy(ev.san) };
  if (ev.inCheck) return { kind: 'check', text: COMMENTARY.check(piece, ev.to) };

  if (wasCapture) {
    const recapture = ctx.prevCaptureSquare === ev.to && VALUE[detail.captured] === VALUE[detail.piece];
    if (recapture) return { kind: 'exchange', text: COMMENTARY.exchange() };
    return { kind: 'capture', text: COMMENTARY.capture(piece, NAMES[detail.captured], ev.to) };
  }

  if (detail.piece === 'n' || detail.piece === 'q') {
    if (forkTargets(ctx.chess, ev.to, mover, detail.piece) >= 2) return { kind: 'fork', text: COMMENTARY.fork(piece, ev.to) };
  }
  if (RAYS[detail.piece]) {
    const t = lineTactics(ctx.chess, ev.to, mover, detail.piece);
    if (t.pin) return { kind: 'pin', text: COMMENTARY.pin(piece, t.pin) };
    if (t.skewer) return { kind: 'skewer', text: COMMENTARY.skewer(t.skewer) };
  }
  if (detail.piece === 'p') return { kind: 'pawnPush', text: COMMENTARY.pawnPush(ev.to) };
  if (ctx.chess.moves().length <= 2 && lossForMover > 40) return { kind: 'zugzwang', text: COMMENTARY.zugzwang() };

  return { kind: 'quiet', text: `${piece} ${detail.from} → ${ev.to}.` };
}

export class CommentaryFeed {
  constructor(container) { this.container = container; }
  clear() { this.container.replaceChildren(); }
  add(moveNumber, color, { kind, text }) {
    const line = document.createElement('div');
    line.className = `line ${kind}`;
    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = `${moveNumber}${color === 'white' ? '.' : '…'}`;
    line.append(no, document.createTextNode(text));
    this.container.append(line);
    this.container.scrollTop = this.container.scrollHeight;   // scroll to bottom after insert
  }
}

export { COMMENTARY };
