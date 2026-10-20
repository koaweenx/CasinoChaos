'use strict';
// ALTO O BAJO: modo casa. Cada acierto multiplica. Empate de rango = "repite" (no cuenta ni multiplica).
const MAX_GUESSES = 5, MAX_TOTAL_MULT = 25, EDGE = 0.94, MAX_PUSHES = 5;
const SUITS = ['♠', '♥', '♦', '♣'];

// k = cantidad de rangos favorables entre los 12 distintos al actual.
function stepMult(rank, dir) {
  const k = dir === 'higher' ? 13 - rank : rank - 1;
  if (k <= 0) return null;
  return Math.min(6, Math.round(EDGE * (12 / k) * 100) / 100);
}
const card = (rngInt) => ({ rank: 1 + rngInt(13), suit: SUITS[rngInt(4)] });

function view(h) {
  return {
    card: h.card, mult: h.mult, guesses: h.guesses, done: h.done, dead: h.dead, history: h.history,
    maxGuesses: MAX_GUESSES, next: { higher: stepMult(h.card.rank, 'higher'), lower: stepMult(h.card.rank, 'lower') },
  };
}

module.exports = {
  id: 'high-low', name: 'Alto o Bajo', emoji: '🃏', mode: 'house', usesBet: true, playMs: 30000, revealMs: 800,
  tagline: '¿La próxima carta es más alta o más baja?',
  rules: ['Adiviná si la próxima carta es más ALTA o más BAJA.', 'Cada acierto multiplica tu apuesta (hasta 5 aciertos, tope ×25).', 'Misma carta = se repite, no cuenta.', 'Podés plantarte cuando quieras. Si fallás, perdés la apuesta.'],
  MAX_GUESSES, stepMult, EDGE,
  createRound(ctx) { return { hands: {}, rngInt: ctx.rngInt }; },
  init(st, bets) { for (const pid of Object.keys(bets)) st.hands[pid] = { card: card(st.rngInt), mult: 1, guesses: 0, pushes: 0, done: false, dead: false, history: [] }; },
  publicState(st) {
    return { progress: Object.fromEntries(Object.entries(st.hands).map(([k, h]) => [k, { guesses: h.guesses, done: h.done, dead: h.dead }])) };
  },
  privateState(st, pid) { return st.hands[pid] ? view(st.hands[pid]) : {}; },
  onStart() {},
  onAction(st, pid, a, api) {
    const h = st.hands[pid];
    if (!h) return { ok: false, error: 'No apostaste en esta ronda' };
    if (h.done) return { ok: false, error: 'Tu mano ya terminó' };
    if (a.type === 'cashout') {
      h.done = true;
    } else if (a.type === 'guess') {
      if (a.dir !== 'higher' && a.dir !== 'lower') return { ok: false, error: 'Dirección inválida' };
      const m = stepMult(h.card.rank, a.dir);
      if (m === null) return { ok: false, error: 'Esa opción es imposible con esta carta' };
      const next = card(st.rngInt);
      const prev = h.card;
      let res;
      if (next.rank === prev.rank && h.pushes < MAX_PUSHES) { res = 'push'; h.pushes++; }
      else if ((a.dir === 'higher' && next.rank > prev.rank) || (a.dir === 'lower' && next.rank < prev.rank)) {
        res = 'win'; h.mult = Math.min(MAX_TOTAL_MULT, Math.round(h.mult * m * 100) / 100); h.guesses++;
        if (h.guesses >= MAX_GUESSES) h.done = true;
      } else { res = 'lose'; h.dead = true; h.done = true; h.mult = 0; h.guesses++; }
      h.history.push({ from: prev, to: next, dir: a.dir, res });
      h.card = next;
    } else return { ok: false, error: 'Acción inválida' };
    if (Object.values(st.hands).every((x) => x.done)) api.finish();
    return { ok: true };
  },
  resolve(st, ctx) {
    const outcomes = {};
    for (const [pid, b] of Object.entries(ctx.bets)) {
      const h = st.hands[pid];
      const payout = h.dead ? 0 : Math.floor(b.amount * (h.guesses === 0 ? 1 : h.mult));
      outcomes[pid] = { payout, detail: { mult: h.mult, guesses: h.guesses, dead: h.dead, history: h.history } };
    }
    return { outcomes };
  },
};
