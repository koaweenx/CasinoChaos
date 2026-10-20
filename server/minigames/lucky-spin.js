'use strict';
// LUCKY SPIN: tragamonedas de 3 rodillos. Modo "casa": paga la banca. RTP calculable (ver tests).
const SYMBOLS = [
  { id: 'cherry', w: 30, triple: 4 },
  { id: 'star', w: 24, triple: 5 },
  { id: 'bell', w: 18, triple: 8 },
  { id: 'diamond', w: 14, triple: 15 },
  { id: 'seven', w: 10, triple: 30 },
  { id: 'jackpot', w: 4, triple: 100 },
];
const TOTAL_W = SYMBOLS.reduce((s, x) => s + x.w, 0);
const PAIR = { cherry: 1, other: 1.5 };

function pickSymbol(rngInt) {
  let r = rngInt(TOTAL_W);
  for (const s of SYMBOLS) { if (r < s.w) return s.id; r -= s.w; }
  return SYMBOLS[0].id;
}

function evaluate(reels) {
  const [a, b, c] = reels;
  if (a === b && b === c) return { kind: 'triple', symbol: a, mult: SYMBOLS.find((s) => s.id === a).triple };
  const sym = a === b ? a : (a === c ? a : (b === c ? b : null));
  if (sym) return { kind: 'pair', symbol: sym, mult: sym === 'cherry' ? PAIR.cherry : PAIR.other };
  return { kind: 'none', symbol: null, mult: 0 };
}

function spin(rngInt) {
  const reels = [pickSymbol(rngInt), pickSymbol(rngInt), pickSymbol(rngInt)];
  return { reels, ...evaluate(reels) };
}

/** RTP exacto por enumeración de las 216 combinaciones ponderadas. */
function theoreticalRtp() {
  let rtp = 0;
  for (const x of SYMBOLS) for (const y of SYMBOLS) for (const z of SYMBOLS) {
    const p = (x.w / TOTAL_W) * (y.w / TOTAL_W) * (z.w / TOTAL_W);
    rtp += p * evaluate([x.id, y.id, z.id]).mult;
  }
  return rtp;
}

const payTable = () => [
  ...SYMBOLS.slice().reverse().map((s) => ({ label: `3× ${s.id}`, symbols: [s.id, s.id, s.id], mult: s.triple })),
  { label: '2× cereza', symbols: ['cherry', 'cherry', null], mult: PAIR.cherry },
  { label: '2× igual (otro)', symbols: ['star', 'star', null], mult: PAIR.other },
];

module.exports = {
  id: 'lucky-spin', name: 'Lucky Spin', emoji: '🎰', mode: 'house', usesBet: true, playMs: 16000, revealMs: 3800,
  tagline: 'Apostá y girá los rodillos. ¡Tres iguales pagan!',
  rules: ['Apostá antes del cierre y pulsá GIRAR.', 'Tres símbolos iguales pagan según la tabla.', 'Dos iguales devuelven o mejoran tu apuesta.', 'Si no girás a tiempo, el servidor gira por vos.'],
  SYMBOLS, evaluate, spin, theoreticalRtp,
  createRound() { return { spins: {}, pending: new Set() }; },
  init(st, bets) { st.pending = new Set(Object.keys(bets)); },
  publicState(st) { return { payTable: payTable(), spins: st.spins }; },
  privateState() { return {}; },
  onStart() {},
  onAction(st, pid, a, api) {
    if (a.type !== 'spin') return { ok: false, error: 'Acción inválida' };
    if (!st.pending.has(pid)) return { ok: false, error: st.spins[pid] ? 'Ya giraste' : 'No apostaste en esta ronda' };
    const s = spin(api.rngInt);
    st.spins[pid] = s; st.pending.delete(pid);
    api.emit('spin', { pid, ...s });
    if (st.pending.size === 0) api.finish();
    return { ok: true };
  },
  resolve(st, ctx) {
    const outcomes = {};
    for (const pid of Object.keys(ctx.bets)) {
      if (!st.spins[pid]) st.spins[pid] = spin(ctx.rngInt); // giro automático
      const s = st.spins[pid];
      outcomes[pid] = { payout: Math.floor(ctx.bets[pid].amount * s.mult), detail: { reels: s.reels, mult: s.mult, kind: s.kind }, jackpot: s.kind === 'triple' && s.symbol === 'jackpot' };
    }
    return { outcomes };
  },
};
