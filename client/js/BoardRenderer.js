const NS = 'http://www.w3.org/2000/svg';
const SQ = 75;
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const TEXT_VARIANT = '︎'; // force text (not emoji) presentation, esp. for the pawn

// 'a1' = col 0, row 7 (bottom-left for white)
export function squareToXY(sq, flipped = false) {
  const file = sq.charCodeAt(0) - 97;  // 'a'=0 … 'h'=7
  const rank = parseInt(sq[1]) - 1;    // '1'=0 … '8'=7
  const col  = flipped ? 7 - file : file;
  const row  = flipped ? rank : 7 - rank;
  return { x: col * 75, y: row * 75 };
}

const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

export class BoardRenderer {
  /** @param {SVGSVGElement} svg */
  constructor(svg, { flipped = false } = {}) {
    this.svg = svg;
    this.flipped = flipped;
    this.coordsVisible = true;
    svg.setAttribute('viewBox', '0 0 600 600');
    svg.replaceChildren();
    this.squaresLayer = el('g');
    this.highlightLayer = el('g');
    this.coordLayer = el('g');
    this.pieceLayer = el('g');
    this.checkLayer = el('g');
    svg.append(this.squaresLayer, this.highlightLayer, this.coordLayer, this.pieceLayer, this.checkLayer);
    this.drawSquares();
    this.drawCoordinates();
  }

  drawSquares() {
    for (let f = 0; f < 8; f++) for (let r = 1; r <= 8; r++) {
      const sq = String.fromCharCode(97 + f) + r;
      const { x, y } = squareToXY(sq, this.flipped);
      this.squaresLayer.append(el('rect', {
        x, y, width: SQ, height: SQ, 'data-sq': sq,
        fill: (f + r) % 2 === 1 ? '#f0d9b5' : '#b58863',   // a1 is dark
      }));
    }
  }

  drawCoordinates() {
    this.coordLayer.replaceChildren();
    for (let i = 0; i < 8; i++) {
      const file = String.fromCharCode(97 + i);
      const fp = squareToXY(file + '1', this.flipped);
      const rp = squareToXY('a' + (i + 1), this.flipped);
      const fileLabel = el('text', { x: fp.x + SQ - 4, y: fp.y + SQ - 4, 'text-anchor': 'end', class: 'coord', fill: i % 2 === 0 ? '#f0d9b5' : '#b58863' });
      fileLabel.textContent = file;
      const rankLabel = el('text', { x: rp.x + 4, y: rp.y + 13, class: 'coord', fill: i % 2 === 0 ? '#b58863' : '#f0d9b5' });
      rankLabel.textContent = String(i + 1);
      this.coordLayer.append(fileLabel, rankLabel);
    }
    this.coordLayer.style.display = this.coordsVisible ? '' : 'none';
  }

  showCoordinates(visible) {
    this.coordsVisible = !!visible;
    this.coordLayer.style.display = this.coordsVisible ? '' : 'none';
  }

  /** Render a position from a FEN string (piece placement field only is used). */
  setPosition(fen) {
    this.pieceLayer.replaceChildren();
    this.pieces = new Map();
    const rows = fen.split(' ')[0].split('/');
    rows.forEach((row, i) => {
      let file = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) { file += Number(ch); continue; }
        const sq = String.fromCharCode(97 + file) + (8 - i);
        this.placePiece(sq, ch);
        file++;
      }
    });
  }

  placePiece(sq, fenChar) {
    const white = fenChar === fenChar.toUpperCase();
    const t = el('text', { x: SQ / 2, y: SQ / 2 + 2, class: `piece ${white ? 'white' : 'black'}`, 'data-sq': sq });
    t.textContent = GLYPH[fenChar.toLowerCase()] + TEXT_VARIANT;
    const { x, y } = squareToXY(sq, this.flipped);
    t.style.transform = `translate(${x}px, ${y}px)`;
    this.pieceLayer.append(t);
    this.pieces.set(sq, t);
  }

  /** Yellow tint on source and target squares. */
  highlightSquares([from, to] = []) {
    this.highlightLayer.replaceChildren();
    for (const sq of [from, to]) {
      if (!sq) continue;
      const { x, y } = squareToXY(sq, this.flipped);
      this.highlightLayer.append(el('rect', { x, y, width: SQ, height: SQ, fill: 'rgba(255, 235, 59, 0.45)' }));
    }
  }

  /** Red pulse ring on the king square; pass null to clear. */
  highlightCheck(square) {
    this.checkLayer.replaceChildren();
    if (!square) return;
    const { x, y } = squareToXY(square, this.flipped);
    this.checkLayer.append(el('circle', { cx: x + SQ / 2, cy: y + SQ / 2, r: SQ / 2 - 4, class: 'check-ring' }));
  }

  /** Slide the piece on `from` to `to` (350 ms ease), then call cb. */
  animateMove(from, to, cb) {
    const piece = this.pieces?.get(from);
    if (!piece || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { cb?.(); return; }
    const captured = this.pieces.get(to);
    if (captured) captured.style.opacity = '0';
    const { x, y } = squareToXY(to, this.flipped);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      piece.removeEventListener('transitionend', finish);
      cb?.();
    };
    piece.addEventListener('transitionend', finish);
    setTimeout(finish, 450);           // safety net if transitionend never fires
    piece.style.transition = 'transform 350ms ease';
    piece.getBoundingClientRect();     // flush so the transition runs
    piece.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** Find the king square of the given color ('w'|'b') in a FEN. */
  static kingSquare(fen, color) {
    const target = color === 'w' ? 'K' : 'k';
    const rows = fen.split(' ')[0].split('/');
    for (let i = 0; i < 8; i++) {
      let file = 0;
      for (const ch of rows[i]) {
        if (/\d/.test(ch)) { file += Number(ch); continue; }
        if (ch === target) return String.fromCharCode(97 + file) + (8 - i);
        file++;
      }
    }
    return null;
  }
}
