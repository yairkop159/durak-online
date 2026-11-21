import { z } from 'zod';

export const GAME_MODES = ['podkidnoy', 'perevodnoy'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

export const GameConfigSchema = z
  .object({
    /** "podkidnoy" = throw-in only; "perevodnoy" = defender may also transfer the attack. */
    mode: z.enum(GAME_MODES),
    /** Maximum attack cards in the very first bout of the game (classic rule: 5). */
    firstBoutMaxCards: z.number().int().min(1).max(6),
    /** Maximum attack cards in any later bout (classic rule: 6). */
    boutMaxCards: z.number().int().min(1).max(6),
    /**
     * 2v2 team mode (exactly 4 players; partners sit opposite: seats 0+2 vs 1+3). Absent or false =
     * every player for themselves. Optional so every existing config, view and record is unchanged.
     * See teams.ts and CLAUDE.md "Teams".
     */
    teams: z.boolean().optional(),
  })
  .strict();

export type GameConfig = z.infer<typeof GameConfigSchema>;

export const DEFAULT_GAME_CONFIG: GameConfig = {
  mode: 'podkidnoy',
  firstBoutMaxCards: 5,
  boutMaxCards: 6,
};

/** Partial config a room creator may send; missing fields fall back to defaults. */
export const GameConfigInputSchema = GameConfigSchema.partial();
export type GameConfigInput = z.infer<typeof GameConfigInputSchema>;
