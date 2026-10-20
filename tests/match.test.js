'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { T } = require('../server/rooms');
const { startServer, client, emit, sleep, waitFor, bot } = require('./helpers');

const NO_SMASH = ['lucky-spin', 'roulette', 'quick-draw', 'high-low', 'cursed-chests'];

async function lobby(s, names, settings = {}) {
  const cs = []; let code;
  for (const n of names) {
    const c = await client(s, { name: n }); cs.push(c);
    if (!code) code = (await emit(c, 'room:create')).code; else await emit(c, 'room:join', { code });
  }
  await waitFor(() => cs[0].snap.players.length === names.length);
  const r = await emit(cs[0], 'room:settings', { rounds: 6, games: NO_SERIAL(settings), minBet: 20, maxBet: 200, ...settings.s });
  assert.equal(r.ok, true, r.error);
  return { cs, code };
}
const NO_SERIAL = (o) => o.games || NO_SMASH;

test('partida completa: 5 minijuegos jugables, saldos nunca negativos, resultados sincronizados', async () => {
  const s = await startServer();
  try {
    const { cs } = await lobby(s, ['Ana', 'Beto', 'Caro']);
    cs.forEach((c) => bot(c));
    const seen = new Set(); let negative = false;
    cs[0].on('room:state', (st) => { if (st.round) seen.add(st.round.gameId); if (st.players.some((p) => p.balance < 0)) negative = true; });
    assert.equal((await emit(cs[0], 'room:start')).ok, true);
    await waitFor(() => cs.every((c) => c.snap.phase === 'final'), 60000);
    assert.equal(negative, false);
    assert.ok(seen.size >= 5, `se jugaron ${[...seen]}`);
    const f0 = JSON.stringify(cs[0].snap.final.standings), f1 = JSON.stringify(cs[1].snap.final.standings), f2 = JSON.stringify(cs[2].snap.final.standings);
    assert.equal(f0, f1); assert.equal(f1, f2);
    const st = cs[0].snap.final.standings;
    assert.equal(st.length, 3); assert.equal(st[0].rank, 1);
    for (const x of st) assert.ok(x.balance >= 0);
    // Cada jugador recibió gemas una sola vez
    for (const x of st) {
      const p = s.store.getProfile(x.id);
      const expected = x.gems + x.achievements.reduce((a, b) => a + b.gems, 0);
      assert.equal(p.gems, expected, 'gemas = premio de partida + logros');
      assert.equal(p.stats.gamesPlayed, 1);
    }
    assert.equal(st.filter((x) => x.champion).length >= 1, true);
    const champ = st.find((x) => x.champion);
    assert.ok(champ.gems >= 30, 'el campeón recibe recompensa especial');
  } finally { await s.close(); }
});

test('premio de campeonato no se duplica: reconexión, reintentos y revancha', async () => {
  const s = await startServer();
  try {
    const { cs, code } = await lobby(s, ['Ana', 'Beto'], { s: { rounds: 3 }, games: ['roulette', 'high-low'] });
    cs.forEach((c) => bot(c));
    await emit(cs[0], 'room:start');
    await waitFor(() => cs[0].snap.phase === 'final', 40000);
    const gems = () => cs.map((c) => s.store.getProfile(c.id).gems);
    const g1 = gems();
    // reconexión del campeón
    const room = s.mgr.rooms.get(code);
    room.finish(false); room.finish(true); // reintentos directos: no hacen nada
    const re = await client(s, { token: cs[0].token });
    assert.equal(re.hello.room, code);
    await sleep(100);
    assert.deepEqual(gems(), g1);
    assert.equal(s.store.getProfile(cs[0].id).stats.gamesPlayed, 1);
    // revancha: nueva partida (nuevo matchId), una sola entrega más
    re.close();
    assert.equal((await emit(cs[1], 'room:rematch')).ok, false, 'solo el anfitrión pide revancha');
    const c0b = await client(s, { token: cs[0].token }); bot(c0b);
    assert.equal((await emit(c0b, 'room:rematch')).ok, true);
    await waitFor(() => c0b.snap?.phase !== 'final' && c0b.snap?.round, 5000);
    await waitFor(() => cs[1].snap.phase === 'final' && c0b.snap?.phase === 'final', 40000);
    assert.equal(s.store.getProfile(cs[0].id).stats.gamesPlayed, 2);
    assert.equal(s.store.db.prepare("SELECT COUNT(*) c FROM matches").get().c, 2);
    // volver al lobby
    assert.equal((await emit(c0b, 'room:lobby')).ok, true);
    await waitFor(() => c0b.snap.phase === 'lobby');
    assert.ok(c0b.snap.players.every((p) => p.balance === c0b.snap.settings.startBalance));
  } finally { await s.close(); }
});

test('apuestas: sobre el saldo, fuera de límites, fuera de tiempo y tipos inválidos se rechazan', async () => {
  const s = await startServer({ fast: true });
  const keep = { ...T }; T.betting = 4000; T.announce = 4200; // más aire para probar a mano (se escala x0.02)
  try {
    const { cs } = await lobby(s, ['Ana', 'Beto'], { s: { rounds: 3, minBet: 20, maxBet: 200 }, games: ['roulette'] });
    const a = cs[0];
    // fuera de fase de apuestas
    assert.equal((await emit(a, 'bet:place', { amount: 50, choice: 'red' })).ok, false);
    await emit(a, 'room:start');
    await waitFor(() => a.snap.phase === 'betting', 5000, 5);
    for (const bad of [{ amount: 10, choice: 'red' }, { amount: 201, choice: 'red' }, { amount: 5000, choice: 'red' }, { amount: -50, choice: 'red' }, { amount: 50.5, choice: 'red' }, { amount: '50', choice: 'red' }, { amount: 50 }, { amount: 50, choice: 'azul' }, { amount: null, choice: 'red' }]) {
      const r = await emit(a, 'bet:place', bad); assert.equal(r.ok, false, JSON.stringify(bad));
    }
    assert.equal((await emit(a, 'bet:place', { amount: 100, choice: 'red' })).ok, true);
    assert.equal(a.snap.players.find((p) => p.id === a.id).balance, 1000, 'el saldo se descuenta recién al cerrar apuestas');
    await waitFor(() => ['countdown', 'playing'].includes(a.snap.phase) || a.snap.phase === 'betting' && false, 5000, 5).catch(() => {});
    await waitFor(() => a.snap.phase === 'countdown' || a.snap.phase === 'playing', 8000, 5);
    assert.equal((await emit(a, 'bet:place', { amount: 20, choice: 'red' })).ok, false, 'apuestas cerradas');
    const me = a.snap.players.find((p) => p.id === a.id);
    assert.equal(me.balance, 900); assert.equal(me.bet, 100);
    const other = a.snap.players.find((p) => p.id !== a.id);
    assert.equal(other.bet, null, 'quien no apostó no aparece con apuesta');
  } finally { Object.assign(T, keep); await s.close(); }
});

test('rondas con apuestas: el saldo total se conserva en juegos de pozo y nunca queda negativo', async () => {
  const s = await startServer();
  try {
    const { cs, code } = await lobby(s, ['A', 'B', 'C', 'D'], { s: { rounds: 4 }, games: ['quick-draw'] });
    cs.forEach((c) => bot(c));
    const totals = [];
    cs[0].on('room:state', (st) => { if (st.phase === 'celebrate') totals.push(st.players.reduce((a, p) => a + p.balance, 0)); });
    await emit(cs[0], 'room:start');
    await waitFor(() => cs[0].snap.phase === 'final', 40000);
    assert.ok(totals.length >= 4);
    assert.ok(totals.every((t) => t === 4000 + 0), `Quick Draw es de suma cero: ${totals}`);
    const room = s.mgr.rooms.get(code);
    assert.ok([...room.players.values()].every((p) => p.balance >= 0));
  } finally { await s.close(); }
});

test('anti-trampa: el cliente no puede mandar resultados, tiempos ni saldos', async () => {
  const s = await startServer();
  try {
    const { cs } = await lobby(s, ['Ana', 'Beto'], { s: { rounds: 3 }, games: ['lucky-spin'] });
    const [a, b] = cs;
    await emit(a, 'room:start');
    await waitFor(() => a.snap.phase === 'betting', 5000, 5);
    await emit(a, 'bet:place', { amount: 50 }); await emit(b, 'bet:place', { amount: 50 });
    await waitFor(() => a.snap.phase === 'playing', 8000, 5);
    for (const forged of [{ type: 'setBalance', amount: 99999 }, { type: 'win' }, { amount: 1e9 }, { type: ['spin'] }, { type: 'x'.repeat(40) }]) {
      assert.equal((await emit(a, 'game:action', forged)).ok, false, JSON.stringify(forged));
    }
    // un giro "con trampa": el servidor ignora los campos inventados y sortea por su cuenta
    assert.equal((await emit(a, 'game:action', { type: 'spin', reels: ['jackpot', 'jackpot', 'jackpot'], mult: 100, payout: 1e9 })).ok, true);
    await waitFor(() => a.snap.phase === 'celebrate', 20000);
    const spin = a.snap.round.state.spins[a.id];
    assert.ok(spin && Array.isArray(spin.reels));
    assert.equal(spin.mult, require('../server/minigames/lucky-spin').evaluate(spin.reels).mult, 'el multiplicador lo calcula el servidor');
    const row = a.snap.round.results.rows.find((r) => r.pid === a.id);
    assert.ok(row.payout <= 50 * 100, 'el premio sale del servidor');
    assert.equal(row.payout, Math.floor(50 * spin.mult));
    assert.ok(a.snap.players.find((p) => p.id === a.id).balance <= 1000 + 50 * 99);
    assert.equal((await emit(a, 'game:action', { type: 'spin' })).ok, false, 'no se puede girar fuera de la fase de juego');
  } finally { await s.close(); }
});

test('desconexión y reingreso: el jugador vuelve a la partida en curso', async () => {
  const s = await startServer();
  try {
    const { cs, code } = await lobby(s, ['Ana', 'Beto', 'Caro'], { s: { rounds: 5 }, games: ['roulette', 'high-low'] });
    cs.forEach((c) => bot(c));
    await emit(cs[0], 'room:start');
    await waitFor(() => cs[1].snap?.round?.index >= 0);
    const bId = cs[1].id; cs[1].close();
    await waitFor(() => cs[0].snap.players.find((p) => p.id === bId)?.connected === false);
    const back = await client(s, { token: cs[1].token }); bot(back);
    assert.equal(back.hello.room, code, 'el servidor lo devuelve a su sala');
    await waitFor(() => back.snap?.players.find((p) => p.id === bId)?.connected === true);
    assert.equal(back.snap.players.length, 3);
    assert.notEqual(back.snap.phase, 'lobby');
    await waitFor(() => cs[0].snap.phase === 'final', 40000);
    assert.equal(cs[0].snap.final.standings.find((x) => x.id === bId).left, false);
  } finally { await s.close(); }
});

test('el anfitrión se desconecta: se transfiere el mando; abandonar en plena ronda no rompe la partida', async () => {
  const s = await startServer();
  const keep = { ...T }; T.hostGrace = 150;
  try {
    const { cs } = await lobby(s, ['Ana', 'Beto', 'Caro'], { s: { rounds: 5 }, games: ['roulette'] });
    cs.forEach((c) => bot(c));
    await emit(cs[0], 'room:start');
    await waitFor(() => cs[1].snap?.round);
    const hostId = cs[0].id; cs[0].close();
    await waitFor(() => cs[1].snap.hostId !== hostId, 3000);
    assert.ok([cs[1].id, cs[2].id].includes(cs[1].snap.hostId));
    await emit(cs[2], 'room:leave');
    await waitFor(() => cs[1].snap.players.find((p) => p.id === cs[2].id)?.left === true);
    // quedan menos de 2 jugadores activos conectados: la partida termina de forma ordenada sin duplicar premios
    await waitFor(() => cs[1].snap.phase === 'final', 30000);
    assert.equal(cs[1].snap.final.standings.find((x) => x.id === cs[2].id).gems, 0, 'quien abandona no cobra premios');
    assert.equal(cs[1].snap.final.standings.some((x) => x.left), true);
  } finally { Object.assign(T, keep); await s.close(); }
});

test('sala vacía se limpia y los códigos se liberan', async () => {
  const s = await startServer();
  try {
    const a = await client(s, { name: 'Ana' }); const { code } = await emit(a, 'room:create');
    assert.equal(s.mgr.rooms.has(code), true);
    await emit(a, 'room:leave');
    await waitFor(() => !s.mgr.rooms.has(code), 2000);
    assert.equal(s.mgr.stats().rooms, 0);
  } finally { await s.close(); }
});
