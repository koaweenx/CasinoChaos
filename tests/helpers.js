'use strict';
const { createServer } = require('../server');
const { io } = require('socket.io-client');

async function startServer(opts = {}) {
  const ctx = createServer({ dbFile: ':memory:', fast: true, ...opts });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  ctx.url = `http://127.0.0.1:${ctx.server.address().port}`;
  ctx.clients = [];
  const origClose = ctx.close;
  ctx.close = async () => { ctx.clients.forEach((c) => c.close()); await origClose(); };
  return ctx;
}

const emit = (c, e, d = {}) => new Promise((r) => c.emit(e, d, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function client(ctx, { name, token } = {}) {
  const c = io(ctx.url, { transports: ['websocket'], forceNew: true, reconnection: false });
  c.on('time:probe', (cb) => cb());
  ctx.clients.push(c);
  c.snap = null; c.priv = null; c.events = []; c.chat = [];
  c.on('room:state', (s) => { c.snap = s; });
  c.on('game:private', (p) => { c.priv = p; });
  c.on('game:event', (e) => c.events.push(e));
  c.on('chat:msg', (m) => c.chat.push(m));
  await new Promise((res, rej) => { c.on('connect', res); c.on('connect_error', rej); });
  c.hello = await emit(c, 'auth:hello', { name, token });
  c.id = c.hello.profile.id; c.token = c.hello.token || token;
  return c;
}

async function waitFor(fn, ms = 8000, step = 15) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor: tiempo agotado');
    await sleep(step);
  }
}

module.exports = { startServer, client, emit, sleep, waitFor };

/** Bot que juega solo todos los minijuegos que no requieren calendario real. */
function bot(c, { minigames = true } = {}) {
  c.on('room:state', async (s) => {
    const r = s.round; if (!r || !minigames) return;
    const key = `${r.index}:${s.phase}`;
    if (c._last === key) return; c._last = key;
    if (s.phase === 'betting') {
      const me = s.players.find((p) => p.id === c.id);
      if (me && me.balance >= s.settings.minBet) await emit(c, 'bet:place', { amount: Math.min(s.settings.minBet * 2, me.balance), choice: 'red' });
    }
    if (s.phase === 'playing') {
      if (r.gameId === 'lucky-spin') await emit(c, 'game:action', { type: 'spin' });
      if (r.gameId === 'high-low') { await emit(c, 'game:action', { type: 'guess', dir: 'higher' }); await emit(c, 'game:action', { type: 'guess', dir: 'lower' }); await emit(c, 'game:action', { type: 'cashout' }); }
      if (r.gameId === 'cursed-chests') { await emit(c, 'game:action', { type: 'open', index: 0 }); await emit(c, 'game:action', { type: 'open', index: 1 }); await emit(c, 'game:action', { type: 'cashout' }); }
    }
  });
  c.on('game:event', (e) => { if (e.type === 'go') emit(c, 'game:action', { type: 'press' }); });
}
module.exports.bot = bot;
