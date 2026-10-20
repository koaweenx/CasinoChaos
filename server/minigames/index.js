'use strict';
const games = [
  require('./lucky-spin'), require('./roulette'), require('./quick-draw'),
  require('./high-low'), require('./smash-cash'), require('./cursed-chests'),
];
const byId = new Map(games.map((g) => [g.id, g]));
const meta = games.map((g) => ({ id: g.id, name: g.name, emoji: g.emoji, mode: g.mode, tagline: g.tagline, rules: g.rules }));
module.exports = { games, byId, meta };
