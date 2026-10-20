'use strict';
const crypto = require('node:crypto');
const { byId: gameById, games: allGames, meta: gameMeta } = require('./minigames');
const economy = require('./economy');
const { computeStandings } = require('./ranking');
const { newRoomCode, nameKey } = require('./security');

const MAX_PLAYERS = 8, MIN_PLAYERS = 2;
const DEFAULT_SETTINGS = () => ({ rounds: 5, games: allGames.map((g) => g.id), minBet: 20, maxBet: 250, startBalance: 1000 });
const T = { announce: 4200, betting: 13000, countdown: 3200, celebrate: 6500, noBets: 2200, lobbyGrace: 30000, gameGrace: 90000, hostGrace: 15000, emptyRoom: 120000 };
const QUICK = {
  q1: '¿Eso era tu mejor jugada?', q2: 'La suerte está de mi lado', q3: 'Te estoy esperando en el podio',
  q4: 'Casi, casi', q5: 'El rey llegó', q6: 'Revancha o miedo',
};

class Room {
  constructor(mgr, code, hostId) {
    this.mgr = mgr; this.code = code; this.hostId = hostId;
    this.players = new Map();
    this.settings = DEFAULT_SETTINGS();
    this.phase = 'lobby'; this.phaseEndsAt = null;
    this.timers = new Set(); this.grace = new Map(); this.emptyTimer = null;
    this.round = null; this.roundNo = -1; this.schedule = []; this.completedRounds = 0;
    this.matchId = null; this.startedAt = null; this.finalInfo = null; this.lastResults = null;
    this.destroyed = false; this.lastChat = new Map();
  }

  get io() { return this.mgr.io; }
  get store() { return this.mgr.store; }
  get rngInt() { return this.mgr.rngInt; }
  dur(ms) { return this.mgr.fast ? Math.max(40, Math.round(ms * 0.02)) : ms; }

  // ---------- timers ----------
  later(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.destroyed) fn(); }, ms);
    t.unref?.(); this.timers.add(t); return t;
  }
  clearTimers() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
  setPhase(name, ms) { this.clearTimers(); this.phase = name; this.phaseEndsAt = ms ? Date.now() + ms : null; }

  // ---------- players ----------
  active() { return [...this.players.values()].filter((p) => !p.left); }
  activeIds() { return this.active().map((p) => p.id); }
  connectedActive() { return this.active().filter((p) => p.connected); }

  lookOf(pid) {
    const prof = this.store.getProfile(pid);
    return { name: prof.name, equipped: prof.equipped };
  }
  uniqueName(base, exceptId) {
    const taken = new Set([...this.players.values()].filter((p) => p.id !== exceptId).map((p) => nameKey(p.name)));
    let name = base, n = 2;
    while (taken.has(nameKey(name))) name = `${base} ${n++}`;
    return name;
  }

  addPlayer(pid, socket) {
    const look = this.lookOf(pid);
    const p = {
      id: pid, name: this.uniqueName(look.name, pid), look: look.equipped, socketId: socket.id, connected: true, left: false,
      joinedAt: Date.now(), balance: this.settings.startBalance, roundWins: 0, prevRank: null, bailouts: 0, bailTotal: 0, halfRtt: 40,
      stats: { coinsWon: 0, coinsLost: 0, roundsPlayed: 0, biggestWin: 0, jackpots: 0 },
    };
    this.players.set(pid, p);
    socket.join(this.code);
    this.cancelEmpty();
    this.emitChat({ kind: 'entry', pid, fx: p.look.entry });
    this.broadcast();
    this.sendPrivate(pid);
    return p;
  }

  refreshLook(pid) {
    const p = this.players.get(pid); if (!p) return;
    const look = this.lookOf(pid);
    p.look = look.equipped;
    p.name = this.uniqueName(look.name, pid);
    this.broadcast();
  }

  reconnect(pid, socket) {
    const p = this.players.get(pid); if (!p || p.left) return false;
    clearTimeout(this.grace.get(pid)); this.grace.delete(pid);
    p.connected = true; p.socketId = socket.id;
    if (!this.hostId) this.hostId = pid;
    socket.join(this.code);
    this.cancelEmpty();
    this.emitChat({ kind: 'system', text: `${p.name} volvió a la sala` });
    this.broadcast(); this.sendPrivate(pid);
    return true;
  }

  disconnect(pid) {
    const p = this.players.get(pid); if (!p || p.left) return;
    p.connected = false; p.socketId = null;
    this.emitChat({ kind: 'system', text: `${p.name} perdió la conexión` });
    const ingame = !['lobby', 'final'].includes(this.phase);
    const t = setTimeout(() => {
      this.grace.delete(pid);
      if (p.connected) return;
      this.removePlayer(pid, 'timeout');
    }, ingame ? T.gameGrace : T.lobbyGrace);
    t.unref?.(); this.grace.set(pid, t);
    if (pid === this.hostId) {
      clearTimeout(this.hostTimer);
      this.hostTimer = setTimeout(() => { if (this.hostId === pid && !this.players.get(pid)?.connected) this.transferHost(); }, T.hostGrace);
      this.hostTimer.unref?.();
    }
    this.checkEmpty();
    this.broadcast();
    if (this.phase === 'betting') this.checkAllDecided();
  }

  transferHost() {
    const next = this.connectedActive().sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!next) return;
    this.hostId = next.id;
    this.emitChat({ kind: 'system', text: `${next.name} es el nuevo anfitrión` });
    this.broadcast();
  }

  removePlayer(pid, reason = 'leave') {
    const p = this.players.get(pid); if (!p) return;
    clearTimeout(this.grace.get(pid)); this.grace.delete(pid);
    const sock = p.socketId && this.io.sockets.sockets.get(p.socketId);
    sock?.leave(this.code);
    this.mgr.byPlayer.delete(pid);
    const inGame = !['lobby', 'final'].includes(this.phase);
    if (inGame) { p.left = true; p.connected = false; p.socketId = null; } else this.players.delete(pid);
    this.emitChat({ kind: 'system', text: `${p.name} ${reason === 'timeout' ? 'se desconectó' : 'salió de la sala'}` });
    if (pid === this.hostId) { this.hostId = null; this.transferHost(); }
    if (this.active().length === 0 || (!inGame && this.players.size === 0)) { this.destroy(); return; }
    this.checkEmpty();
    this.broadcast();
    if (this.phase === 'betting') this.checkAllDecided();
  }

  checkEmpty() {
    if (this.connectedActive().length === 0 && !this.emptyTimer) {
      this.emptyTimer = setTimeout(() => this.destroy(), T.emptyRoom); this.emptyTimer.unref?.();
    }
  }
  cancelEmpty() { clearTimeout(this.emptyTimer); this.emptyTimer = null; }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.clearTimers(); this.cancelEmpty(); clearTimeout(this.hostTimer);
    for (const t of this.grace.values()) clearTimeout(t);
    for (const p of this.players.values()) this.mgr.byPlayer.delete(p.id);
    this.io.to(this.code).emit('room:closed', {});
    this.io.in(this.code).socketsLeave(this.code);
    this.mgr.rooms.delete(this.code);
  }

  // ---------- configuración ----------
  updateSettings(pid, s) {
    if (pid !== this.hostId) return { ok: false, error: 'Solo el anfitrión puede cambiar la configuración' };
    if (this.phase !== 'lobby') return { ok: false, error: 'La partida ya empezó' };
    const next = { ...this.settings };
    const int = (v) => Number.isSafeInteger(v) ? v : null;
    if (s.rounds !== undefined) { const v = int(s.rounds); if (v === null || v < 3 || v > 20) return { ok: false, error: 'Rondas: entre 3 y 20' }; next.rounds = v; }
    if (s.startBalance !== undefined) { const v = int(s.startBalance); if (v === null || v < 100 || v > 100000) return { ok: false, error: 'Saldo inicial: 100 a 100000' }; next.startBalance = v; }
    if (s.minBet !== undefined) { const v = int(s.minBet); if (v === null || v < 1 || v > 100000) return { ok: false, error: 'Apuesta mínima inválida' }; next.minBet = v; }
    if (s.maxBet !== undefined) { const v = int(s.maxBet); if (v === null || v < 1 || v > 100000) return { ok: false, error: 'Apuesta máxima inválida' }; next.maxBet = v; }
    if (s.games !== undefined) {
      if (!Array.isArray(s.games) || s.games.length < 1 || s.games.length > 6 || !s.games.every((g) => gameById.has(g))) return { ok: false, error: 'Elegí al menos un minijuego válido' };
      next.games = [...new Set(s.games)];
    }
    if (next.maxBet < next.minBet) return { ok: false, error: 'La apuesta máxima debe ser mayor o igual a la mínima' };
    if (next.minBet > next.startBalance) return { ok: false, error: 'La apuesta mínima supera el saldo inicial' };
    this.settings = next;
    this.broadcast();
    return { ok: true };
  }

  buildSchedule(n, games) {
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = this.rngInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const out = []; let bag = []; let last = null;
    while (out.length < n) {
      if (!bag.length) {
        bag = shuffle([...games]);
        if (bag.length > 1 && bag[0] === last) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      }
      last = bag.shift(); out.push(last);
    }
    return out;
  }

  resetMatchState() {
    for (const [id, p] of [...this.players]) if (p.left) this.players.delete(id);
    for (const p of this.players.values()) {
      p.balance = this.settings.startBalance; p.roundWins = 0; p.prevRank = null; p.bailouts = 0; p.bailTotal = 0;
      p.stats = { coinsWon: 0, coinsLost: 0, roundsPlayed: 0, biggestWin: 0, jackpots: 0 };
    }
    this.round = null; this.roundNo = -1; this.completedRounds = 0; this.finalInfo = null; this.lastResults = null; this.matchId = null;
  }

  start(pid) {
    if (pid !== this.hostId) return { ok: false, error: 'Solo el anfitrión puede empezar' };
    if (!['lobby', 'final'].includes(this.phase)) return { ok: false, error: 'La partida ya empezó' };
    if (this.phase === 'final') this.resetMatchState();
    if (this.connectedActive().length < MIN_PLAYERS) return { ok: false, error: 'Se necesitan al menos 2 jugadores conectados' };
    this.resetMatchState();
    this.matchId = crypto.randomUUID(); this.startedAt = Date.now();
    this.schedule = this.buildSchedule(this.settings.rounds, this.settings.games);
    this.emitChat({ kind: 'system', text: '¡Empieza la partida!' });
    this.nextRound();
    return { ok: true };
  }

  backToLobby(pid) {
    if (pid !== this.hostId) return { ok: false, error: 'Solo el anfitrión puede volver al lobby' };
    if (this.phase !== 'final') return { ok: false, error: 'La partida no terminó' };
    this.resetMatchState(); this.setPhase('lobby', 0);
    this.broadcast(); this.sendPrivateAll();
    return { ok: true };
  }

  // ---------- flujo de rondas ----------
  nextRound() {
    if (this.destroyed || this.finalInfo) return;
    const idx = this.roundNo + 1;
    if (idx >= this.settings.rounds) return this.finish(false);
    if (this.active().length < MIN_PLAYERS) return this.finish(true);
    this.roundNo = idx;
    const gameId = this.schedule[idx];
    this.round = { index: idx, gameId, bets: {}, decided: new Set(), state: null, settled: false, playEnded: false, noBets: false };
    const { minBet, startBalance } = this.settings;
    for (const p of this.active()) {
      if (p.balance < minBet) {
        if (p.bailouts < 1) {
          const amount = Math.max(minBet * 2, Math.round(startBalance * 0.1));
          p.balance += amount; p.bailouts++; p.bailTotal += amount;
          this.emitChat({ kind: 'system', text: `El casino le prestó ${amount} monedas a ${p.name}` });
        } else this.round.decided.add(p.id);
      }
    }
    this.setPhase('announce', this.dur(T.announce));
    this.broadcast(); this.sendPrivateAll();
    this.later(this.dur(T.announce), () => this.startBetting());
  }

  startBetting() {
    if (this.phase !== 'announce') return;
    this.setPhase('betting', this.dur(T.betting));
    this.later(this.dur(T.betting), () => this.lockBets());
    this.broadcast();
    this.checkAllDecided();
  }

  eligible(p) { return !p.left && p.connected && p.balance >= this.settings.minBet; }

  checkAllDecided() {
    if (this.phase !== 'betting') return;
    const waiting = this.active().filter((p) => this.eligible(p) && !this.round.decided.has(p.id));
    if (waiting.length === 0) this.lockBets();
  }

  placeBet(pid, amount, choice) {
    const p = this.players.get(pid);
    if (!p || p.left) return { ok: false, error: 'No estás en la partida' };
    if (this.phase !== 'betting') return { ok: false, error: 'Las apuestas están cerradas' };
    const game = gameById.get(this.round.gameId);
    const v = economy.clampBet(amount, { minBet: this.settings.minBet, maxBet: this.settings.maxBet, balance: p.balance });
    if (!v.ok) return v;
    if (game.needsChoice && !game.needsChoice.includes(choice)) return { ok: false, error: 'Elegí una opción para apostar' };
    this.round.bets[pid] = { amount, choice: game.needsChoice ? choice : null };
    this.round.decided.add(pid);
    this.broadcast(); this.sendPrivate(pid);
    this.checkAllDecided();
    return { ok: true };
  }

  skipBet(pid) {
    const p = this.players.get(pid);
    if (!p || p.left) return { ok: false, error: 'No estás en la partida' };
    if (this.phase !== 'betting') return { ok: false, error: 'Las apuestas están cerradas' };
    delete this.round.bets[pid]; this.round.decided.add(pid);
    this.broadcast(); this.sendPrivate(pid);
    this.checkAllDecided();
    return { ok: true };
  }

  lockBets() {
    if (this.phase !== 'betting') return;
    const r = this.round; const game = gameById.get(r.gameId);
    for (const [pid, b] of Object.entries(r.bets)) {
      const p = this.players.get(pid);
      if (!p || p.left || b.amount > p.balance) { delete r.bets[pid]; continue; }
      p.balance -= b.amount; // la apuesta queda en custodia del servidor
    }
    if (Object.keys(r.bets).length === 0) {
      r.noBets = true; r.settled = true;
      this.lastResults = { gameId: r.gameId, rows: [], details: {}, noBets: true };
      this.setPhase('celebrate', this.dur(T.noBets));
      this.broadcast(); this.sendPrivateAll();
      this.later(this.dur(T.noBets), () => this.nextRound());
      return;
    }
    r.state = game.createRound({ players: this.activeIds(), bets: r.bets, rngInt: this.rngInt });
    game.init?.(r.state, r.bets);
    this.setPhase('countdown', this.dur(T.countdown));
    this.broadcast(); this.sendPrivateAll();
    this.later(this.dur(T.countdown), () => this.startPlay());
  }

  makeApi(game) {
    const room = this;
    return {
      now: () => Date.now(), rngInt: this.rngInt, scale: (ms) => room.dur(ms),
      later: (ms, fn) => room.later(ms, () => { if (room.phase === 'playing') fn(); }),
      emit: (type, data) => room.io.to(room.code).emit('game:event', { type, gameId: game.id, round: room.round.index, ...data }),
      finish: () => room.finishPlay(),
      halfRtt: (pid) => room.players.get(pid)?.halfRtt ?? 0,
    };
  }

  startPlay() {
    if (this.phase !== 'countdown') return;
    const r = this.round; const game = gameById.get(r.gameId);
    this.setPhase('playing', game.playMs);
    game.onStart(r.state, this.makeApi(game));
    this.later(game.playMs, () => this.finishPlay());
    this.broadcast(); this.sendPrivateAll();
  }

  action(pid, a) {
    const p = this.players.get(pid);
    if (!p || p.left) return { ok: false, error: 'No estás en la partida' };
    if (this.phase !== 'playing') return { ok: false, error: 'No es momento de jugar' };
    const r = this.round; const game = gameById.get(r.gameId);
    const res = game.onAction(r.state, pid, a, this.makeApi(game));
    if (res.ok) { this.sendPrivate(pid); if (this.phase === 'playing') this.broadcastLight(); }
    return res;
  }

  finishPlay() {
    if (this.phase !== 'playing' || this.round.playEnded) return;
    const r = this.round; const game = gameById.get(r.gameId);
    r.playEnded = true;
    const ms = this.dur(game.revealMs ?? 1500);
    this.setPhase('resolving', ms);
    this.broadcast(); this.sendPrivateAll();
    this.later(ms, () => this.settle());
  }

  settle() {
    const r = this.round;
    if (!r || r.settled) return; // jamás se resuelve una ronda dos veces
    r.settled = true;
    const game = gameById.get(r.gameId);
    const before = new Map(computeStandings(this.active()).map((s) => [s.id, s.rank]));
    for (const p of this.players.values()) p.prevRank = before.get(p.id) ?? null;
    const res = game.resolve(r.state, { bets: r.bets, rngInt: this.rngInt });
    const payouts = {}; const details = {}; let jackpots = {};
    if (game.mode === 'house') {
      for (const pid of Object.keys(r.bets)) { payouts[pid] = Math.max(0, res.outcomes[pid].payout); details[pid] = res.outcomes[pid].detail; if (res.outcomes[pid].jackpot) jackpots[pid] = true; }
    } else {
      const amounts = Object.fromEntries(Object.entries(r.bets).map(([k, b]) => [k, b.amount]));
      Object.assign(payouts, economy.distributePot(amounts, res.order, res.dq));
      Object.assign(details, res.details);
    }
    const rows = []; let maxDelta = 0;
    for (const [pid, b] of Object.entries(r.bets)) {
      const p = this.players.get(pid);
      const delta = payouts[pid] - b.amount;
      p.balance += payouts[pid];
      p.stats.roundsPlayed++;
      if (delta > 0) p.stats.coinsWon += delta; else p.stats.coinsLost += -delta;
      p.stats.biggestWin = Math.max(p.stats.biggestWin, delta);
      if (jackpots[pid]) p.stats.jackpots++;
      maxDelta = Math.max(maxDelta, delta);
      rows.push({ pid, bet: b.amount, choice: b.choice, payout: payouts[pid], delta, detail: details[pid] ?? null, jackpot: !!jackpots[pid] });
    }
    if (maxDelta > 0) for (const row of rows) if (row.delta === maxDelta) this.players.get(row.pid).roundWins++;
    this.completedRounds++;
    this.lastResults = { gameId: r.gameId, rows, details, order: res.order ?? null, noBets: false };
    this.setPhase('celebrate', this.dur(T.celebrate));
    this.broadcast(); this.sendPrivateAll();
    this.later(this.dur(T.celebrate), () => this.nextRound());
  }

  finish(aborted) {
    if (this.finalInfo) return; // los premios se entregan una sola vez
    this.clearTimers();
    const standings = this.standings();
    const byId = new Map(standings.map((s) => [s.id, s]));
    const rows = [];
    for (const p of this.players.values()) {
      const s = byId.get(p.id);
      const reward = economy.gemReward({ rank: s.rank, tied: s.tied, completedRounds: this.completedRounds, aborted, left: p.left });
      rows.push({
        id: p.id, rank: s.rank, tied: s.tied, balance: p.balance, startBalance: this.settings.startBalance,
        net: p.balance - this.settings.startBalance - p.bailTotal, gems: reward.gems, parts: reward.parts,
        champion: s.rank === 1 && !p.left && !aborted && this.completedRounds >= 1, left: p.left,
        roundsPlayed: p.stats.roundsPlayed, roundsWon: p.roundWins, jackpots: p.stats.jackpots, biggestWin: p.stats.biggestWin,
      });
    }
    const saved = this.store.applyMatch({ matchId: this.matchId, roomCode: this.code, startedAt: this.startedAt, rounds: this.completedRounds, aborted, results: rows });
    this.finalInfo = {
      aborted, rounds: this.completedRounds,
      standings: rows.map((r) => ({
        id: r.id, rank: r.rank, tied: r.tied, balance: r.balance, net: r.net, gems: r.gems, parts: r.parts, champion: r.champion, left: r.left,
        roundWins: r.roundsWon, coinsWon: this.players.get(r.id).stats.coinsWon, coinsLost: this.players.get(r.id).stats.coinsLost,
        biggestWin: r.biggestWin, jackpots: r.jackpots, achievements: saved[r.id]?.achievements ?? [],
      })).sort((a, b) => a.rank - b.rank),
    };
    this.setPhase('final', 0);
    this.broadcast(); this.sendPrivateAll();
    for (const p of this.players.values()) if (p.socketId) this.io.to(p.socketId).emit('profile:changed', { profile: this.store.getProfile(p.id) });
  }

  // ---------- chat ----------
  quick(pid, id) {
    const p = this.players.get(pid);
    if (!p || p.left) return { ok: false, error: 'No estás en la sala' };
    if (!(id in QUICK)) return { ok: false, error: 'Mensaje inválido' };
    if (!this.chatOk(pid)) return { ok: false, error: 'Más despacio' };
    this.emitChat({ kind: 'quick', pid, text: QUICK[id] });
    return { ok: true };
  }
  emote(pid, id) {
    const p = this.players.get(pid);
    if (!p || p.left) return { ok: false, error: 'No estás en la sala' };
    if (typeof id !== 'string' || !id.startsWith('emote-') || !this.store.owns(pid, id)) return { ok: false, error: 'No tenés ese emote' };
    if (!this.chatOk(pid)) return { ok: false, error: 'Más despacio' };
    this.emitChat({ kind: 'emote', pid, id });
    return { ok: true };
  }
  chatOk(pid) {
    const now = Date.now();
    if (now - (this.lastChat.get(pid) || 0) < 1200) return false;
    this.lastChat.set(pid, now); return true;
  }
  emitChat(msg) { this.io.to(this.code).emit('chat:msg', { ...msg, name: msg.pid ? this.players.get(msg.pid)?.name : undefined, at: Date.now() }); }

  // ---------- estado público ----------
  standings() {
    const act = this.active();
    const left = [...this.players.values()].filter((p) => p.left);
    return [...computeStandings(act), ...computeStandings(left).map((s) => ({ ...s, rank: s.rank + act.length }))];
  }

  snapshot() {
    const r = this.round; const game = r && gameById.get(r.gameId);
    const showBets = r && ['countdown', 'playing', 'resolving', 'celebrate'].includes(this.phase);
    const showChoice = r && ['playing', 'resolving', 'celebrate'].includes(this.phase);
    const standings = this.standings(); const rankOf = new Map(standings.map((s) => [s.id, s]));
    return {
      code: this.code, hostId: this.hostId, phase: this.phase, now: Date.now(), phaseEndsAt: this.phaseEndsAt, settings: this.settings,
      limits: { min: MIN_PLAYERS, max: MAX_PLAYERS }, completedRounds: this.completedRounds,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, look: p.look, connected: p.connected, left: p.left, balance: p.balance, roundWins: p.roundWins,
        rank: rankOf.get(p.id)?.rank ?? null, prevRank: p.prevRank, bailed: p.bailTotal > 0,
        decided: r ? r.decided.has(p.id) : false, hasBet: r ? !!r.bets[p.id] : false,
        bet: showBets && r.bets[p.id] ? r.bets[p.id].amount : null,
        choice: showChoice && r.bets[p.id] ? r.bets[p.id].choice : null,
      })),
      standings,
      round: r ? {
        index: r.index, total: this.settings.rounds, gameId: r.gameId,
        game: { id: game.id, name: game.name, emoji: game.emoji, mode: game.mode, tagline: game.tagline, rules: game.rules, needsChoice: game.needsChoice || null },
        noBets: r.noBets, state: r.state ? game.publicState(r.state, this.phase) : null,
        results: ['celebrate'].includes(this.phase) ? this.lastResults : null,
      } : null,
      final: this.finalInfo,
    };
  }

  broadcast() { if (!this.destroyed) this.io.to(this.code).emit('room:state', this.snapshot()); }
  broadcastLight() { this.broadcast(); }

  sendPrivate(pid) {
    const p = this.players.get(pid); if (!p || !p.socketId) return;
    const r = this.round;
    const payload = {
      round: r ? r.index : null, gameId: r ? r.gameId : null,
      bet: r && r.bets[pid] ? { amount: r.bets[pid].amount, choice: r.bets[pid].choice } : null,
      game: r && r.state ? gameById.get(r.gameId).privateState(r.state, pid, this.phase) : {},
    };
    this.io.to(p.socketId).emit('game:private', payload);
  }
  sendPrivateAll() { for (const id of this.players.keys()) this.sendPrivate(id); }
}

class RoomManager {
  constructor({ io, store, fast = false, rngInt = (n) => crypto.randomInt(n) }) {
    this.io = io; this.store = store; this.fast = fast; this.rngInt = rngInt;
    this.rooms = new Map(); this.byPlayer = new Map(); this.socketOf = new Map();
  }
  roomOf(pid) { const c = this.byPlayer.get(pid); return c ? this.rooms.get(c) : null; }

  create(pid, socket) {
    if (this.byPlayer.has(pid) && this.roomOf(pid)) return { ok: false, error: 'Ya estás en una sala. Salí primero.' };
    if (this.rooms.size >= 200) return { ok: false, error: 'El servidor está lleno de salas' };
    const code = newRoomCode((c) => this.rooms.has(c));
    const room = new Room(this, code, pid);
    this.rooms.set(code, room); this.byPlayer.set(pid, code);
    room.addPlayer(pid, socket);
    return { ok: true, code };
  }

  join(pid, code, socket) {
    const existing = this.roomOf(pid);
    if (existing) {
      if (existing.code === code) { existing.reconnect(pid, socket); return { ok: true, code }; }
      return { ok: false, error: 'Ya estás en otra sala. Salí primero.' };
    }
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'Ese código de sala no existe' };
    if (room.phase !== 'lobby') return { ok: false, error: 'La partida ya empezó' };
    if (room.players.size >= MAX_PLAYERS) return { ok: false, error: 'La sala está llena (máximo 8)' };
    this.byPlayer.set(pid, code);
    room.addPlayer(pid, socket);
    return { ok: true, code };
  }

  leave(pid) { const r = this.roomOf(pid); if (r) r.removePlayer(pid, 'leave'); return { ok: true }; }
  onDisconnect(pid) { const r = this.roomOf(pid); if (r) r.disconnect(pid); }
  stats() { return { rooms: this.rooms.size, players: this.byPlayer.size }; }
}

module.exports = { Room, RoomManager, QUICK, T, DEFAULT_SETTINGS, MAX_PLAYERS, MIN_PLAYERS, gameMeta };
