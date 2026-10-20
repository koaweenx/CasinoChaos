'use strict';
// Reglas económicas puras (sin estado): fáciles de testear.

const GEMS = { participation: 5, champion: 40, second: 15, third: 8, tieChampion: 25 };
const ACHIEVEMENTS = {
  first_win: { gems: 20, label: 'Primera victoria' },
  jackpot: { gems: 25, label: 'Jackpot en Lucky Spin' },
  games_10: { gems: 15, label: '10 partidas jugadas' },
  golden_hands: { gems: 20, label: 'Triplicaste tu saldo inicial' },
};

function clampBet(amount, { minBet, maxBet, balance }) {
  if (!Number.isSafeInteger(amount)) return { ok: false, error: 'Apuesta inválida' };
  if (amount < minBet) return { ok: false, error: `La apuesta mínima es ${minBet}` };
  if (amount > maxBet) return { ok: false, error: `La apuesta máxima es ${maxBet}` };
  if (amount > balance) return { ok: false, error: 'No tenés monedas suficientes' };
  return { ok: true };
}

/**
 * Reparte un pozo entre apostadores según el orden de llegada. NUNCA crea ni destruye monedas:
 * la suma de pagos == suma de apuestas.
 * @param bets   { pid: monto }
 * @param order  [[pid, ...empatados], [pid], ...] de mejor a peor (pueden incluir no apostadores)
 * @param dq     Set de pids descalificados (pierden su apuesta a favor del pozo)
 */
function distributePot(bets, order, dq = new Set()) {
  const ids = Object.keys(bets);
  const pot = ids.reduce((s, id) => s + bets[id], 0);
  const payouts = Object.fromEntries(ids.map((id) => [id, 0]));
  const groups = order
    .map((g) => g.filter((id) => id in bets && !dq.has(id)))
    .filter((g) => g.length);
  const n = groups.reduce((s, g) => s + g.length, 0);
  if (n === 0 || pot === 0) { ids.forEach((id) => { payouts[id] = bets[id]; }); return payouts; }
  // Pesos lineales: el 1º vale n, el 2º n-1, ... el último 1.
  let pos = 0; const gw = [];
  for (const g of groups) { let w = 0; for (let i = 0; i < g.length; i++) w += n - pos++; gw.push(w); }
  const totalW = gw.reduce((a, b) => a + b, 0);
  let given = 0;
  groups.forEach((g, gi) => {
    const share = Math.floor((pot * gw[gi]) / totalW);
    const each = Math.floor(share / g.length);
    g.forEach((id) => { payouts[id] += each; given += each; });
    let rest = share - each * g.length; // resto del grupo, de a 1 moneda
    for (let i = 0; rest > 0; i = (i + 1) % g.length, rest--) { payouts[g[i]] += 1; given += 1; }
  });
  let rem = pot - given; // resto global: al primero
  const first = groups[0][0];
  payouts[first] += rem;
  return payouts;
}

/** Gemas de una partida. */
function gemReward({ rank, tied, completedRounds, aborted, left }) {
  if (left || completedRounds < 1) return { gems: 0, parts: [] };
  const parts = [];
  if (!aborted || completedRounds >= 2) parts.push(['Participación', GEMS.participation]);
  if (!aborted) {
    if (rank === 1) parts.push([tied ? 'Campeón compartido' : 'Campeón', tied ? GEMS.tieChampion : GEMS.champion]);
    else if (rank === 2) parts.push(['2º puesto', GEMS.second]);
    else if (rank === 3) parts.push(['3er puesto', GEMS.third]);
  }
  return { gems: parts.reduce((s, p) => s + p[1], 0), parts };
}

module.exports = { GEMS, ACHIEVEMENTS, clampBet, distributePot, gemReward };
