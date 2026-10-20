'use strict';
// RULETA DEL CAOS: ruleta europea (37 casillas). Rojo/Negro 2× (18/37), Verde 36× (1/37). Ambos con RTP 97.3%.
const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n) => (n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black');
const MULT = { red: 2, black: 2, green: 36 };
const SPIN_MS = 6500;

module.exports = {
  id: 'roulette', name: 'Ruleta del Caos', emoji: '🎡', mode: 'house', usesBet: true, needsChoice: ['red', 'black', 'green'], playMs: SPIN_MS + 1500, revealMs: 900,
  tagline: 'Rojo, negro o verde. La bola decide.',
  rules: ['Elegí color y apostá antes del cierre.', 'Rojo y Negro pagan ×2 (18/37).', 'Verde paga ×36 (1/37).', 'El resultado lo sortea el servidor.'],
  WHEEL, colorOf, MULT,
  createRound(ctx) { return { number: ctx.rngInt(37), revealed: false }; },
  init() {},
  publicState(st) {
    return { wheel: WHEEL, mult: MULT, spinMs: SPIN_MS, result: st.revealed ? { number: st.number, color: colorOf(st.number) } : null };
  },
  privateState() { return {}; },
  onStart(st, api) {
    st.revealed = true;
    api.emit('spin', { number: st.number, color: colorOf(st.number), spinMs: SPIN_MS, startedAt: api.now() });
    api.later(api.scale(SPIN_MS + 300), () => api.finish());
  },
  onAction() { return { ok: false, error: 'No hay acciones en esta ruleta' }; },
  resolve(st, ctx) {
    const color = colorOf(st.number); const outcomes = {};
    for (const [pid, b] of Object.entries(ctx.bets)) {
      const win = b.choice === color;
      outcomes[pid] = { payout: win ? b.amount * MULT[color] : 0, detail: { number: st.number, color, choice: b.choice, win } };
    }
    return { outcomes };
  },
};
