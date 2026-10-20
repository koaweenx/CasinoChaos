'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const economy = require('../server/economy');
const { computeStandings } = require('../server/ranking');
const slots = require('../server/minigames/lucky-spin');
const roulette = require('../server/minigames/roulette');
const qd = require('../server/minigames/quick-draw');
const hl = require('../server/minigames/high-low');
const smash = require('../server/minigames/smash-cash');
const chests = require('../server/minigames/cursed-chests');
const { sanitizeName, sanitizeCode, RateLimiter } = require('../server/security');

const rngInt = (n) => crypto.randomInt(n);
const fakeApi = (over = {}) => {
  let now = 1_000_000; const later = []; const emitted = []; let finished = false;
  return Object.assign({ now: () => now, tick: (ms) => { now += ms; }, rngInt, scale: (x) => x, halfRtt: () => 0, later: (ms, fn) => later.push([ms, fn]), emit: (t, d) => emitted.push({ t, ...d }), finish: () => { finished = true; }, later_, emitted, get finished() { return finished; } }, over);
  function later_() { return later; }
};

test('distributePot: nunca crea ni destruye monedas (fuzz)', () => {
  for (let k = 0; k < 3000; k++) {
    const n = 1 + crypto.randomInt(8); const bets = {}; const ids = [];
    for (let i = 0; i < n; i++) { ids.push('p' + i); bets['p' + i] = 1 + crypto.randomInt(500); }
    const shuffled = [...ids].sort(() => Math.random() - 0.5); const order = []; let i = 0;
    while (i < shuffled.length) { const g = 1 + crypto.randomInt(3); order.push(shuffled.slice(i, i + g)); i += g; }
    const dq = new Set(ids.filter(() => Math.random() < 0.25));
    const pay = economy.distributePot(bets, order, dq);
    const sumBets = Object.values(bets).reduce((a, b) => a + b, 0), sumPay = Object.values(pay).reduce((a, b) => a + b, 0);
    assert.equal(sumPay, sumBets);
    for (const v of Object.values(pay)) assert.ok(Number.isInteger(v) && v >= 0);
    for (const d of dq) if (ids.some((x) => !dq.has(x))) assert.equal(pay[d], 0, 'un descalificado no cobra');
  }
});

test('distributePot: ganador cobra más; empate reparte parejo; todos descalificados = devolución', () => {
  const p = economy.distributePot({ a: 100, b: 100, c: 100 }, [['a'], ['b'], ['c']]);
  assert.ok(p.a > p.b && p.b > p.c);
  const t = economy.distributePot({ a: 100, b: 100 }, [['a', 'b']]);
  assert.equal(t.a, 100); assert.equal(t.b, 100);
  const r = economy.distributePot({ a: 50, b: 70 }, [['a', 'b']], new Set(['a', 'b']));
  assert.deepEqual(r, { a: 50, b: 70 });
  assert.deepEqual(economy.distributePot({ a: 80 }, [['a']]), { a: 80 });
});

test('apuestas: validación de límites y saldo', () => {
  const L = { minBet: 20, maxBet: 250, balance: 100 };
  assert.equal(economy.clampBet(50, L).ok, true);
  assert.equal(economy.clampBet(10, L).ok, false);
  assert.equal(economy.clampBet(101, L).ok, false, 'no puede superar el saldo');
  assert.equal(economy.clampBet(300, { ...L, balance: 999 }).ok, false);
  for (const bad of [-5, 0, 1.5, NaN, Infinity, '50', null, undefined, 2 ** 60]) assert.equal(economy.clampBet(bad, L).ok, false);
});

test('Lucky Spin: tabla de pagos coherente (RTP exacto) y sin manipulación', () => {
  const rtp = slots.theoreticalRtp();
  assert.ok(rtp > 0.9 && rtp < 1, `RTP ${rtp}`);
  assert.deepEqual(slots.evaluate(['seven', 'seven', 'seven']), { kind: 'triple', symbol: 'seven', mult: 30 });
  assert.equal(slots.evaluate(['cherry', 'bell', 'cherry']).mult, 1);
  assert.equal(slots.evaluate(['bell', 'bell', 'star']).mult, 1.5);
  assert.equal(slots.evaluate(['bell', 'star', 'cherry']).mult, 0);
  // Monte Carlo: el RTP empírico se acerca al teórico
  let tot = 0; const N = 200000;
  for (let i = 0; i < N; i++) tot += slots.spin(rngInt).mult;
  assert.ok(Math.abs(tot / N - rtp) < 0.03, `empírico ${tot / N} vs ${rtp}`);
});

test('Ruleta: pagos consistentes con las probabilidades', () => {
  assert.equal(roulette.WHEEL.length, 37);
  const counts = { red: 0, black: 0, green: 0 };
  roulette.WHEEL.forEach((n) => counts[roulette.colorOf(n)]++);
  assert.deepEqual(counts, { red: 18, black: 18, green: 1 });
  const ev = (c) => (counts[c] / 37) * roulette.MULT[c];
  assert.ok(Math.abs(ev('red') - ev('green')) < 1e-9);
  assert.ok(ev('red') < 1);
  const st = { number: 7, revealed: true }; // 7 es rojo
  const out = roulette.resolve(st, { bets: { a: { amount: 100, choice: 'red' }, b: { amount: 100, choice: 'black' }, c: { amount: 10, choice: 'green' } } }).outcomes;
  assert.equal(out.a.payout, 200); assert.equal(out.b.payout, 0); assert.equal(out.c.payout, 0);
  assert.equal(roulette.resolve({ number: 0 }, { bets: { c: { amount: 10, choice: 'green' } } }).outcomes.c.payout, 360);
});

test('Quick Draw: el servidor mide; anticipar descalifica; empate agrupa', () => {
  const api = fakeApi(); const st = qd.createRound({ players: ['a', 'b', 'c', 'd'] });
  qd.onStart(st, api);
  assert.equal(st.phase, 'ready');
  assert.equal(qd.onAction(st, 'a', { type: 'press' }, api).ok, true); // antes de GO
  assert.equal(st.presses.a.early, true);
  const [delay, goFn] = api.later_()[0]; assert.ok(delay >= 2000 && delay <= 6000); goFn();
  assert.equal(st.phase, 'go');
  api.tick(180); qd.onAction(st, 'b', { type: 'press', ms: 1 }, api); // el cliente no puede inventar ms
  api.tick(100); qd.onAction(st, 'c', { type: 'press' }, api);
  assert.equal(st.presses.b.ms, 180); assert.equal(st.presses.c.ms, 280);
  assert.equal(qd.onAction(st, 'z', { type: 'press' }, api).ok, false);
  const r = qd.resolve(st);
  assert.deepEqual(r.order, [['b'], ['c'], ['d'], ['a']]);
  assert.ok(r.dq.has('a'));
  // empate exacto
  const st2 = qd.createRound({ players: ['x', 'y'] }); qd.onStart(st2, api); st2.phase = 'go'; st2.goAt = api.now();
  qd.onAction(st2, 'x', { type: 'press' }, api); qd.onAction(st2, 'y', { type: 'press' }, api);
  assert.deepEqual(qd.resolve(st2).order, [['x', 'y']]);
});

test('Alto o Bajo: multiplicadores, empates, plantarse y límites', () => {
  assert.equal(hl.stepMult(1, 'lower'), null); assert.equal(hl.stepMult(13, 'higher'), null);
  assert.ok(hl.stepMult(7, 'higher') > 1 && hl.stepMult(2, 'higher') < hl.stepMult(12, 'higher'));
  const api = fakeApi(); const bets = { a: { amount: 100 } };
  const st = hl.createRound({ rngInt }); hl.init(st, bets);
  const h = st.hands.a;
  // forzamos la mano para probar cada rama
  let seq = [7, 7, 12];
  st.rngInt = (n) => (n === 13 ? seq.shift() - 1 : 0);
  h.card = { rank: 6, suit: '♠' };
  assert.equal(hl.onAction(st, 'a', { type: 'guess', dir: 'higher' }, api).ok, true); // 6 -> 7 gana
  assert.equal(h.guesses, 1); assert.ok(h.mult > 1);
  const m1 = h.mult;
  hl.onAction(st, 'a', { type: 'guess', dir: 'higher' }, api); // 7 -> 7 empate
  assert.equal(h.guesses, 1); assert.equal(h.mult, m1);
  hl.onAction(st, 'a', { type: 'guess', dir: 'higher' }, api); // 7 -> 12 gana
  assert.equal(h.guesses, 2);
  hl.onAction(st, 'a', { type: 'cashout' }, api);
  assert.equal(hl.onAction(st, 'a', { type: 'guess', dir: 'higher' }, api).ok, false, 'no se puede jugar después de plantarse');
  const out = hl.resolve(st, { bets }).outcomes.a;
  assert.equal(out.payout, Math.floor(100 * h.mult));
  // perder = 0
  const st2 = hl.createRound({ rngInt }); hl.init(st2, bets); st2.rngInt = () => 0; st2.hands.a.card = { rank: 6, suit: '♠' };
  hl.onAction(st2, 'a', { type: 'guess', dir: 'higher' }, api); // sale 1 -> pierde
  assert.equal(hl.resolve(st2, { bets }).outcomes.a.payout, 0);
  // sin jugar = devolución
  const st3 = hl.createRound({ rngInt }); hl.init(st3, bets);
  assert.equal(hl.resolve(st3, { bets }).outcomes.a.payout, 100);
});

test('Smash Cash: puntaje acotado, validación de golpes y combos', () => {
  const api = fakeApi(); const sched = smash.makeSchedule(rngInt);
  assert.equal(sched.length, 30);
  const st = smash.createRound({ players: ['a', 'b'], rngInt }); smash.onStart(st, api);
  const max = smash.maxScore(st.schedule);
  const t0 = st.schedule.find((t) => t.type === 'coin');
  api.tick(t0.t + 50);
  assert.equal(smash.onAction(st, 'a', { type: 'hit', id: t0.id }, api).ok, true);
  assert.equal(smash.onAction(st, 'a', { type: 'hit', id: t0.id }, api).ok, false, 'no se repite el golpe');
  assert.equal(smash.onAction(st, 'a', { type: 'hit', id: 999 }, api).ok, false);
  assert.equal(smash.onAction(st, 'a', { type: 'hit', id: -1 }, api).ok, false);
  assert.equal(smash.onAction(st, 'a', { type: 'hit', id: 1.5 }, api).ok, false);
  const far = st.schedule[st.schedule.length - 1];
  assert.equal(smash.onAction(st, 'a', { type: 'hit', id: far.id }, api).ok, false, 'fuera de su ventana de tiempo');
  assert.equal(smash.onAction(st, 'zzz', { type: 'hit', id: 0 }, api).ok, false);
  // un jugador perfecto no supera el máximo; jugador sin golpes = 0
  const perfect = Object.fromEntries(st.schedule.filter((t) => t.type !== 'trap').map((t) => [t.id, t.t]));
  assert.equal(smash.scoreFor(st.schedule, perfect).score, max);
  assert.ok(max < 30 * 300 * 3);
  assert.equal(smash.scoreFor(st.schedule, {}).score, 0);
  const trapSched = [{ id: 0, t: 0, type: 'coin', life: 1000 }, { id: 1, t: 500, type: 'trap', life: 1000 }, { id: 2, t: 1000, type: 'coin', life: 1000 }];
  const withTrap = smash.scoreFor(trapSched, { 0: 10, 1: 600, 2: 1100 });
  assert.equal(withTrap.score, 100 - 150 + 100 > 0 ? 50 : 0); // trampa resta y rompe el combo
  assert.equal(smash.scoreFor(trapSched, { 0: 10, 1: 600, 2: 1100 }).bestCombo, 1);
  const r = smash.resolve(st);
  assert.equal(r.order[0][0], 'a');
});

test('Cofres Malditos: contenido oculto hasta abrir, límites y pago', () => {
  const api = fakeApi(); const bets = { a: { amount: 100 } };
  const st = chests.createRound({ rngInt }); chests.init(st, bets);
  const priv = chests.privateState(st, 'a', 'playing');
  assert.equal(JSON.stringify(priv).includes('layout'), false);
  assert.equal(priv.reveal, undefined);
  assert.equal(JSON.stringify(chests.publicState(st)).includes('trap'), false);
  st.hands.a.layout = [{ type: 'small', f: 0.25 }, { type: 'mult', f: 1.4 }, { type: 'big', f: 1 }, { type: 'trap' }, { type: 'small', f: 0.25 }, { type: 'small', f: 0.25 }];
  chests.onAction(st, 'a', { type: 'open', index: 0 }, api);
  assert.equal(st.hands.a.value, 125);
  assert.equal(chests.onAction(st, 'a', { type: 'open', index: 0 }, api).ok, false);
  assert.equal(chests.onAction(st, 'a', { type: 'open', index: 9 }, api).ok, false);
  chests.onAction(st, 'a', { type: 'open', index: 1 }, api);
  assert.equal(st.hands.a.value, 175);
  chests.onAction(st, 'a', { type: 'cashout' }, api);
  assert.equal(chests.resolve(st, { bets }).outcomes.a.payout, 175);
  const st2 = chests.createRound({ rngInt }); chests.init(st2, bets);
  st2.hands.a.layout[2] = { type: 'trap' }; chests.onAction(st2, 'a', { type: 'open', index: 2 }, api);
  assert.equal(chests.resolve(st2, { bets }).outcomes.a.payout, 0);
  assert.equal(st2.hands.a.done, true);
  // 4 aperturas máximo
  const st3 = chests.createRound({ rngInt }); chests.init(st3, bets);
  st3.hands.a.layout = Array.from({ length: 6 }, () => ({ type: 'small', f: 0.25 }));
  for (let i = 0; i < 4; i++) chests.onAction(st3, 'a', { type: 'open', index: i }, api);
  assert.equal(chests.onAction(st3, 'a', { type: 'open', index: 4 }, api).ok, false);
});

test('Clasificación: monedas, luego rondas ganadas, luego empate declarado', () => {
  const s = computeStandings([{ id: 'a', balance: 500, roundWins: 1 }, { id: 'b', balance: 500, roundWins: 3 }, { id: 'c', balance: 900, roundWins: 0 }, { id: 'd', balance: 500, roundWins: 3 }]);
  assert.deepEqual(s.map((x) => [x.id, x.rank]), [['c', 1], ['b', 2], ['d', 2], ['a', 4]]);
  assert.equal(s.find((x) => x.id === 'b').tied, true); assert.equal(s.find((x) => x.id === 'c').tied, false);
});

test('Gemas: campeón, podio, participación; sin premio si abandona o no hubo rondas', () => {
  assert.equal(economy.gemReward({ rank: 1, tied: false, completedRounds: 5 }).gems, 45);
  assert.equal(economy.gemReward({ rank: 2, tied: false, completedRounds: 5 }).gems, 20);
  assert.equal(economy.gemReward({ rank: 5, tied: false, completedRounds: 5 }).gems, 5);
  assert.equal(economy.gemReward({ rank: 1, tied: true, completedRounds: 5 }).gems, 30);
  assert.equal(economy.gemReward({ rank: 1, completedRounds: 5, left: true }).gems, 0);
  assert.equal(economy.gemReward({ rank: 1, completedRounds: 0 }).gems, 0);
  assert.equal(economy.gemReward({ rank: 1, completedRounds: 3, aborted: true }).gems, 5, 'partida abortada: solo participación');
});

test('Seguridad: nombres, códigos y límite de frecuencia', () => {
  assert.equal(sanitizeName('  Ana   López '), 'Ana López');
  for (const bad of ['', 'a', '<script>', 'x'.repeat(17), 'Ana\u202Eevil', null, 5]) assert.equal(sanitizeName(bad), null, String(bad));
  assert.equal(sanitizeCode('ab-12'), 'AB12'); assert.equal(sanitizeCode('x'), null); assert.equal(sanitizeCode('A'.repeat(30)), null);
  const rl = new RateLimiter({ rate: 10, burst: 5 });
  let ok = 0; for (let i = 0; i < 20; i++) if (rl.take('k', 1, 1000)) ok++;
  assert.equal(ok, 5);
  assert.equal(rl.take('k', 1, 1000 + 1000), true);
});
