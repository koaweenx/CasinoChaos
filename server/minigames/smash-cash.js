'use strict';
// SMASH CASH: 15 s de objetivos. El servidor genera el calendario de objetivos (igual para todos) y
// valida cada golpe: objetivo existente, ventana de tiempo, sin repetir. El puntaje lo calcula el servidor.
const DURATION = 15000, GRACE = 700, TOL = 250;
const BASE = { coin: 100, gold: 300 }, TRAP = -150, MAX_MULT = 3;

function makeSchedule(rngInt, count = 30) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = rngInt(100);
    const type = r < 70 ? 'coin' : r < 82 ? 'gold' : 'trap';
    out.push({
      id: i, t: 400 + i * 440 + rngInt(160), type, life: type === 'gold' ? 1100 : 1600,
      x: 8 + rngInt(85), y: 8 + rngInt(85), // porcentaje del tablero
    });
  }
  return out;
}

/** Puntaje determinista a partir del calendario y los golpes válidos (id -> ms desde el inicio). */
function scoreFor(schedule, hits, upTo = Infinity) {
  let score = 0, combo = 0, best = 0, hitsOk = 0, traps = 0;
  const sorted = [...schedule].sort((a, b) => a.t - b.t);
  for (const t of sorted) {
    const hitAt = hits[t.id];
    if (hitAt !== undefined && hitAt <= upTo) {
      if (t.type === 'trap') { score += TRAP; combo = 0; traps++; }
      else {
        combo++; best = Math.max(best, combo); hitsOk++;
        const mult = Math.min(MAX_MULT, 1 + Math.floor((combo - 1) / 4) * 0.5);
        score += Math.round(BASE[t.type] * mult);
      }
    } else if (t.t + t.life <= upTo && t.type !== 'trap') combo = 0; // objetivo perdido rompe el combo
  }
  return { score: Math.max(0, score), combo, bestCombo: best, hitsOk, traps };
}
const maxScore = (schedule) => scoreFor(schedule, Object.fromEntries(schedule.filter((t) => t.type !== 'trap').map((t) => [t.id, t.t]))).score;

module.exports = {
  id: 'smash-cash', name: 'Smash Cash', emoji: '🎯', mode: 'pot', usesBet: true, playMs: DURATION + GRACE + 600, revealMs: 1200,
  tagline: '15 segundos. Tocá las monedas, esquivá las bombas.',
  rules: ['Tocá monedas (100) y lingotes dorados (300).', 'Las bombas restan puntos y rompen tu combo.', 'Aciertos seguidos suben el multiplicador (hasta ×3).', 'El mejor puntaje se lleva la mayor parte del pozo.'],
  DURATION, GRACE, scoreFor, makeSchedule, maxScore,
  createRound(ctx) { return { participants: new Set(ctx.players), schedule: makeSchedule(ctx.rngInt), startAt: null, hits: {}, last: {} }; },
  init() {},
  publicState(st) {
    return { duration: DURATION, schedule: st.startAt ? st.schedule : null, startAt: st.startAt };
  },
  privateState() { return {}; },
  onStart(st, api) {
    st.startAt = api.now();
    api.emit('start', { startAt: st.startAt, duration: DURATION, schedule: st.schedule });
    const tick = () => {
      const t = api.now() - st.startAt;
      const live = {};
      for (const pid of st.participants) live[pid] = scoreFor(st.schedule, st.hits[pid] || {}, t).score;
      api.emit('scores', { scores: live });
      if (t < DURATION) api.later(1000, tick);
    };
    api.later(1000, tick);
    api.later(DURATION + GRACE, () => api.finish());
  },
  onAction(st, pid, a, api) {
    if (a.type !== 'hit') return { ok: false, error: 'Acción inválida' };
    if (!st.participants.has(pid) || !st.startAt) return { ok: false, error: 'No participás' };
    const t = st.schedule[a.id];
    if (!Number.isInteger(a.id) || !t) return { ok: false, error: 'Objetivo inválido' };
    const hits = (st.hits[pid] ||= {});
    if (hits[a.id] !== undefined) return { ok: false, error: 'Objetivo ya golpeado' };
    const now = api.now() - st.startAt - Math.min(api.halfRtt(pid), 150);
    if (now < t.t - TOL || now > t.t + t.life + TOL) return { ok: false, error: 'Fuera de tiempo' };
    if (now > DURATION + GRACE) return { ok: false, error: 'Se terminó el tiempo' };
    hits[a.id] = Math.max(t.t, Math.min(now, t.t + t.life));
    return { ok: true };
  },
  resolve(st) {
    const rows = [...st.participants].map((pid) => ({ pid, ...scoreFor(st.schedule, st.hits[pid] || {}) }));
    rows.sort((a, b) => b.score - a.score);
    const order = [];
    for (const r of rows) {
      const last = order[order.length - 1];
      if (last && last.score === r.score) last.ids.push(r.pid); else order.push({ ids: [r.pid], score: r.score });
    }
    const details = Object.fromEntries(rows.map((r) => [r.pid, { score: r.score, bestCombo: r.bestCombo, hitsOk: r.hitsOk, traps: r.traps }]));
    return { order: order.map((g) => g.ids), dq: new Set(), details };
  },
};
