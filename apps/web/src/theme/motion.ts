/**
 * Motion tokens (Framer Motion needs numbers). Colors, radii, shadows and CSS durations live in
 * `theme.css`; this file holds every animation timing so the whole feel is tuned in one place.
 */
export const motionTokens = {
  /** Hover lift / glow on legal cards (CSS transition, mirrored as --dur-hover in theme.css). */
  hoverMs: 120,
  hoverLiftPx: 10,
  selectedRisePx: 18,

  /** A card being played (hand -> table, seat -> table). */
  playMs: 280,
  playSpring: { type: 'spring', stiffness: 500, damping: 38, mass: 0.9 } as const,
  /** When a closing card ends the bout, the resolution waits for it to land. */
  playToResolutionMs: 300,

  /** Beaten sweep to the discard pile / taken cards flying to the defender. */
  sweepMs: 350,
  sweepStaggerMs: 30,
  /** Draws start this long after the resolution starts. */
  resolutionToDrawMs: 400,

  /** One card flying from the deck to a hand. */
  drawFlightMs: 300,
  drawStaggerMs: 120,

  /** Hard cap for a whole resolution (play + sweep + draws). */
  resolutionBudgetMs: 1200,

  /** Defense card offset/rotation over its attack card. */
  defenseRotateDeg: 15,

  shakeMs: 300,
  shakeX: [0, -6, 6, -4, 4, 0],

  /** prefers-reduced-motion: every movement becomes a quick fade. */
  reducedFadeMs: 150,

  gameOverStampMs: 450,
  confettiMs: 1600,
} as const;

export const ease = [0.22, 1, 0.36, 1] as const;
