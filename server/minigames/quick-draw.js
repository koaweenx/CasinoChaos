'use strict';
// QUICK DRAW: reflejos. El servidor mide el tiempo desde la señal GO. Pozo compartido entre apostadores.
const GO_WINDOW_MS = 3000;

module.exports = {
  id: 'quick-draw', name: 'Quick Draw', emoji: '⚡', mode: 'pot', usesBet: true, playMs: 12000, revealMs: 1200,
  tagline: 'Esperá la señal… ¡y tocá primero!',
  rules: ['Esperá a que la pantalla se ponga VERDE.', 'El más rápido se lleva la mayor parte del pozo.', 'Tocar antes de tiempo = descalificado y perdés tu apuesta.', 'Si no apostás, jugás por la gloria.'],
  GO_WINDOW_MS,
  createRound(ctx) {
    return { participants: new Set(ctx.players), phase: 'wait', goAt: null, presses: {}, delay: 0 };
  },
  init() {},
  publicState(st) {
    return { phase: st.phase, presses: Object.fromEntries(Object.entries(st.presses).map(([k, v]) => [k, { ms: v.ms, early: v.early }])) };
  },
  privateState() { return {}; },
  onStart(st, api) {
    st.delay = api.scale(2000 + api.rngInt(4001));
    st.phase = 'ready';
    api.emit('ready', {});
    api.later(st.delay, () => {
      st.phase = 'go'; st.goAt = api.now();
      api.emit('go', { at: st.goAt });
      api.later(Math.max(400, api.scale(GO_WINDOW_MS)), () => api.finish());
    });
  },
  onAction(st, pid, a, api) {
    if (a.type !== 'press') return { ok: false, error: 'Acción inválida' };
    if (!st.participants.has(pid)) return { ok: false, error: 'No participás' };
    if (st.presses[pid]) return { ok: true };
    const now = api.now();
    if (st.phase !== 'go') {
      st.presses[pid] = { early: true, ms: null };
      api.emit('press', { pid, early: true });
    } else {
      const ms = Math.max(1, Math.round(now - st.goAt - Math.min(api.halfRtt(pid), 150)));
      st.presses[pid] = { early: false, ms };
      api.emit('press', { pid, ms });
    }
    if ([...st.participants].every((id) => st.presses[id])) api.finish();
    return { ok: true };
  },
  resolve(st) {
    const dq = new Set(); const valid = []; const none = [];
    for (const pid of st.participants) {
      const p = st.presses[pid];
      if (!p) none.push(pid); else if (p.early) dq.add(pid); else valid.push([pid, p.ms]);
    }
    valid.sort((a, b) => a[1] - b[1]);
    const order = [];
    for (const [pid, ms] of valid) {
      const last = order[order.length - 1];
      if (last && last.ms === ms) last.ids.push(pid); else order.push({ ids: [pid], ms });
    }
    const groups = order.map((g) => g.ids);
    if (none.length) groups.push(none);
    if (dq.size) groups.push([...dq]);
    const details = {};
    for (const pid of st.participants) details[pid] = { ms: st.presses[pid]?.ms ?? null, early: !!st.presses[pid]?.early, noPress: !st.presses[pid] };
    return { order: groups, dq, details };
  },
};
