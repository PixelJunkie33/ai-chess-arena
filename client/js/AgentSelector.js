import { PERSONALITIES } from './ChessEngine.js';

const BLURB = {
  Aggressor:  'Hunts material. Rewards captures (+15%) and searches 6 plies.',
  Positional: 'Plays for outposts (+10%) and long-term structure. Searches 7 plies.',
  Defender:   'Keeps the king safe (+20%) and plays solid. Searches 5 plies.',
  Chaotic:    'Adds ±25% noise to every judgement. Fast, shallow, unpredictable.',
};

export class AgentSelector {
  constructor(onChange) {
    this.onChange = onChange;
    this.selects = { white: document.getElementById('select-white'), black: document.getElementById('select-black') };
    for (const [color, sel] of Object.entries(this.selects)) {
      for (const [name, p] of Object.entries(PERSONALITIES)) {
        sel.add(new Option(`${name} — ${p.style}`, name));
      }
      sel.addEventListener('change', () => { this.describe(color); this.onChange?.(this.value()); });
    }
  }

  value() { return { agentWhite: this.selects.white.value, agentBlack: this.selects.black.value }; }

  set({ agentWhite, agentBlack }) {
    if (agentWhite) this.selects.white.value = agentWhite;
    if (agentBlack) this.selects.black.value = agentBlack;
    this.describe('white'); this.describe('black');
  }

  /** Lock selection while a match is in progress. */
  setLocked(locked) { for (const s of Object.values(this.selects)) s.disabled = locked; }

  describe(color) {
    document.getElementById(`desc-${color}`).textContent = BLURB[this.selects[color].value] ?? '';
  }

  setThinking(color, elapsedMs) {
    for (const c of ['white', 'black']) {
      const on = c === color && elapsedMs != null;
      document.getElementById(`thinking-${c}`).hidden = !on;
      document.getElementById(`agent-${c}`).classList.toggle('active', on);
      if (on) document.getElementById(`think-time-${c}`).textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
    }
  }
}
