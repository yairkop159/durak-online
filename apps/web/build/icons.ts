/**
 * The app icon, drawn in code: a dark tile with a turquoise glow, a face-down card behind a white
 * card carrying a turquoise spade. Shapes are inside-tests sampled 4x4 per pixel (anti-aliased),
 * deterministic, colors from the theme file.
 */
import { encodePng } from './png';
import type { ThemeColors } from './theme';

type RGB = readonly [number, number, number];
type RGBA = readonly [number, number, number, number];

function hex(color: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) throw new Error(`not a #rrggbb color: ${color}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Signed distance to a rounded rectangle centered at the origin. */
function roundedRect(x: number, y: number, halfW: number, halfH: number, r: number): number {
  const qx = Math.abs(x) - (halfW - r);
  const qy = Math.abs(y) - (halfH - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function rotate(x: number, y: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c + y * s, -x * s + y * c];
}

/** A spade in its own units (y up): an upside-down implicit heart plus a flared stem. */
function inSpade(x: number, y: number): boolean {
  const hy = -y; // the heart curve, flipped: point up, lobes down
  const heart = (x * x + hy * hy - 1) ** 3 - x * x * hy ** 3 <= 0;
  if (heart) return true;
  // Stem: from inside the lobes down to a base, widening as it goes.
  if (y > -0.4 || y < -1.75) return false;
  const t = (-0.4 - y) / 1.35; // 0 at the top of the stem, 1 at its base
  return Math.abs(x) <= 0.1 + 0.45 * t * t;
}

export interface IconOptions {
  /** Full-bleed background, art inside the central 80 % (Android adaptive icons, iOS). */
  readonly fullBleed: boolean;
}

/** One sample's color at (u, v) in [0, 1]² (v down). */
function sample(u: number, v: number, c: Palette, opts: IconOptions): RGBA {
  // The art is drawn around the center; a full-bleed icon shrinks it into the maskable safe zone.
  const k = opts.fullBleed ? 0.8 : 1;
  const x = (u - 0.5) / k;
  const y = (v - 0.5) / k;

  // Tile: rounded square (or the full square when full-bleed).
  if (!opts.fullBleed && roundedRect(u - 0.5, v - 0.5, 0.5, 0.5, 0.22) > 0) return [0, 0, 0, 0];
  let color: RGB = mix(c.bg1, c.bg0, Math.min(1, Math.max(0, v)));
  const glow = Math.max(0, 1 - Math.hypot(u - 0.5, (v - 0.48) * 1.15) / 0.5);
  color = mix(color, c.accent, 0.28 * glow * glow);

  // The face-down card behind, tilted the other way.
  const [bx, by] = rotate(x - 0.1, y + 0.01, 14);
  const back = roundedRect(bx, by, 0.2, 0.28, 0.045);
  if (back <= 0) {
    color = back > -0.016 ? c.accent : c.back;
    // A faint lattice on the back.
    if (back <= -0.016 && (Math.abs(((bx + by) * 14) % 1) < 0.12 || Math.abs(((bx - by) * 14) % 1) < 0.12)) color = mix(c.back, c.accent, 0.3);
  }

  // The front card with the spade.
  const [fx, fy] = rotate(x + 0.06, y + 0.01, -8);
  const front = roundedRect(fx, fy, 0.21, 0.29, 0.045);
  if (front <= 0) {
    color = front > -0.008 ? c.cardEdge : c.card;
    const unit = 0.095;
    if (inSpade(fx / unit, -(fy + 0.01) / unit)) color = c.accentStrong;
  }
  return [color[0], color[1], color[2], 255];
}

interface Palette {
  readonly bg0: RGB;
  readonly bg1: RGB;
  readonly accent: RGB;
  readonly accentStrong: RGB;
  readonly card: RGB;
  readonly cardEdge: RGB;
  readonly back: RGB;
}

function palette(theme: ThemeColors): Palette {
  return {
    bg0: hex(theme.bg0),
    bg1: hex(theme.bg1),
    accent: hex(theme.accent),
    accentStrong: hex(theme.accentStrong),
    card: hex(theme.card),
    cardEdge: hex(theme.cardEdge),
    back: hex(theme.back),
  };
}

const SS = 4;

/** RGBA pixels of a `size` x `size` icon. */
export function renderIcon(size: number, theme: ThemeColors, opts: IconOptions): Uint8Array {
  const c = palette(theme);
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const s = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, c, opts);
          // Premultiplied accumulation, so transparent corners don't darken the edge.
          r += s[0] * s[3];
          g += s[1] * s[3];
          b += s[2] * s[3];
          a += s[3];
        }
      }
      const i = (py * size + px) * 4;
      out[i] = a === 0 ? 0 : Math.round(r / a);
      out[i + 1] = a === 0 ? 0 : Math.round(g / a);
      out[i + 2] = a === 0 ? 0 : Math.round(b / a);
      out[i + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

export interface IconFile {
  readonly path: string;
  readonly size: number;
  readonly purpose: 'any' | 'maskable' | 'apple' | 'favicon';
}

export const ICON_FILES: readonly IconFile[] = [
  { path: 'icons/icon-192.png', size: 192, purpose: 'any' },
  { path: 'icons/icon-512.png', size: 512, purpose: 'any' },
  { path: 'icons/icon-maskable-512.png', size: 512, purpose: 'maskable' },
  { path: 'icons/apple-touch-icon.png', size: 180, purpose: 'apple' },
  { path: 'icons/favicon-32.png', size: 32, purpose: 'favicon' },
];

export function iconPng(file: IconFile, theme: ThemeColors): Buffer {
  // iOS and Android masks round the corners themselves: those get a full-bleed square.
  const fullBleed = file.purpose === 'maskable' || file.purpose === 'apple';
  return encodePng(file.size, file.size, renderIcon(file.size, theme, { fullBleed }));
}
