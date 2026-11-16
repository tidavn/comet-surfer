// Comet Surfer — a procedural 1024x1024 PNG renderer.
// A tiny astronaut surfs a blazing comet diagonally across deep space,
// Earth small below, caption "DON'T BLINK." in a 5x7 bitmap font.
// Node 22 stdlib only. Deterministic: fixed-seed PRNG, no clock, no network.
// Usage: MAKEFUN_OUTPUT_DIR=<dir> node main.ts  (writes <dir>/entry.png)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32, fixed seed)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261116);

// ---------------------------------------------------------------------------
// Float light buffer: three floats per pixel, additive light accumulates here.
// ---------------------------------------------------------------------------
const buf = new Float32Array(W * H * 3);

function put(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] += r;
  buf[i + 1] += g;
  buf[i + 2] += b;
}

function setPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
}

// Soft radial glow: peak brightness at the centre, smooth falloff to radius.
function glow(cx, cy, radius, r, g, b, peak) {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(W - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(H - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 1) continue;
      const f = peak * (1 - d2) * (1 - d2);
      put(x, y, r * f, g * f, b * f);
    }
  }
}

// Hard disc with a 1px antialiased rim.
function disc(cx, cy, radius, r, g, b) {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius;
      if (d >= 1) continue;
      const a = d <= 0 ? 1 : 1 - d;
      const i = (y * W + x) * 3;
      buf[i] = buf[i] * (1 - a) + r * a;
      buf[i + 1] = buf[i + 1] * (1 - a) + g * a;
      buf[i + 2] = buf[i + 2] * (1 - a) + b * a;
    }
  }
}

// Thick line segment (capsule) drawn additively.
function stroke(x0, y0, x1, y1, width, r, g, b, peak) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const rad = width / 2 + 1;
  const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - rad));
  const bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + rad));
  const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - rad));
  const by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + rad));
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
      if (d >= rad) continue;
      const f = peak * (1 - (d / rad) * (d / rad));
      put(x, y, r * f, g * f, b * f);
    }
  }
}

// Thick line segment (capsule) that OVERWRITES with a flat colour.
// Additive strokes cannot draw a dark silhouette (adding near-black adds
// nothing), so limbs are painted with this instead.
function strokeSolid(x0, y0, x1, y1, width, r, g, b) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const rad = width / 2 + 1;
  const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - rad));
  const bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + rad));
  const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - rad));
  const by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + rad));
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
      if (d >= rad) continue;
      const a = d <= rad - 1 ? 1 : 1 - (d - (rad - 1));
      const i = (y * W + x) * 3;
      buf[i] = buf[i] * (1 - a) + r * a;
      buf[i + 1] = buf[i + 1] * (1 - a) + g * a;
      buf[i + 2] = buf[i + 2] * (1 - a) + b * a;
    }
  }
}

// Filled polygon (scanline), overwriting with a flat colour.
function fillPoly(points, r, g, b) {
  let minY = H;
  let maxY = 0;
  for (const p of points) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(H - 1, Math.ceil(maxY));
  const n = points.length;
  for (let y = minY; y <= maxY; y++) {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const c = points[(i + 1) % n];
      if ((a[1] <= y && c[1] > y) || (c[1] <= y && a[1] > y)) {
        const t = (y + 0.5 - a[1]) / (c[1] - a[1]);
        xs.push(a[0] + t * (c[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]));
      const x1 = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) setPx(x, y, r, g, b);
    }
  }
}

// Filled ellipse with a soft edge, overwriting.
function softEllipse(cx, cy, rx, ry, r, g, b, alpha) {
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx + 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 1) continue;
      const a = alpha * (d < 0.85 ? 1 : 1 - (d - 0.85) / 0.15);
      const i = (y * W + x) * 3;
      buf[i] = buf[i] * (1 - a) + r * a;
      buf[i + 1] = buf[i + 1] * (1 - a) + g * a;
      buf[i + 2] = buf[i + 2] * (1 - a) + b * a;
    }
  }
}

// ---------------------------------------------------------------------------
// Sky: vertical gradient, nebula blobs, milky-way band, starfield.
// ---------------------------------------------------------------------------
function paintSky() {
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const r = 0.035 + 0.02 * t;
    const g = 0.03 + 0.015 * t;
    const b = 0.10 + 0.05 * (1 - t);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
  // Nebula: huge, faint, coloured clouds.
  glow(210, 190, 320, 0.30, 0.12, 0.55, 0.10);
  glow(880, 720, 360, 0.05, 0.35, 0.40, 0.09);
  glow(520, 470, 300, 0.45, 0.10, 0.35, 0.06);
  glow(120, 620, 260, 0.12, 0.12, 0.45, 0.08);
  glow(760, 120, 220, 0.50, 0.25, 0.10, 0.05);

  // Milky-way band: diagonal strip of faint glow + dense dim stars.
  const bandX = -0.55;
  const bandY = 0.835;
  for (let i = 0; i < 520; i++) {
    const s = rand();
    const x = rand() * W;
    const y = 700 - x * 0.55 + (rand() - 0.5) * 190;
    if (y < 0 || y >= H) continue;
    const bright = 0.10 + rand() * 0.35;
    put(Math.floor(x), Math.floor(y), bright * 0.8, bright * 0.85, bright);
  }
  glow(300, 480, 260, 0.45, 0.5, 0.75, 0.05);
  glow(650, 300, 220, 0.4, 0.45, 0.7, 0.04);

  // Starfield.
  for (let i = 0; i < 720; i++) {
    const x = Math.floor(rand() * W);
    const y = Math.floor(rand() * H);
    const m = rand();
    const bright = 0.25 + m * m * 0.75;
    const warm = rand();
    const r = bright * (warm > 0.7 ? 1.0 : 0.85);
    const g = bright * 0.88;
    const b = bright * (warm < 0.3 ? 1.0 : 0.9);
    put(x, y, r, g, b);
    if (m > 0.97) {
      // Cross sparkle on the very brightest stars only.
      stroke(x - 3, y, x + 3, y, 1, r, g, b, 0.35);
      stroke(x, y - 3, x, y + 3, 1, r, g, b, 0.35);
    }
  }

  // Two shooting stars, thin diagonal streaks.
  stroke(150, 300, 320, 430, 2, 0.9, 0.95, 1.0, 0.55);
  stroke(700, 640, 830, 760, 2, 0.9, 0.9, 1.0, 0.45);
  glow(150, 300, 8, 0.9, 0.95, 1.0, 0.7);
  glow(700, 640, 7, 0.9, 0.9, 1.0, 0.6);
}

// ---------------------------------------------------------------------------
// Comet: head at (775, 235), tail streaming down-left along a diagonal.
// ---------------------------------------------------------------------------
const COMET_HEAD = [775, 235];
const COMET_DIR = [-0.832, 0.555]; // unit vector, head -> tail

function paintComet() {
  const [hx, hy] = COMET_HEAD;
  const [dx, dy] = COMET_DIR;
  // Tail: a chain of widening, fading glows; the tail bends slightly.
  // Two layers: a wide faint envelope and a hotter inner body, so the tail
  // reads as fire, not a laser beam.
  for (let s = 0; s <= 44; s++) {
    const t = s / 44;
    const bend = 38 * t * t; // tail curves downward
    const cx = hx + dx * 700 * t + bend * 0.25;
    const cy = hy + dy * 700 * t + bend;
    const radius = 34 + 200 * t;
    const fade = (1 - t) * (1 - t);
    glow(cx, cy, radius, 1.0, 0.55, 0.12, 0.55 * fade);
    glow(cx, cy, radius * 0.55, 1.0, 0.75, 0.30, 0.45 * fade);
  }
  // Flame flickers: small hot knots scattered along the tail.
  const flickers = [
    [0.12, 6, 0.8],
    [0.24, -10, 0.65],
    [0.36, 8, 0.55],
    [0.48, -6, 0.45],
    [0.60, 12, 0.35],
    [0.72, -14, 0.25],
  ];
  for (const [t, off, peak] of flickers) {
    const bend = 38 * t * t;
    glow(hx + dx * 700 * t + bend * 0.25 + off, hy + dy * 700 * t + bend - off * 0.5, 30 + 40 * t, 1.0, 0.8, 0.35, peak);
  }
  // Bright core streak along the axis.
  stroke(hx, hy, hx + dx * 620, hy + dy * 620 + 30, 26, 1.0, 0.85, 0.45, 0.55);
  stroke(hx, hy, hx + dx * 420, hy + dy * 420 + 14, 12, 1.0, 0.95, 0.70, 0.7);
  // Coma: the glowing head.
  glow(hx, hy, 150, 1.0, 0.62, 0.18, 0.75);
  glow(hx, hy, 95, 1.0, 0.80, 0.40, 0.85);
  glow(hx, hy, 55, 1.0, 0.95, 0.70, 0.95);
  // Distinct nucleus: a small white-hot disc with a thin bright ring.
  disc(hx, hy, 21, 1.0, 1.0, 0.98);
  disc(hx - 4, hy - 4, 12, 1.0, 1.0, 1.0);
}

// ---------------------------------------------------------------------------
// Surfer: a big dark silhouette standing ON the board, gold rim-light and a
// flowing gold scarf drawn as a sampled Bezier ribbon. Board runs from
// (560, 420) to (740, 350); feet land on it, hips at (655, 320).
// ---------------------------------------------------------------------------
const INK = [0.015, 0.015, 0.035]; // near-black silhouette
const GOLD = [1.0, 0.78, 0.32];

// Sample a quadratic Bezier curve.
function bezier(p0, p1, p2, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
  return pts;
}

// A tapering ribbon along a point list: width shrinks from w0 to w1.
function ribbon(points, w0, w1, r, g, b, peak) {
  for (let i = 0; i + 1 < points.length; i++) {
    const t = i / (points.length - 1);
    const w = w0 + (w1 - w0) * t;
    stroke(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], w, r, g, b, peak);
  }
}

function paintSurfer() {
  // Board: long plank tilted along the comet's path, gold edge on top.
  fillPoly(
    [
      [558, 414],
      [742, 344],
      [744, 354],
      [562, 424],
    ],
    INK[0],
    INK[1],
    INK[2],
  );
  stroke(560, 413, 742, 344, 2, GOLD[0], GOLD[1], GOLD[2], 0.9);

  // Legs: bent knees, feet planted on the board.
  strokeSolid(655, 322, 626, 366, 13, INK[0], INK[1], INK[2]); // back thigh
  strokeSolid(626, 366, 610, 400, 12, INK[0], INK[1], INK[2]); // back shin
  strokeSolid(655, 322, 684, 346, 13, INK[0], INK[1], INK[2]); // front thigh
  strokeSolid(684, 346, 690, 368, 12, INK[0], INK[1], INK[2]); // front shin
  // Torso: leaning forward toward the comet head.
  fillPoly(
    [
      [648, 262],
      [680, 268],
      [668, 326],
      [642, 322],
    ],
    INK[0],
    INK[1],
    INK[2],
  );
  // Backpack: rounded block behind the torso.
  softEllipse(636, 288, 15, 24, INK[0], INK[1], INK[2], 1.0);
  // Arms: front arm reaching toward the nose, back arm thrown up for balance.
  strokeSolid(672, 276, 716, 312, 10, INK[0], INK[1], INK[2]);
  strokeSolid(650, 272, 602, 244, 10, INK[0], INK[1], INK[2]);
  // Helmet: round, with a gold visor slit catching the comet light.
  disc(682, 248, 18, INK[0], INK[1], INK[2]);
  stroke(674, 242, 694, 238, 3, GOLD[0], GOLD[1], GOLD[2], 0.95);
  // Gold rim-light along the comet-facing edges.
  stroke(680, 268, 668, 326, 3, GOLD[0], GOLD[1], GOLD[2], 0.85);
  stroke(684, 346, 690, 368, 3, GOLD[0], GOLD[1], GOLD[2], 0.7);
  stroke(682, 230, 698, 242, 3, GOLD[0], GOLD[1], GOLD[2], 0.9);
  // Scarf: a gold ribbon streaming back from the neck, S-curved.
  const scarf = bezier([658, 268], [580, 306], [500, 330], 14).concat(
    bezier([500, 330], [470, 372], [452, 408], 10).slice(1),
  );
  ribbon(scarf, 14, 4, GOLD[0], GOLD[1], GOLD[2], 0.95);
  ribbon(scarf, 5, 2, 1.0, 0.95, 0.65, 0.9);
}

// ---------------------------------------------------------------------------
// Earth: a blue sphere low on the left, lit from the top right, with clouds
// and a thin glowing atmosphere.
// ---------------------------------------------------------------------------
function paintEarth() {
  const cx = 175;
  const cy = 835;
  const r = 128;
  // Atmosphere halo first (additive, behind the disc).
  glow(cx, cy, r + 26, 0.25, 0.55, 1.0, 0.30);
  glow(cx, cy, r + 10, 0.35, 0.65, 1.0, 0.22);
  // Ocean: shaded sphere, light from the top right.
  const lx = 0.55;
  const ly = -0.83;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = (x + 0.5 - cx) / r;
      const dy = (y + 0.5 - cy) / r;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const nz = Math.sqrt(1 - d2);
      let light = 0.25 + 0.75 * Math.max(0, dx * lx + dy * ly + nz * 0.35);
      const i = (y * W + x) * 3;
      buf[i] = 0.05 * light + 0.02;
      buf[i + 1] = 0.28 * light + 0.02;
      buf[i + 2] = 0.62 * light + 0.04;
    }
  }
  // Clouds: each cloud is a cluster of overlapping soft puffs, so none
  // reads as a flat pill; slight blue tint so they sit on the ocean.
  const clouds = [
    [140, 800],
    [200, 830],
    [120, 860],
    [215, 790],
    [175, 880],
  ];
  for (const [ccx, ccy] of clouds) {
    softEllipse(ccx - 16, ccy - 4, 26, 8, 0.88, 0.92, 1.0, 0.30);
    softEllipse(ccx + 6, ccy + 2, 30, 9, 0.92, 0.95, 1.0, 0.32);
    softEllipse(ccx + 22, ccy - 6, 20, 7, 0.88, 0.92, 1.0, 0.28);
    softEllipse(ccx, ccy + 6, 24, 7, 0.95, 0.97, 1.0, 0.25);
  }
  // Limb darkening: a faint dark rim on the night side.
  for (let a = 0; a < Math.PI * 2; a += 0.01) {
    const x = cx + Math.cos(a) * (r - 2);
    const y = cy + Math.sin(a) * (r - 2);
    if (Math.cos(a) < -0.2 && Math.sin(a) > 0.1) {
      put(Math.round(x), Math.round(y), -0.02, -0.02, -0.02);
    }
  }
}

// ---------------------------------------------------------------------------
// Caption "DON'T BLINK." in a 5x7 bitmap font, gold, bottom centre.
// ---------------------------------------------------------------------------
const FONT = {
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  "'": [0x04, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
};

function drawText(text, cx, y, scale, r, g, b) {
  const adv = 6 * scale;
  const total = text.length * adv - scale;
  let x = Math.round(cx - total / 2);
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT[' '];
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (bits & (0x10 >> col)) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              put(x + col * scale + dx, y + row * scale + dy, r, g, b);
            }
          }
        }
      }
    }
    x += adv;
  }
}

function paintCaption() {
  // Soft gold halo behind the letters, then the bright letters.
  drawText("DON'T BLINK.", 512, 946, 4, 0.45, 0.30, 0.08);
  drawText("DON'T BLINK.", 512, 946, 4, 1.0, 0.85, 0.45);
}

// ---------------------------------------------------------------------------
// PNG writer: CRC32, zlib deflate level 9, adaptive per-row filter.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePNG() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(H * (1 + W * 3));
  const prev = Buffer.alloc(W * 3);
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(W * 3);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      row[x * 3] = Math.max(0, Math.min(255, Math.round(buf[i] * 255)));
      row[x * 3 + 1] = Math.max(0, Math.min(255, Math.round(buf[i + 1] * 255)));
      row[x * 3 + 2] = Math.max(0, Math.min(255, Math.round(buf[i + 2] * 255)));
    }
    // Pick the cheapest of filters 0 (None), 1 (Sub), 2 (Up) for this row.
    let bestFilter = 0;
    let bestCost = Infinity;
    let bestRow = row;
    for (let f = 0; f <= 2; f++) {
      const filtered = Buffer.alloc(W * 3);
      let cost = 0;
      for (let i = 0; i < W * 3; i++) {
        let v = row[i];
        if (f === 1) v = (v - (i >= 3 ? row[i - 3] : 0)) & 0xff;
        if (f === 2) v = (v - prev[i]) & 0xff;
        filtered[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestFilter = f;
        bestRow = filtered;
      }
    }
    raw[y * (1 + W * 3)] = bestFilter;
    bestRow.copy(raw, y * (1 + W * 3) + 1);
    row.copy(prev);
  }

  const idat = deflateSync(raw, { level: 9 });
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

// ---------------------------------------------------------------------------
// Main: paint the scene, write entry.png.
// ---------------------------------------------------------------------------
function main() {
  paintSky();
  paintComet();
  paintSurfer();
  paintEarth();
  paintCaption();
  const png = encodePNG();
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? 'out';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), png);
}

main();
