const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };

/** Count pieces from the FEN placement field. */
function countPieces(fen) {
  const c = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase();
    if (t in VALUE) c[ch === t ? 'b' : 'w'][t]++;
  }
  return c;
}

export class StatsPanel {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.evals = [0];
  }

  // --- move history (full SAN) ---
  resetHistory() { this.$('move-history').replaceChildren(); this.evals = [0]; this.drawGraph(); this.setEval(0); }

  addMove(ev) {
    const list = this.$('move-history');
    list.querySelector('.latest')?.classList.remove('latest');
    let li;
    if (ev.color === 'white') {
      li = document.createElement('li');
      li.innerHTML = '<span class="num"></span><span class="w"></span><span class="b"></span>';
      li.querySelector('.num').textContent = `${ev.moveNumber}.`;
      list.append(li);
    } else {
      li = list.lastElementChild;
      if (!li) {                       // black's move first (late join / odd snapshot)
        li = document.createElement('li');
        li.innerHTML = '<span class="num"></span><span class="w">…</span><span class="b"></span>';
        li.querySelector('.num').textContent = `${ev.moveNumber}.`;
        list.append(li);
      }
    }
    const cell = li.querySelector(ev.color === 'white' ? '.w' : '.b');
    cell.textContent = ev.san;
    cell.classList.add('latest');
    list.scrollTop = list.scrollHeight;

    this.evals.push(ev.evaluation);
    this.drawGraph();
    this.setEval(ev.evaluation);
  }

  setEval(cp) {
    const abs = Math.abs(cp);
    this.$('eval-readout').textContent = abs > 50000 ? (cp > 0 ? '+M' : '-M') : `${cp >= 0 ? '+' : '-'}${(abs / 100).toFixed(2)}`;
  }

  // --- material bar + captured pieces ---
  updateMaterial(fen) {
    const c = countPieces(fen);
    const score = (side) => Object.entries(c[side]).reduce((s, [t, n]) => s + VALUE[t] * n, 0);
    const w = score('w'), b = score('b');
    const diff = w - b;
    this.$('material-label').textContent = diff === 0 ? 'equal' : `${diff > 0 ? 'White' : 'Black'} +${Math.abs(diff)}`;
    const pct = Math.max(5, Math.min(95, 50 + diff * 3));
    this.$('material-white').style.width = `${pct}%`;
    const taken = (side) => Object.keys(START).map((t) => GLYPH[t].repeat(Math.max(0, START[t] - c[side][t]))).join('');
    this.$('captured-by-white').textContent = taken('b');   // black pieces white has captured
    this.$('captured-by-black').textContent = taken('w');
  }

  // --- eval graph ---
  drawGraph() {
    const svg = this.$('eval-graph');
    const W = 300, H = 80, clamp = 800;
    const n = Math.max(this.evals.length - 1, 1);
    const pts = this.evals.map((e, i) => {
      const v = Math.max(-clamp, Math.min(clamp, e));
      return `${((i / n) * W).toFixed(1)},${(H / 2 - (v / clamp) * (H / 2 - 4)).toFixed(1)}`;
    });
    svg.innerHTML =
      `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#30363d" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
      `<polyline points="${pts.join(' ')}" fill="none" stroke="#58a6ff" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }

  // --- all-time W/D/L ---
  async refreshRecord() {
    try {
      const s = await (await fetch('/api/stats')).json();
      this.$('wdl-w').textContent = s.white ?? 0;
      this.$('wdl-d').textContent = s.draw ?? 0;
      this.$('wdl-l').textContent = s.black ?? 0;
    } catch { /* stats are decorative; ignore */ }
  }
}
