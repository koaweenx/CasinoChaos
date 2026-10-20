'use strict';
const crypto = require('node:crypto');

const NAME_RE = /^[\p{L}\p{N} _.\-]{2,16}$/u;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin I, L, O, 0, 1

function sanitizeName(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const s = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return NAME_RE.test(s) ? s : null;
}

function nameKey(name) {
  return name.normalize('NFKC').toLowerCase().replace(/[\s_.\-]/g, '');
}

function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function newId() { return crypto.randomBytes(9).toString('base64url'); }

function sanitizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > 12) return null;
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{4,6}$/.test(s) ? s : null;
}

function newRoomCode(exists) {
  for (let i = 0; i < 200; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!exists(c)) return c;
  }
  throw new Error('No se pudo generar un código de sala');
}

const isInt = (n) => Number.isSafeInteger(n);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/** Token bucket por clave (socket). */
class RateLimiter {
  constructor({ rate = 25, burst = 50 } = {}) { this.rate = rate; this.burst = burst; this.b = new Map(); }
  take(key, cost = 1, now = Date.now()) {
    let s = this.b.get(key);
    if (!s) { s = { tokens: this.burst, t: now }; this.b.set(key, s); }
    s.tokens = Math.min(this.burst, s.tokens + ((now - s.t) / 1000) * this.rate);
    s.t = now;
    if (s.tokens < cost) return false;
    s.tokens -= cost;
    return true;
  }
  drop(key) { this.b.delete(key); }
}

module.exports = { sanitizeName, nameKey, newToken, hashToken, newId, sanitizeCode, newRoomCode, isInt, isObj, RateLimiter, CODE_ALPHABET };
