import { z } from 'zod';

/**
 * Quick reactions: a fixed list, no free text. Ids are stable ASCII; the glyph or phrase each one
 * shows lives in the web client's strings (he.ts).
 */
export const REACTION_IDS = ['laugh', 'fire', 'shock', 'clap', 'think', 'nice', 'lucky', 'ohNo', 'again'] as const;
export type ReactionId = (typeof REACTION_IDS)[number];
export const ReactionIdSchema = z.enum(REACTION_IDS);

/** Per-player limit on reactions (token bucket): a burst of 3, then one every 2 s. */
export const REACTION_BURST = 3;
export const REACTION_REFILL_MS = 2_000;
