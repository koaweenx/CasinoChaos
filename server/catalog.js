'use strict';
// Catálogo de cosméticos. El servidor es la única autoridad sobre precios y categorías.
// `art` describe cómo lo dibuja el cliente (SVG/CSS locales, sin imágenes remotas).
const ITEMS = [
  // Avatares
  { id: 'avatar-robot', cat: 'avatar', name: 'Robo-Croupier', desc: 'El crupier de confianza. Siempre sonríe.', price: 0, art: 'robot' },
  { id: 'avatar-ghost', cat: 'avatar', name: 'Fantasma Fortuna', desc: 'Aparece cuando la suerte se va.', price: 60, art: 'ghost' },
  { id: 'avatar-alien', cat: 'avatar', name: 'Alien Apostador', desc: 'Viene de otra galaxia a vaciar tu bolsillo.', price: 80, art: 'alien' },
  { id: 'avatar-skull', cat: 'avatar', name: 'Calavera neón', desc: 'Brilla en la oscuridad del casino.', price: 120, art: 'skull' },
  { id: 'avatar-cat', cat: 'avatar', name: 'Gato hacker', desc: 'Hackea las máquinas con maullidos.', price: 150, art: 'cat' },
  { id: 'avatar-king', cat: 'avatar', name: 'Rey del caos', desc: 'Gobierna la mesa con puño de neón.', price: 220, art: 'king' },
  { id: 'avatar-crown', cat: 'avatar', name: 'Corona eléctrica', desc: 'Una corona que chisporrotea.', price: 260, art: 'crown' },
  // Marcos
  { id: 'frame-basic', cat: 'frame', name: 'Marco clásico', desc: 'Sobrio y elegante.', price: 0, art: 'basic' },
  { id: 'frame-neon', cat: 'frame', name: 'Neón celeste', desc: 'Un borde que late.', price: 50, art: 'neon' },
  { id: 'frame-gold', cat: 'frame', name: 'Marco dorado', desc: 'Para los que ya saben ganar.', price: 120, art: 'gold' },
  { id: 'frame-aura', cat: 'frame', name: 'Aura violeta', desc: 'Una nube de energía te rodea.', price: 200, art: 'aura' },
  { id: 'frame-glitch', cat: 'frame', name: 'Marco glitch', desc: 'Error 777: demasiada suerte.', price: 160, art: 'glitch' },
  // Títulos
  { id: 'title-rookie', cat: 'title', name: 'Novato', desc: 'Todos empezamos acá.', price: 0, text: 'Novato' },
  { id: 'title-indebted', cat: 'title', name: 'El endeudado', desc: 'La casa siempre gana.', price: 30, text: 'El endeudado' },
  { id: 'title-lucky', cat: 'title', name: 'El suertudo', desc: 'Dicen que nació con un trébol.', price: 60, text: 'El suertudo' },
  { id: 'title-golden', cat: 'title', name: 'Manos de oro', desc: 'Todo lo que toca, paga.', price: 90, text: 'Manos de oro' },
  { id: 'title-king', cat: 'title', name: 'El rey del caos', desc: 'Solo para los campeones.', price: 150, text: 'El rey del caos' },
  // Efectos de victoria
  { id: 'vfx-confetti', cat: 'victory', name: 'Confeti clásico', desc: 'Lluvia de colores.', price: 0, art: 'confetti' },
  { id: 'vfx-coins', cat: 'victory', name: 'Lluvia de monedas', desc: 'Monedas doradas por todas partes.', price: 70, art: 'coins' },
  { id: 'vfx-diamonds', cat: 'victory', name: 'Explosión de diamantes', desc: 'Una detonación de brillos.', price: 140, art: 'diamonds' },
  { id: 'vfx-stars', cat: 'victory', name: 'Estrellas fugaces', desc: 'Un cielo entero para vos.', price: 100, art: 'stars' },
  // Efectos de entrada
  { id: 'entry-pop', cat: 'entry', name: 'Aparición', desc: 'Entrás con un pop.', price: 0, art: 'pop' },
  { id: 'entry-lightning', cat: 'entry', name: 'Rayo', desc: 'Llegás con un trueno.', price: 50, art: 'lightning' },
  { id: 'entry-smoke', cat: 'entry', name: 'Humo violeta', desc: 'Una entrada misteriosa.', price: 80, art: 'smoke' },
  // Emotes
  { id: 'emote-gg', cat: 'emote', name: 'GG', desc: 'Buen juego.', price: 0, glyph: 'GG', color: '#43E7FF' },
  { id: 'emote-fire', cat: 'emote', name: 'Fuego', desc: 'Estás que ardés.', price: 20, glyph: '🔥', color: '#FF8A3D' },
  { id: 'emote-skull', cat: 'emote', name: 'Calavera', desc: 'Te dejé sin fichas.', price: 30, glyph: '☠', color: '#E8E8FF' },
  { id: 'emote-crown', cat: 'emote', name: 'Corona', desc: 'El rey llegó.', price: 40, glyph: '♛', color: '#FFD34D' },
  { id: 'emote-bolt', cat: 'emote', name: 'Rayo', desc: 'Velocidad pura.', price: 25, glyph: '⚡', color: '#FFE14D' },
  // Efectos de nombre
  { id: 'namefx-none', cat: 'namefx', name: 'Sin efecto', desc: 'Nombre normal.', price: 0, art: 'none' },
  { id: 'namefx-neon', cat: 'namefx', name: 'Nombre neón', desc: 'Brilla y pulsa.', price: 40, art: 'neon' },
  { id: 'namefx-gold', cat: 'namefx', name: 'Nombre dorado', desc: 'Metal precioso.', price: 80, art: 'gold' },
  { id: 'namefx-rainbow', cat: 'namefx', name: 'Nombre arcoíris', desc: 'Todos los colores del caos.', price: 120, art: 'rainbow' },
  { id: 'namefx-glitch', cat: 'namefx', name: 'Nombre glitch', desc: 'Se corta y se arma.', price: 100, art: 'glitch' },
];

const CATEGORIES = [
  { id: 'avatar', label: 'Avatares' },
  { id: 'frame', label: 'Marcos' },
  { id: 'title', label: 'Títulos' },
  { id: 'victory', label: 'Victoria' },
  { id: 'entry', label: 'Entrada' },
  { id: 'emote', label: 'Emotes' },
  { id: 'namefx', label: 'Nombre' },
];

const ITEM_MAP = new Map(ITEMS.map((i) => [i.id, i]));
const DEFAULT_EQUIPPED = {
  avatar: 'avatar-robot', frame: 'frame-basic', title: 'title-rookie', victory: 'vfx-confetti',
  entry: 'entry-pop', namefx: 'namefx-none',
};
const isFree = (id) => { const i = ITEM_MAP.get(id); return !!i && i.price === 0; };

module.exports = { ITEMS, CATEGORIES, ITEM_MAP, DEFAULT_EQUIPPED, isFree };
