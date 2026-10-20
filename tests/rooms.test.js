'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, emit, sleep, waitFor } = require('./helpers');

test('crear sala, unirse por código, rechazar códigos incorrectos', async () => {
  const s = await startServer();
  try {
    const a = await client(s, { name: 'Ana' }); const b = await client(s, { name: 'Beto' });
    const cr = await emit(a, 'room:create');
    assert.equal(cr.ok, true); assert.match(cr.code, /^[A-HJ-NP-Z2-9]{4}$/);
    for (const bad of ['ZZZZ', '', 'x', 123, null, 'AB CD EF GH IJ']) assert.equal((await emit(b, 'room:join', { code: bad })).ok, false, String(bad));
    assert.equal((await emit(b, 'room:join', { code: cr.code.toLowerCase() })).ok, true, 'el código no distingue mayúsculas');
    await waitFor(() => a.snap?.players.length === 2 && b.snap?.players.length === 2);
    assert.equal(a.snap.hostId, a.id); assert.equal(b.snap.hostId, a.id);
    assert.deepEqual(a.snap.players.map((p) => p.name).sort(), ['Ana', 'Beto']);
    assert.equal((await emit(b, 'room:create')).ok, false, 'no se puede estar en dos salas');
    assert.equal((await emit(b, 'room:start')).ok, false, 'solo el anfitrión empieza');
    assert.equal((await emit(b, 'room:settings', { rounds: 10 })).ok, false, 'solo el anfitrión configura');
    assert.equal((await emit(a, 'room:start')).ok, true);
    const c = await client(s, { name: 'Caro' });
    assert.equal((await emit(c, 'room:join', { code: cr.code })).ok, false, 'no se entra con la partida en curso');
  } finally { await s.close(); }
});

test('límite de 8 jugadores y mínimo de 2 para empezar', async () => {
  const s = await startServer();
  try {
    const host = await client(s, { name: 'Host' });
    const { code } = await emit(host, 'room:create');
    assert.equal((await emit(host, 'room:start')).ok, false, 'un solo jugador no puede empezar');
    const cs = [];
    for (let i = 0; i < 7; i++) { const c = await client(s, { name: `Jug${i}` }); assert.equal((await emit(c, 'room:join', { code })).ok, true); cs.push(c); }
    const ninth = await client(s, { name: 'Novena' });
    const r = await emit(ninth, 'room:join', { code });
    assert.equal(r.ok, false); assert.match(r.error, /llena/);
    await waitFor(() => host.snap.players.length === 8);
  } finally { await s.close(); }
});

test('nombres: no se puede suplantar a otro jugador de la sala', async () => {
  const s = await startServer();
  try {
    const a = await client(s, { name: 'Ana' }); const b = await client(s, { name: 'Ana' });
    const { code } = await emit(a, 'room:create'); await emit(b, 'room:join', { code });
    await waitFor(() => a.snap.players.length === 2);
    const names = a.snap.players.map((p) => p.name);
    assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 2, `nombres únicos: ${names}`);
    const c = await client(s, { name: 'Beto' }); await emit(c, 'room:join', { code });
    assert.equal((await emit(c, 'profile:update', { name: 'ANA' })).ok, false, 'el cambio de nombre choca');
    assert.equal((await emit(c, 'profile:update', { name: '<img onerror=x>' })).ok, false);
    assert.equal((await emit(c, 'profile:update', { name: 'Ca ro' })).ok, true);
  } finally { await s.close(); }
});

test('configuración validada: rondas, apuestas, minijuegos', async () => {
  const s = await startServer();
  try {
    const a = await client(s, { name: 'Ana' }); await emit(a, 'room:create');
    assert.equal((await emit(a, 'room:settings', { rounds: 10, minBet: 50, maxBet: 400, games: ['roulette', 'high-low'] })).ok, true);
    assert.equal(a.snap.settings.rounds, 10); assert.deepEqual(a.snap.settings.games, ['roulette', 'high-low']);
    for (const bad of [{ rounds: 1 }, { rounds: 99 }, { rounds: 2.5 }, { rounds: '5' }, { minBet: 0 }, { minBet: 500, maxBet: 100 }, { games: [] }, { games: ['hackeo'] }, { games: 'roulette' }, { startBalance: 5 }]) {
      assert.equal((await emit(a, 'room:settings', bad)).ok, false, JSON.stringify(bad));
    }
    assert.equal(a.snap.settings.rounds, 10, 'una configuración inválida no cambia nada');
  } finally { await s.close(); }
});

test('aislamiento: cada sala solo recibe sus propios eventos', async () => {
  const s = await startServer();
  try {
    const a1 = await client(s, { name: 'A1' }); const a2 = await client(s, { name: 'A2' });
    const b1 = await client(s, { name: 'B1' }); const b2 = await client(s, { name: 'B2' });
    const ra = await emit(a1, 'room:create'); const rb = await emit(b1, 'room:create');
    await emit(a2, 'room:join', { code: ra.code }); await emit(b2, 'room:join', { code: rb.code });
    await waitFor(() => a1.snap.players.length === 2 && b1.snap.players.length === 2);
    assert.notEqual(ra.code, rb.code);
    assert.ok([a1, a2].every((c) => c.snap.code === ra.code) && [b1, b2].every((c) => c.snap.code === rb.code));
    assert.ok(!a1.snap.players.some((p) => p.name.startsWith('B')));
    b1.chat.length = 0; a1.chat.length = 0;
    await emit(a1, 'chat:quick', { id: 'q1' });
    await sleep(80);
    assert.equal(a2.chat.some((m) => m.kind === 'quick'), true);
    assert.equal(b1.chat.some((m) => m.kind === 'quick'), false); assert.equal(b2.chat.some((m) => m.kind === 'quick'), false);
    assert.equal((await emit(a1, 'room:start')).ok, true);
    await sleep(150);
    assert.equal(b1.snap.phase, 'lobby', 'la otra sala sigue en el lobby');
  } finally { await s.close(); }
});

test('chat: solo mensajes predefinidos, emotes propios y con límite de frecuencia', async () => {
  const s = await startServer();
  try {
    const a = await client(s, { name: 'Ana' }); await emit(a, 'room:create');
    assert.equal((await emit(a, 'chat:quick', { id: 'texto libre' })).ok, false);
    assert.equal((await emit(a, 'chat:quick', { id: 'q4' })).ok, true);
    assert.equal((await emit(a, 'chat:quick', { id: 'q4' })).ok, false, 'anti-spam');
    await sleep(1300);
    assert.equal((await emit(a, 'chat:emote', { id: 'emote-skull' })).ok, false, 'no tiene ese emote');
    assert.equal((await emit(a, 'chat:emote', { id: 'emote-gg' })).ok, true);
  } finally { await s.close(); }
});

test('sesión: token válido recupera el perfil; sin token no se hereda identidad ajena', async () => {
  const s = await startServer();
  try {
    const a = await client(s, { name: 'Ana' });
    const again = await client(s, { token: a.token });
    assert.equal(again.id, a.id);
    const imp = await client(s, { token: 'x'.repeat(43), name: 'Impostor' });
    assert.notEqual(imp.id, a.id);
    const raw = await new Promise((res) => { const io = require('socket.io-client').io(s.url, { transports: ['websocket'], forceNew: true }); io.on('connect', () => io.emit('room:create', {}, (r) => { io.close(); res(r); })); });
    assert.equal(raw.ok, false, 'sin auth:hello no se puede operar');
  } finally { await s.close(); }
});
