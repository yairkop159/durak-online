import type { Card } from '@durak/shared';

/**
 * Text that names cards: Hebrew strings and cards, never concatenated. A card label ("8♣") is
 * left-to-right; inside a right-to-left sentence its rank and suit would reorder, so every card is
 * rendered in its own bidi isolate (`TutorialText`: `<bdi dir="ltr">`; `richToPlain` in TutorialText.tsx: LRI…PDI). No imports beyond
 * types: he.ts uses `rich`.
 */
export type RichPart = string | Card;
export type Rich = readonly RichPart[];

export const isCardPart = (part: RichPart): part is Card => typeof part !== 'string';

/** Tagged-template helper for he.ts: rich`${a} לא יכול לכסות ${b}` keeps the cards as cards. */
export function rich(strings: TemplateStringsArray, ...values: readonly (string | number | Card)[]): Rich {
  const out: RichPart[] = [];
  strings.forEach((s, i) => {
    if (s) out.push(s);
    if (i < values.length) {
      const v = values[i]!;
      out.push(typeof v === 'number' ? String(v) : v);
    }
  });
  return out;
}
