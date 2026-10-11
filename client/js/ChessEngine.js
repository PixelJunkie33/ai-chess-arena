// Alpha-beta chess engine. chess.js is used for legal move generation only;
// evaluation and search are custom. The module is environment-neutral: it takes
// a chess.js `Chess` instance, so the server (npm chess.js) and a browser
// (CDN chess.js) can both use it.

export const PERSONALITIES = {
  Aggressor:  { style: 'Attacking',  depth: 6, pstWeight: 1.3, mood: 'captures' },
  Positional: { style: 'Strategic',  depth: 7, pstWeight: 1.0, mood: 'outposts' },
  Defender:   { style: 'Defensive',  depth: 5, pstWeight: 0.9, mood: 'kingSafety' },
  Chaotic:    { style: 'Random',     depth: 4, pstWeight: 0.7, mood: 'noise' },
};

export const MATERIAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const MATE = 100000;
const INF = 1e9;
const HARD_CUTOFF_MS = 2000;

// Piece-square tables, white's point of view, index 0 = a8 … 63 = h1
// (the order of chess.js `board()`: rank 8 first, file a first).
const PST = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k_mid: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
  k_end: [
    -50,-40,-30,-20,-20,-30,-40,-50,
    -30,-20,-10,  0,  0,-10,-20,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-30,  0,  0,  0,  0,-30,-30,
    -50,-30,-30,-30,-30,-30,-30,-50,
  ],
};

// Black uses the same tables flipped vertically.
const flipIndex = (i) => (7 - (i >> 3)) * 8 + (i & 7);

export class ChessEngine {
  /**
   * @param {string} personality key of PERSONALITIES
   * @param {{ timeMs?: number, rng?: () => number }} [opts]
   */
  constructor(personality = 'Positional', opts = {}) {
    this.name = personality in PERSONALITIES ? personality : 'Positional';
    this.cfg = PERSONALITIES[this.name];
    this.timeMs = Math.min(opts.timeMs ?? HARD_CUTOFF_MS, HARD_CUTOFF_MS);
    this.rng = opts.rng ?? Math.random;
  }

  // ---- evaluation ---------------------------------------------------------

  /** Static evaluation in centipawns from White's point of view. */
  evaluate(game) {
    const board = game.board();
    let material = 0, pst = 0;
    let nonPawn = 0;
    for (const row of board) for (const sq of row) {
      if (sq && sq.type !== 'k' && sq.type !== 'p') nonPawn += MATERIAL[sq.type];
    }
    const endgame = nonPawn <= 2600;

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = board[r][c];
        if (!sq) continue;
        const i = r * 8 + c;
        const sign = sq.color === 'w' ? 1 : -1;
        const table = sq.type === 'k' ? (endgame ? PST.k_end : PST.k_mid) : PST[sq.type];
        const bonus = table[sq.color === 'w' ? i : flipIndex(i)];
        material += sign * MATERIAL[sq.type];
        pst += sign * bonus * this.cfg.pstWeight;
      }
    }
    return Math.round(material + pst + this.mood(board, endgame));
  }

  /** Personality modifier, White POV. */
  mood(board, endgame) {
    switch (this.cfg.mood) {
      case 'captures': {           // +15% of material the side has won
        const m = { w: 0, b: 0 };
        for (const row of board) for (const sq of row) {
          if (sq && sq.type !== 'k') m[sq.color] += MATERIAL[sq.type];
        }
        const start = 8 * 100 + 2 * 320 + 2 * 330 + 2 * 500 + 900;
        return 0.15 * ((start - m.b) - (start - m.w));
      }
      case 'outposts': {           // +10% of piece value for protected N/B on the centre
        let s = 0;
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
          const sq = board[r][c];
          if (!sq || (sq.type !== 'n' && sq.type !== 'b')) continue;
          const white = sq.color === 'w';
          const rel = white ? 7 - r : r;                // 0 = own back rank
          if (rel < 3 || rel > 5 || c < 2 || c > 5) continue;
          const behind = white ? r + 1 : r - 1;
          const guarded = [c - 1, c + 1].some((cc) => {
            const p = board[behind]?.[cc];
            return p && p.type === 'p' && p.color === sq.color;
          });
          if (guarded) s += (white ? 1 : -1) * 0.10 * MATERIAL[sq.type];
        }
        return s;
      }
      case 'kingSafety': {         // +20% on pawn shield in front of the king
        if (endgame) return 0;
        let s = 0;
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
          const sq = board[r][c];
          if (!sq || sq.type !== 'k') continue;
          const white = sq.color === 'w';
          const fr = white ? r - 1 : r + 1;
          let shield = 0;
          for (let cc = c - 1; cc <= c + 1; cc++) {
            const p = board[fr]?.[cc];
            if (p && p.type === 'p' && p.color === sq.color) shield++;
          }
          s += (white ? 1 : -1) * 0.20 * shield * 50;
        }
        return s;
      }
      default:
        return 0;
    }
  }

  // ---- search -------------------------------------------------------------

  /**
   * Iterative-deepening alpha-beta search.
   * @returns {{ move: object, evaluation: number, pv: string[], depth: number, nodes: number }}
   *   `move` is a verbose chess.js move; `evaluation` is White POV centipawns.
   */
  search(game) {
    const Chess = game.constructor;
    this.Chess = Chess;
    this.deadline = Date.now() + this.timeMs;
    this.nodes = 0;
    this.stopped = false;
    this.killers = Array.from({ length: 64 }, () => [null, null]);
    this.history = new Map();
    this.pv = Array.from({ length: 64 }, () => []);

    const work = new Chess(game.fen());
    const rootMoves = this.legal(work);
    if (rootMoves.length === 0) return { move: null, evaluation: this.evaluate(work), pv: [], depth: 0, nodes: 0 };

    let best = { move: rootMoves[0], score: -INF, pv: [rootMoves[0].san], depth: 0 };
    const white = work.turn() === 'w';

    for (let depth = 1; depth <= this.cfg.depth; depth++) {
      let ordered = this.order(work, rootMoves, 0, best.move);
      let alpha = -INF, iterBest = null, iterScore = -INF, iterPv = [];
      try {
        for (const m of ordered) {
          work.move(m.san);
          let score = -this.negamax(work, depth - 1, -INF, -alpha, 1, true);
          work.undo();
          if (this.cfg.mood === 'noise') score += (this.rng() * 2 - 1) * 0.25 * Math.abs(score) + (this.rng() - 0.5) * 40;
          if (score > iterScore) {
            iterScore = score; iterBest = m;
            iterPv = [m.san, ...this.pv[1]];
            if (score > alpha) alpha = score;
          }
        }
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        // A half-finished iteration is discarded unless it already beat the previous best.
        break;
      }
      best = { move: iterBest, score: iterScore, pv: iterPv, depth };
      if (Math.abs(iterScore) > MATE - 100) break; // forced mate found
    }

    const whiteScore = white ? best.score : -best.score;
    return {
      move: best.move,
      evaluation: Math.max(-MATE, Math.min(MATE, Math.round(whiteScore))),
      pv: best.pv,
      depth: best.depth,
      nodes: this.nodes,
    };
  }

  checkTime() {
    if ((++this.nodes & 511) === 0 && Date.now() > this.deadline) throw TIMEOUT;
  }

  /** Static eval from the side-to-move's point of view. */
  staticEval(game) {
    const e = this.evaluate(game);
    return game.turn() === 'w' ? e : -e;
  }

  negamax(game, depth, alpha, beta, ply, allowNull) {
    this.checkTime();
    this.pv[ply] = [];
    if (depth <= 0) return this.quiesce(game, alpha, beta, 0);
    if (game.isInsufficientMaterial()) return 0;

    const inCheck = game.inCheck();

    // Null-move pruning (depth >= 3): give the opponent a free move; if we still beat beta, prune.
    if (allowNull && depth >= 3 && !inCheck && this.hasPieces(game)) {
      const nullGame = this.nullPosition(game);
      if (nullGame) {
        const score = -this.negamax(nullGame, depth - 3, -beta, -beta + 1, ply + 1, false);
        if (score >= beta) return beta;
      }
    }

    const moves = this.legal(game);
    if (moves.length === 0) return inCheck ? -MATE + ply : 0;

    let bestScore = -INF;
    for (const m of this.order(game, moves, ply, null)) {
      game.move(m.san);
      const score = -this.negamax(game, depth - 1, -beta, -alpha, ply + 1, true);
      game.undo();
      if (score > bestScore) bestScore = score;
      if (score > alpha) {
        alpha = score;
        this.pv[ply] = [m.san, ...this.pv[ply + 1]];
        if (alpha >= beta) {
          if (!m.captured) {
            const k = this.killers[ply];
            if (k[0] !== m.san) { k[1] = k[0]; k[0] = m.san; }
            const key = m.color + m.from + m.to;
            this.history.set(key, (this.history.get(key) ?? 0) + depth * depth);
          }
          break;
        }
      }
    }
    return bestScore;
  }

  quiesce(game, alpha, beta, qd) {
    this.checkTime();
    const stand = this.staticEval(game);
    if (qd >= 4) return stand;
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    const caps = this.legal(game).filter((m) => m.captured || m.promotion);
    caps.sort((a, b) => this.mvvLva(b) - this.mvvLva(a));
    for (const m of caps) {
      game.move(m.san);
      const score = -this.quiesce(game, -beta, -alpha, qd + 1);
      game.undo();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  /** Legal moves; pawns only ever promote to a queen. */
  legal(game) {
    return game.moves({ verbose: true }).filter((m) => !m.promotion || m.promotion === 'q');
  }

  hasPieces(game) {
    const side = game.turn();
    for (const row of game.board()) for (const sq of row) {
      if (sq && sq.color === side && sq.type !== 'k' && sq.type !== 'p') return true;
    }
    return false;
  }

  /** Same position, other side to move (no ep). Used for null-move pruning. */
  nullPosition(game) {
    const parts = game.fen().split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    parts[3] = '-';
    try { return new this.Chess(parts.join(' ')); } catch { return null; }
  }

  mvvLva(m) {
    return m.captured ? MATERIAL[m.captured] * 10 - MATERIAL[m.piece] / 10 : 0;
  }

  /** Move ordering: 1) captures (MVV-LVA) 2) checks 3) killers 4) history. */
  order(game, moves, ply, pvMove) {
    const k = this.killers[ply] ?? [null, null];
    const scored = moves.map((m) => {
      let s = 0;
      if (pvMove && m.san === pvMove.san) s = 1e7;
      else if (m.captured) s = 1e6 + this.mvvLva(m);
      else if (m.san.endsWith('+') || m.san.endsWith('#')) s = 5e5;
      else if (m.san === k[0]) s = 4e5;
      else if (m.san === k[1]) s = 3e5;
      else s = this.history.get(m.color + m.from + m.to) ?? 0;
      if (m.promotion) s += 9e5;
      return { m, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.m);
  }
}

const TIMEOUT = Symbol('timeout');

/**
 * Pick and describe the engine's move for `game`, in the move-event schema.
 * Does not mutate `game`.
 */
export function chooseMove(game, personality, opts = {}) {
  const engine = new ChessEngine(personality, opts);
  const result = engine.search(game);
  if (!result.move) return null;
  const probe = new game.constructor(game.fen());
  const played = probe.move({ from: result.move.from, to: result.move.to, promotion: 'q' });
  return {
    from: played.from,
    to: played.to,
    promotion: 'q',
    san: played.san,
    fen: probe.fen(),
    moveNumber: game.moveNumber ? game.moveNumber() : parseInt(game.fen().split(' ')[5], 10),
    evaluation: result.evaluation,
    inCheck: probe.inCheck(),
    thinkingLine: result.pv,
  };
}
