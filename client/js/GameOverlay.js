const RESTART_SECONDS = 8;

export class GameOverlay {
  /** @param {() => void} onRestart called when the countdown ends or "Start now" is pressed */
  constructor(onRestart) {
    this.onRestart = onRestart;
    this.root = document.getElementById('overlay');
    this.timer = null;
    document.getElementById('overlay-cancel').addEventListener('click', () => this.hide());
    document.getElementById('overlay-now').addEventListener('click', () => { this.hide(); this.onRestart(); });
  }

  show({ winner, reason }) {
    const title = winner === 'draw' ? 'Draw' : `${winner === 'white' ? 'White' : 'Black'} wins`;
    document.getElementById('overlay-title').textContent = title;
    const r = reason ?? '';
    document.getElementById('overlay-reason').textContent = r ? `by ${r}` : '';
    this.root.hidden = false;
    let left = RESTART_SECONDS;
    const count = document.getElementById('overlay-count');
    count.textContent = left;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      left--;
      count.textContent = left;
      if (left <= 0) { this.hide(); this.onRestart(); }
    }, 1000);
  }

  hide() { clearInterval(this.timer); this.timer = null; this.root.hidden = true; }
}
