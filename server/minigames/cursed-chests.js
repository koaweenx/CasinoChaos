'use strict';
// COFRES MALDITOS: modo casa. 6 cofres por jugador, hasta 4 aperturas. El contenido vive solo en el servidor.
const CHESTS = 6, MAX_OPEN = 4;
const TABLE = [ // pesos sobre 100
  { type: 'small', w: 30, f: 0.25 },
  { type: 'medium', w: 20, f: 0.5 },
  { type: 'big', w: 10, f: 1 },
  { type: 'mult', w: 8, f: 1.4 },
  { type: 'trap', w: 32 },
];
function roll(rngInt) {
  let r = rngInt(100);
  for (const t of TABLE) { if (r < t.w) return t; r -= t.w; }
  return TABLE[0];
}

function view(h) {
  return { stake: h.stake, value: h.value, opened: h.opened, picks: h.opened.length, maxOpen: MAX_OPEN, chests: CHESTS, done: h.done, dead: h.dead };
}

module.exports = {
  id: 'cursed-chests', name: 'Cofres Malditos', emoji: '💎', mode: 'house', usesBet: true, playMs: 40000, revealMs: 800,
  tagline: 'Abrí cofres, juntá tesoros y retirate a tiempo.',
  rules: ['Tenés 6 cofres y hasta 4 aperturas.', 'Hay tesoros (+25%, +50%, +100%), multiplicadores ×1.4 y TRAMPAS.', 'Una trampa te quita todo lo acumulado.', 'Podés retirarte cuando quieras con lo que llevás.'],
  CHESTS, MAX_OPEN, TABLE,
  createRound(ctx) { return { hands: {}, rngInt: ctx.rngInt }; },
  init(st, bets) {
    for (const [pid, b] of Object.entries(bets)) {
      st.hands[pid] = { stake: b.amount, value: b.amount, layout: Array.from({ length: CHESTS }, () => roll(st.rngInt)), opened: [], done: false, dead: false };
    }
  },
  publicState(st) {
    return { progress: Object.fromEntries(Object.entries(st.hands).map(([k, h]) => [k, { opened: h.opened.length, done: h.done, dead: h.dead }])) };
  },
  privateState(st, pid, phase) {
    const h = st.hands[pid]; if (!h) return {};
    const v = view(h);
    if (h.done && phase !== 'playing') v.reveal = h.layout.map((c, i) => ({ i, type: c.type, f: c.f ?? null })); // se revela al terminar
    return v;
  },
  onStart() {},
  onAction(st, pid, a, api) {
    const h = st.hands[pid];
    if (!h) return { ok: false, error: 'No apostaste en esta ronda' };
    if (h.done) return { ok: false, error: 'Ya terminaste' };
    if (a.type === 'cashout') h.done = true;
    else if (a.type === 'open') {
      if (!Number.isInteger(a.index) || a.index < 0 || a.index >= CHESTS) return { ok: false, error: 'Cofre inválido' };
      if (h.opened.some((o) => o.i === a.index)) return { ok: false, error: 'Ese cofre ya está abierto' };
      const c = h.layout[a.index];
      let gain = 0;
      if (c.type === 'trap') { h.value = 0; h.dead = true; h.done = true; }
      else if (c.type === 'mult') { const nv = Math.floor(h.value * c.f); gain = nv - h.value; h.value = nv; }
      else { gain = Math.max(1, Math.floor(h.stake * c.f)); h.value += gain; }
      h.opened.push({ i: a.index, type: c.type, gain });
      if (h.opened.length >= MAX_OPEN) h.done = true;
    } else return { ok: false, error: 'Acción inválida' };
    if (Object.values(st.hands).every((x) => x.done)) api.finish();
    return { ok: true };
  },
  resolve(st, ctx) {
    const outcomes = {};
    for (const [pid, b] of Object.entries(ctx.bets)) {
      const h = st.hands[pid]; h.done = true;
      outcomes[pid] = { payout: h.value, detail: { opened: h.opened, dead: h.dead, value: h.value } };
    }
    return { outcomes };
  },
};
