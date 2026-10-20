'use strict';
const express = require('express');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Server } = require('socket.io');
const { Store } = require('./database');
const { RoomManager } = require('./rooms');
const { register } = require('./socket-handlers');

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address });
  }
  return out;
}

function createServer({ dbFile = path.join(__dirname, '..', 'data', 'casino-chaos.db'), fast = false, rngInt } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 20_000, pingInterval: 10000, pingTimeout: 12000, cors: { origin: false } });
  const store = new Store(dbFile);
  const mgr = new RoomManager({ io, store, fast, rngInt });
  register(io, mgr, store, { probeMs: fast ? 500 : 4000 });

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.get('/api/health', (req, res) => res.json({ ok: true, game: 'casino-chaos', time: Date.now(), ...mgr.stats() }));
  app.get('/api/network', (req, res) => res.json({ addresses: lanAddresses(), port: server.address()?.port ?? null }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0, etag: true }));

  const close = () => new Promise((resolve) => {
    for (const r of mgr.rooms.values()) r.destroy();
    io.close(() => { try { store.close(); } catch { /* ya cerrada */ } resolve(); });
  });
  return { app, server, io, store, mgr, close };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const ctx = createServer();
  ctx.server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\n[!] El puerto ${PORT} ya está en uso. Cerrá la otra instancia o ejecutá con otro puerto:  set PORT=3001 && npm start\n`);
    else console.error(e);
    process.exit(1);
  });
  ctx.server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  🎰  CASINO CHAOS — servidor listo\n');
    console.log(`  En esta PC:        http://localhost:${PORT}`);
    const lan = lanAddresses();
    if (lan.length) lan.forEach((a) => console.log(`  Desde celulares:   http://${a.address}:${PORT}   (${a.name})`));
    else console.log('  No se detectó una red local. Conectate al Wi-Fi y reiniciá el servidor.');
    console.log(`\n  Comprobar conectividad desde el celular: http://IP-DE-LA-PC:${PORT}/api/health`);
    console.log('  Para detener el servidor: Ctrl + C\n');
  });
  const stop = () => { ctx.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

module.exports = { createServer, lanAddresses };
