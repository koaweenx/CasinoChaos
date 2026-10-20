'use strict';
const { sanitizeName, sanitizeCode, nameKey, isObj, RateLimiter } = require('./security');
const { ITEMS, CATEGORIES } = require('./catalog');
const { meta: gameMeta } = require('./minigames');
const { ACHIEVEMENTS } = require('./economy');

const GAME_ACTION_KEYS = ['type', 'dir', 'index', 'id'];

function register(io, mgr, store, { probeMs = 4000 } = {}) {
  const limiter = new RateLimiter({ rate: 30, burst: 60 });

  io.on('connection', (socket) => {
    socket.data.pid = null;
    let probeTimer = null;

    const on = (event, fn, { auth = true, cost = 1 } = {}) => {
      socket.on(event, (payload, ack) => {
        if (typeof payload === 'function') { ack = payload; payload = {}; }
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          if (!limiter.take(socket.id, cost)) return reply({ ok: false, error: 'Demasiadas acciones, más despacio' });
          if (auth && !socket.data.pid) return reply({ ok: false, error: 'Sesión no iniciada' });
          if (payload === undefined || payload === null) payload = {};
          if (!isObj(payload)) return reply({ ok: false, error: 'Datos inválidos' });
          const out = fn(payload);
          reply(out === undefined ? { ok: true } : out);
        } catch (err) {
          console.error(`[error] ${event}:`, err);
          reply({ ok: false, error: 'Error interno del servidor' });
        }
      });
    };

    const pid = () => socket.data.pid;
    const room = () => mgr.roomOf(pid());
    const profile = () => store.getProfile(pid());

    const startProbe = () => {
      clearInterval(probeTimer);
      const probe = () => {
        const t0 = Date.now();
        socket.timeout(2000).emit('time:probe', (err) => {
          if (err || !socket.data.pid) return;
          const half = Math.min(150, (Date.now() - t0) / 2);
          const r = mgr.roomOf(socket.data.pid); const p = r?.players.get(socket.data.pid);
          if (p) p.halfRtt = p.halfRtt * 0.6 + half * 0.4;
        });
      };
      probe(); probeTimer = setInterval(probe, probeMs); probeTimer.unref?.();
    };

    on('auth:hello', (d) => {
      let id = typeof d.token === 'string' ? store.findByToken(d.token) : null;
      let token;
      if (!id) {
        const name = sanitizeName(d.name) || `Jugador${String(Math.floor(100 + Math.random() * 900))}`;
        const created = store.createPlayer(name);
        id = created.id; token = created.token;
      }
      // Una sola sesión activa por jugador: la nueva reemplaza a la anterior.
      const old = mgr.socketOf.get(id);
      if (old && old !== socket.id) {
        const os = io.sockets.sockets.get(old);
        if (os) { os.data.pid = null; os.emit('session:replaced', {}); }
      }
      socket.data.pid = id; mgr.socketOf.set(id, socket.id);
      startProbe();
      const r = mgr.roomOf(id);
      if (r) r.reconnect(id, socket);
      return {
        ok: true, token, profile: store.getProfile(id), serverTime: Date.now(),
        catalog: { items: ITEMS, categories: CATEGORIES }, games: gameMeta, achievements: ACHIEVEMENTS,
        room: r ? r.code : null,
      };
    }, { auth: false });

    on('time:ping', () => ({ ok: true, now: Date.now() }), { auth: false });

    on('profile:get', () => ({ ok: true, profile: profile() }));

    on('profile:update', (d) => {
      const name = sanitizeName(d.name);
      if (!name) return { ok: false, error: 'Nombre inválido: 2 a 16 letras, números, espacios, _ . -' };
      const r = room();
      if (r) {
        const clash = [...r.players.values()].some((p) => p.id !== pid() && nameKey(p.name) === nameKey(name));
        if (clash) return { ok: false, error: 'Ya hay alguien con ese nombre en tu sala' };
      }
      store.setName(pid(), name);
      r?.refreshLook(pid());
      return { ok: true, profile: profile() };
    });

    on('profile:equip', (d) => {
      if (typeof d.category !== 'string' || typeof d.itemId !== 'string') return { ok: false, error: 'Datos inválidos' };
      const res = store.equip(pid(), d.category, d.itemId);
      if (res.ok) room()?.refreshLook(pid());
      return { ...res, profile: profile() };
    });

    on('shop:buy', (d) => {
      if (typeof d.itemId !== 'string') return { ok: false, error: 'Datos inválidos' };
      const res = store.buy(pid(), d.itemId);
      return { ...res, profile: profile() };
    }, { cost: 3 });

    on('room:create', () => {
      const res = mgr.create(pid(), socket);
      return res;
    }, { cost: 3 });

    on('room:join', (d) => {
      const code = sanitizeCode(d.code);
      if (!code) return { ok: false, error: 'Código inválido' };
      return mgr.join(pid(), code, socket);
    }, { cost: 3 });

    on('room:leave', () => mgr.leave(pid()));
    on('room:settings', (d) => { const r = room(); return r ? r.updateSettings(pid(), d) : { ok: false, error: 'No estás en una sala' }; });
    on('room:start', () => { const r = room(); return r ? r.start(pid()) : { ok: false, error: 'No estás en una sala' }; });
    on('room:rematch', () => { const r = room(); return r ? r.start(pid()) : { ok: false, error: 'No estás en una sala' }; });
    on('room:lobby', () => { const r = room(); return r ? r.backToLobby(pid()) : { ok: false, error: 'No estás en una sala' }; });

    on('bet:place', (d) => {
      const r = room(); if (!r) return { ok: false, error: 'No estás en una sala' };
      return r.placeBet(pid(), d.amount, typeof d.choice === 'string' ? d.choice : null);
    });
    on('bet:skip', () => { const r = room(); return r ? r.skipBet(pid()) : { ok: false, error: 'No estás en una sala' }; });

    on('game:action', (d) => {
      const r = room(); if (!r) return { ok: false, error: 'No estás en una sala' };
      const a = {};
      for (const k of GAME_ACTION_KEYS) {
        const v = d[k];
        if (v === undefined) continue;
        if (typeof v === 'string' && v.length <= 16) a[k] = v;
        else if (typeof v === 'number' && Number.isFinite(v)) a[k] = v;
        else return { ok: false, error: 'Datos inválidos' };
      }
      if (typeof a.type !== 'string') return { ok: false, error: 'Acción inválida' };
      return r.action(pid(), a);
    });

    on('chat:quick', (d) => { const r = room(); return r ? r.quick(pid(), d.id) : { ok: false, error: 'No estás en una sala' }; });
    on('chat:emote', (d) => { const r = room(); return r ? r.emote(pid(), d.id) : { ok: false, error: 'No estás en una sala' }; });

    socket.on('disconnect', () => {
      clearInterval(probeTimer); limiter.drop(socket.id);
      const id = socket.data.pid;
      if (id && mgr.socketOf.get(id) === socket.id) { mgr.socketOf.delete(id); mgr.onDisconnect(id); }
    });
  });
}

module.exports = { register };
