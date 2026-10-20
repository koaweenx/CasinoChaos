'use strict';
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const { newToken, hashToken, newId } = require('./security');
const { ITEM_MAP, DEFAULT_EQUIPPED, isFree } = require('./catalog');
const { ACHIEVEMENTS } = require('./economy');

const START_COINS = 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  coins INTEGER NOT NULL DEFAULT ${START_COINS} CHECK (coins >= 0),
  gems INTEGER NOT NULL DEFAULT 0 CHECK (gems >= 0),
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  best_rank INTEGER,
  win_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  rounds_played INTEGER NOT NULL DEFAULT 0,
  rounds_won INTEGER NOT NULL DEFAULT 0,
  jackpots INTEGER NOT NULL DEFAULT 0,
  biggest_win INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inventory (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, item_id)
);
CREATE TABLE IF NOT EXISTS equipped (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (player_id, category)
);
CREATE TABLE IF NOT EXISTS ledger (
  key TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency IN ('coins','gems')),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  players INTEGER NOT NULL,
  rounds INTEGER NOT NULL,
  aborted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  final_rank INTEGER NOT NULL,
  final_balance INTEGER NOT NULL,
  net INTEGER NOT NULL,
  gems_awarded INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
CREATE TABLE IF NOT EXISTS achievements (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, key)
);
`;

class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.q = {
      byToken: this.db.prepare('SELECT id FROM players WHERE token_hash = ?'),
      byId: this.db.prepare('SELECT * FROM players WHERE id = ?'),
      insPlayer: this.db.prepare('INSERT INTO players (id, token_hash, name, created_at) VALUES (?,?,?,?)'),
      setName: this.db.prepare('UPDATE players SET name = ? WHERE id = ?'),
      owned: this.db.prepare('SELECT item_id FROM inventory WHERE player_id = ?'),
      hasItem: this.db.prepare('SELECT 1 FROM inventory WHERE player_id = ? AND item_id = ?'),
      insItem: this.db.prepare('INSERT INTO inventory (player_id, item_id, acquired_at) VALUES (?,?,?)'),
      equipped: this.db.prepare('SELECT category, item_id FROM equipped WHERE player_id = ?'),
      setEquip: this.db.prepare('INSERT INTO equipped (player_id, category, item_id) VALUES (?,?,?) ON CONFLICT(player_id, category) DO UPDATE SET item_id = excluded.item_id'),
      ledger: this.db.prepare('INSERT OR IGNORE INTO ledger (key, player_id, currency, amount, reason, created_at) VALUES (?,?,?,?,?,?)'),
      addGems: this.db.prepare('UPDATE players SET gems = gems + ? WHERE id = ?'),
      addCoins: this.db.prepare('UPDATE players SET coins = MAX(0, coins + ?) WHERE id = ?'),
      achievements: this.db.prepare('SELECT key FROM achievements WHERE player_id = ?'),
      insAch: this.db.prepare('INSERT OR IGNORE INTO achievements (player_id, key, unlocked_at) VALUES (?,?,?)'),
      insMatch: this.db.prepare('INSERT OR IGNORE INTO matches (id, room_code, started_at, ended_at, players, rounds, aborted) VALUES (?,?,?,?,?,?,?)'),
      insMP: this.db.prepare('INSERT OR IGNORE INTO match_players (match_id, player_id, final_rank, final_balance, net, gems_awarded) VALUES (?,?,?,?,?,?)'),
      history: this.db.prepare(`SELECT m.ended_at, m.room_code, mp.final_rank, mp.final_balance, mp.net, mp.gems_awarded, m.players
        FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.player_id = ? ORDER BY m.ended_at DESC LIMIT 10`),
      stats: this.db.prepare(`UPDATE players SET games_played = games_played + 1, wins = wins + ?, best_rank = CASE WHEN best_rank IS NULL OR ? < best_rank THEN ? ELSE best_rank END,
        win_streak = ?, best_streak = MAX(best_streak, ?), rounds_played = rounds_played + ?, rounds_won = rounds_won + ?,
        jackpots = jackpots + ?, biggest_win = MAX(biggest_win, ?) WHERE id = ?`),
    };
  }

  close() { this.db.close(); }

  createPlayer(name) {
    const id = newId(); const token = newToken();
    this.q.insPlayer.run(id, hashToken(token), name, Date.now());
    return { id, token };
  }

  findByToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 80) return null;
    const r = this.q.byToken.get(hashToken(token));
    return r ? r.id : null;
  }

  getProfile(id) {
    const p = this.q.byId.get(id);
    if (!p) return null;
    const equipped = { ...DEFAULT_EQUIPPED };
    for (const r of this.q.equipped.all(id)) equipped[r.category] = r.item_id;
    return {
      id: p.id, name: p.name, coins: p.coins, gems: p.gems,
      stats: {
        gamesPlayed: p.games_played, wins: p.wins, bestRank: p.best_rank, winStreak: p.win_streak,
        bestStreak: p.best_streak, roundsPlayed: p.rounds_played, roundsWon: p.rounds_won,
        jackpots: p.jackpots, biggestWin: p.biggest_win,
      },
      owned: this.q.owned.all(id).map((r) => r.item_id),
      equipped,
      achievements: this.q.achievements.all(id).map((r) => r.key),
      history: this.q.history.all(id),
    };
  }

  /** Cosméticos equipados que se muestran a otros jugadores (solo datos públicos). */
  getPublicLook(id) {
    const p = this.getProfile(id);
    return p ? { name: p.name, equipped: p.equipped, owned: p.owned } : null;
  }

  setName(id, name) { this.q.setName.run(name, id); }

  owns(id, itemId) { return isFree(itemId) || !!this.q.hasItem.get(id, itemId); }

  /** Compra atómica e idempotente: la clave del libro mayor impide cobrar dos veces. */
  buy(id, itemId) {
    const item = ITEM_MAP.get(itemId);
    if (!item) return { ok: false, error: 'Artículo inexistente' };
    if (item.price === 0) return { ok: false, error: 'Este artículo ya es tuyo' };
    const tx = this.db.transaction(() => {
      const p = this.q.byId.get(id);
      if (!p) return { ok: false, error: 'Jugador inexistente' };
      if (this.q.hasItem.get(id, itemId)) return { ok: false, error: 'Ya tenés este artículo' };
      if (p.gems < item.price) return { ok: false, error: 'No tenés gemas suficientes' };
      const ins = this.q.ledger.run(`buy:${id}:${itemId}`, id, 'gems', -item.price, `Compra ${itemId}`, Date.now());
      if (ins.changes !== 1) return { ok: false, error: 'Ya tenés este artículo' };
      this.q.addGems.run(-item.price, id);
      this.q.insItem.run(id, itemId, Date.now());
      return { ok: true };
    });
    return tx();
  }

  equip(id, category, itemId) {
    const item = ITEM_MAP.get(itemId);
    if (!item || item.cat !== category) return { ok: false, error: 'Artículo inválido' };
    if (!this.owns(id, itemId)) return { ok: false, error: 'Todavía no desbloqueaste este artículo' };
    this.q.setEquip.run(id, category, itemId);
    return { ok: true };
  }

  /**
   * Guarda el resultado de una partida. Idempotente por (matchId, jugador): si se llama dos veces
   * (reconexión, refresco) las gemas y estadísticas NO se aplican de nuevo.
   */
  applyMatch(m) {
    const tx = this.db.transaction(() => {
      this.q.insMatch.run(m.matchId, m.roomCode, m.startedAt, Date.now(), m.results.length, m.rounds, m.aborted ? 1 : 0);
      const out = {};
      for (const r of m.results) {
        const first = this.q.insMP.run(m.matchId, r.id, r.rank, r.balance, r.net, r.gems).changes === 1;
        if (!first) { out[r.id] = { applied: false, achievements: [] }; continue; }
        const key = `match:${m.matchId}:${r.id}`;
        if (r.gems > 0) { this.q.ledger.run(`${key}:gems`, r.id, 'gems', r.gems, 'Premio de partida', Date.now()); this.q.addGems.run(r.gems, r.id); }
        if (r.net !== 0) { this.q.ledger.run(`${key}:coins`, r.id, 'coins', r.net, 'Resultado de partida', Date.now()); this.q.addCoins.run(r.net, r.id); }
        const cur = this.q.byId.get(r.id);
        const won = r.champion ? 1 : 0;
        const streak = r.left ? 0 : (r.champion ? cur.win_streak + 1 : 0);
        this.q.stats.run(won, r.rank, r.rank, streak, streak, r.roundsPlayed, r.roundsWon, r.jackpots, r.biggestWin, r.id);
        const earned = [];
        const have = new Set(this.q.achievements.all(r.id).map((a) => a.key));
        const grant = (k) => {
          if (have.has(k)) return;
          if (this.q.insAch.run(r.id, k, Date.now()).changes !== 1) return;
          const a = ACHIEVEMENTS[k];
          this.q.ledger.run(`ach:${r.id}:${k}`, r.id, 'gems', a.gems, `Logro ${k}`, Date.now());
          this.q.addGems.run(a.gems, r.id);
          earned.push({ key: k, label: a.label, gems: a.gems });
        };
        if (r.champion) grant('first_win');
        if (r.jackpots > 0) grant('jackpot');
        if (cur.games_played + 1 >= 10) grant('games_10');
        if (!r.left && r.balance >= r.startBalance * 3) grant('golden_hands');
        out[r.id] = { applied: true, achievements: earned };
      }
      return out;
    });
    return tx();
  }
}

module.exports = { Store, START_COINS };
