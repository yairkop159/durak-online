import { useEffect, useMemo, useRef } from 'react';
import { useClient, useClientState } from '../net/react';
import { REACTION_SHOW_MS, type ClientReaction } from '../net/store';
import { useAudio, useSettings } from '../settings/react';

export interface ReactionsInView {
  /** Whether reactions are shown at all (the "show reactions" setting). */
  readonly enabled: boolean;
  /** The newest still-visible reaction per player. */
  readonly byPlayer: ReadonlyMap<string, ClientReaction>;
  /** The newest reaction (for the polite live region), or null. */
  readonly latest: ClientReaction | null;
}

/**
 * Recent quick reactions for the current room: prunes them once their bubble is gone and plays the
 * soft reaction sound for each new one (respecting the sfx and "show reactions" settings).
 * Mount it once per screen.
 */
export function useReactions(): ReactionsInView {
  const client = useClient();
  const { reactions } = useClientState();
  const settings = useSettings();
  const audio = useAudio();
  const enabled = settings.showReactions;

  // Prune when the oldest one expires.
  useEffect(() => {
    const oldest = reactions[0];
    if (!oldest) return;
    const timer = setTimeout(() => client.pruneReactions(client.now() - REACTION_SHOW_MS), Math.max(0, oldest.at + REACTION_SHOW_MS - client.now()) + 10);
    return () => clearTimeout(timer);
  }, [reactions, client]);

  // A sound for each new reaction (never for ones that were already there when we mounted).
  const heard = useRef(reactions.at(-1)?.id ?? 0);
  useEffect(() => {
    const newest = reactions.at(-1);
    if (!newest || newest.id <= heard.current) return;
    heard.current = newest.id;
    if (enabled) audio.play('reaction');
  }, [reactions, enabled, audio]);

  return useMemo(() => {
    const byPlayer = new Map<string, ClientReaction>();
    if (enabled) for (const r of reactions) byPlayer.set(r.playerId, r);
    return { enabled, byPlayer, latest: enabled ? (reactions.at(-1) ?? null) : null };
  }, [reactions, enabled]);
}
