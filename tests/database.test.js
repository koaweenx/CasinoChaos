'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/database');

const mk = () => new Store(':memory:');
const matchFor = (id, over = {}) => ({ matchId: 'm1', roomCode: 'ABCD', startedAt: Date.now(), rounds: 5, aborted: false, results: [{ id, rank: 1, balance: 3500, startBalance: 1000, net: 2500, gems: 45, champion: true, left: false, roundsPlayed: 5, roundsWon: 3, jackpots: 1, biggestWin: 900, ...over }] });

test('perfil nuevo: saldos iniciales, token seguro y búsqueda por token', () => {
  const s = mk(); const { id, token } = s.createPlayer('Ana');
  assert.ok(token.length >= 40);
  assert.equal(s.findByToken(token), id);
  assert.equal(s.findByToken('x'.repeat(43)), null);
  assert.equal(s.findByToken(id), null, 'el id público no sirve como credencial');
  const p = s.getProfile(id);
  assert.equal(p.gems, 0); assert.equal(p.coins, 1000);
  assert.equal(p.equipped.avatar, 'avatar-robot');
  const raw = s.db.prepare('SELECT token_hash FROM players').get().token_hash;
  assert.notEqual(raw, token, 'el token no se guarda en claro');
});

test('tienda: sin gemas no compra; compra única; no se cobra dos veces', () => {
  const s = mk(); const { id } = s.createPlayer('Ana');
  assert.equal(s.buy(id, 'avatar-skull').ok, false);
  s.applyMatch(matchFor(id)); // 45 gemas + logros
  const gems0 = s.getProfile(id).gems;
  assert.ok(gems0 >= 45);
  assert.equal(s.buy(id, 'frame-neon').ok, true); // 50?
  const g1 = s.getProfile(id).gems;
  assert.equal(g1, gems0 - 50);
  assert.equal(s.buy(id, 'frame-neon').ok, false, 'compra repetida');
  assert.equal(s.getProfile(id).gems, g1);
  assert.equal(s.buy(id, 'no-existe').ok, false);
  assert.equal(s.buy(id, 'avatar-robot').ok, false, 'los gratuitos no se compran');
  assert.equal(s.equip(id, 'frame', 'frame-neon').ok, true);
  assert.equal(s.equip(id, 'frame', 'frame-gold').ok, false, 'no equipa lo que no tiene');
  assert.equal(s.equip(id, 'avatar', 'frame-neon').ok, false, 'categoría incorrecta');
  assert.equal(s.getProfile(id).equipped.frame, 'frame-neon');
});

test('premios de partida son idempotentes (no se duplican al reaplicar)', () => {
  const s = mk(); const { id } = s.createPlayer('Ana');
  const a = s.applyMatch(matchFor(id));
  const after1 = s.getProfile(id);
  const b = s.applyMatch(matchFor(id));
  const after2 = s.getProfile(id);
  assert.equal(a[id].applied, true); assert.equal(b[id].applied, false);
  assert.equal(after2.gems, after1.gems); assert.equal(after2.stats.gamesPlayed, 1); assert.equal(after2.stats.wins, 1);
  assert.equal(after2.coins, after1.coins);
  assert.ok(after1.achievements.includes('first_win') && after1.achievements.includes('jackpot') && after1.achievements.includes('golden_hands'));
  assert.equal(s.db.prepare("SELECT COUNT(*) c FROM ledger WHERE key LIKE 'match:m1:%gems'").get().c, 1);
});

test('monedas de perfil nunca bajan de 0 y la racha se reinicia', () => {
  const s = mk(); const { id } = s.createPlayer('Ana');
  s.applyMatch(matchFor(id));
  s.applyMatch({ ...matchFor(id, { rank: 3, net: -999999, gems: 8, champion: false, jackpots: 0, balance: 10 }), matchId: 'm2' });
  const p = s.getProfile(id);
  assert.equal(p.coins, 0); assert.equal(p.stats.winStreak, 0); assert.equal(p.stats.bestStreak, 1); assert.equal(p.stats.bestRank, 1);
});

test('persistencia: los datos sobreviven a reiniciar el servidor', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')), 'test.db');
  let s = new Store(file); const { id, token } = s.createPlayer('Ana');
  s.applyMatch(matchFor(id)); s.buy(id, 'avatar-ghost'); s.equip(id, 'avatar', 'avatar-ghost'); s.setName(id, 'Ana2');
  const before = s.getProfile(id); s.close();
  s = new Store(file);
  assert.equal(s.findByToken(token), id);
  const after = s.getProfile(id);
  assert.deepEqual(after, before);
  assert.equal(after.equipped.avatar, 'avatar-ghost'); assert.ok(after.owned.includes('avatar-ghost')); assert.equal(after.name, 'Ana2');
  s.close();
});

test('SQL parametrizado: un nombre malicioso no rompe nada', () => {
  const s = mk(); const { id } = s.createPlayer("x'); DROP TABLE players;--");
  assert.equal(s.getProfile(id).name, "x'); DROP TABLE players;--");
  assert.ok(s.db.prepare('SELECT COUNT(*) c FROM players').get().c === 1);
});
