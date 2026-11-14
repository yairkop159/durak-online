/** Reads the colors the PWA files need from the theme file (src/theme/theme.css), the single source of truth. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ThemeColors {
  readonly bg0: string;
  readonly bg1: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly accentStrong: string;
  readonly accentInk: string;
  readonly card: string;
  readonly cardEdge: string;
  readonly back: string;
}

const TOKENS: Record<keyof ThemeColors, string> = {
  bg0: 'bg-0',
  bg1: 'bg-1',
  surface: 'surface',
  text: 'text',
  muted: 'muted',
  accent: 'accent',
  accentStrong: 'accent-strong',
  accentInk: 'accent-ink',
  card: 'card',
  cardEdge: 'card-edge',
  back: 'back',
};

export const THEME_FILE = fileURLToPath(new URL('../src/theme/theme.css', import.meta.url));

/** `--color-<token>: #rrggbb;` for every token we need (throws if one is missing or not a hex color). */
export function parseThemeColors(css: string): ThemeColors {
  const out: Partial<Record<keyof ThemeColors, string>> = {};
  for (const [key, token] of Object.entries(TOKENS) as [keyof ThemeColors, string][]) {
    const m = new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
    if (!m) throw new Error(`theme.css: --color-${token} missing or not #rrggbb`);
    out[key] = m[1]!.toLowerCase();
  }
  return out as ThemeColors;
}

export function readThemeColors(file = THEME_FILE): ThemeColors {
  return parseThemeColors(readFileSync(file, 'utf8'));
}
