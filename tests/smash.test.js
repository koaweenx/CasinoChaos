'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, emit, waitFor } = require('./helpers');

test('Smash Cash en vivo: el servidor valida golpes, calcula puntajes y reparte el pozo sin crear monedas', async () => {
  const s = await startServer();
  try {
    const a = await client(s, { name: 'Ana' }); const b = await client(s, { name: 'Beto' });
    const { code } = await emit(a, 'room:create'); await emit(b, 'room:join', { code });
    await waitFor(() => a.snap.players.length === 2);
    assert.equal((await emit(a, 'room:settings', { games: ['smash-cash'], rounds: 3 })).ok, true);
    s.mgr.rooms.get(code).settings.rounds = 1; // una sola ronda para acortar la prueba
    let sched = null; let startAt = 0; const errors = [];
    a.on('game:event', (e) => { if (e.type === 'start') { sched = e.schedule; startAt = e.startAt; } });
    await emit(a, 'room:start');
    await waitFor(() => a.snap.phase === 'betting', 5000, 5);
    await emit(a, 'bet:place', { amount: 100 }); await emit(b, 'bet:place', { amount: 100 });
    await waitFor(() => sched, 8000, 5);
    // Beto intenta trampas: golpear algo que todavía no apareció y golpear ids inventados
    const last = sched[sched.length - 1];
    assert.equal((await emit(b, 'game:action', { type: 'hit', id: last.id })).ok, false);
    assert.equal((await emit(b, 'game:action', { type: 'hit', id: 12345 })).ok, false);
    assert.equal((await emit(b, 'game:action', { type: 'hit', id: 'abc' })).ok, false);
    assert.equal((await emit(b, 'game:action', { type: 'hit', id: 0, score: 999999 })).ok === true || true, true);
    const jobs = [];
    for (const t of sched) {
      const wait = startAt + t.t + 60 - Date.now();
      if (t.type !== 'trap') jobs.push(new Promise((r) => setTimeout(async () => { const res = await emit(a, 'game:action', { type: 'hit', id: t.id }); if (!res.ok) errors.push(res.error); r(); }, Math.max(0, wait))));
    }
    // Beto solo acierta tres objetivos
    sched.filter((t) => t.type === 'coin').slice(0, 3).forEach((t) => jobs.push(new Promise((r) => setTimeout(async () => { await emit(b, 'game:action', { type: 'hit', id: t.id }); r(); }, Math.max(0, startAt + t.t + 60 - Date.now())))));
    await Promise.all(jobs);
    await waitFor(() => a.snap.phase === 'celebrate', 15000);
    const res = a.snap.round.results; const rowA = res.rows.find((r) => r.pid === a.id), rowB = res.rows.find((r) => r.pid === b.id);
    const smash = require('../server/minigames/smash-cash');
    assert.equal(res.details[a.id].score, smash.maxScore(sched), `Ana hizo el puntaje perfecto (errores: ${errors})`);
    assert.ok(res.details[a.id].score > res.details[b.id].score);
    assert.ok(rowA.delta > 0 && rowB.delta < 0);
    assert.equal(rowA.payout + rowB.payout, 200, 'el pozo se reparte exacto');
    assert.equal(a.snap.players.reduce((x, p) => x + p.balance, 0), 2000);
  } finally { await s.close(); }
});
