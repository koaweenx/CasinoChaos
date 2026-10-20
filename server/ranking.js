'use strict';
// Criterio: 1) más monedas, 2) más rondas ganadas, 3) empate declarado.
function computeStandings(players) {
  const list = [...players].sort((a, b) => b.balance - a.balance || b.roundWins - a.roundWins);
  let rank = 0; let prev = null;
  const out = list.map((p, i) => {
    if (!prev || prev.balance !== p.balance || prev.roundWins !== p.roundWins) rank = i + 1;
    prev = p;
    return { id: p.id, rank, balance: p.balance, roundWins: p.roundWins };
  });
  out.forEach((o) => { o.tied = out.filter((x) => x.rank === o.rank).length > 1; });
  return out;
}
module.exports = { computeStandings };
