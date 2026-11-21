import type { GameOverPayload } from '@durak/shared';
import { useEffect, useRef } from 'react';
import type { BoardAnimation } from '../anim/useBoardAnimation';
import { useAudio, useHaptic } from '../settings/react';
import type { TeamTable } from '../game/teams';
import { gameOverCue, soundsFor, tickSecond, turnCue } from './soundPlan';

/**
 * Plays the table's sounds: every animation event (timed with its flight), the "your turn" chime,
 * the last-seconds ticks of my own turn, and the win / durak stinger. The chime and the stinger
 * also vibrate (setting "vibration", phones only).
 */
export function useGameSounds({
  anim,
  myTurn,
  remaining,
  gameOver,
  viewerId,
  table,
  stingerByReveal = false,
}: {
  anim: BoardAnimation;
  myTurn: boolean;
  remaining: number | null;
  gameOver: GameOverPayload | null;
  viewerId: string | null;
  /** Config + seats, so a team loss sounds like one. */
  table?: Omit<TeamTable, 'viewerId'> | undefined;
  /** The durak reveal plays the stinger itself, when its stamp lands. */
  stingerByReveal?: boolean;
}): void {
  const audio = useAudio();
  const haptic = useHaptic();

  // Each animated version once.
  const playedVersion = useRef(anim.version);
  useEffect(() => {
    if (anim.version === playedVersion.current) return;
    playedVersion.current = anim.version;
    for (const { sound, atMs } of soundsFor(anim)) audio.play(sound, atMs);
  }, [anim, audio]);

  const wasMyTurn = useRef(myTurn);
  useEffect(() => {
    const cue = turnCue(wasMyTurn.current, myTurn);
    wasMyTurn.current = myTurn;
    if (cue) {
      audio.play(cue);
      haptic('yourTurn');
    }
  }, [myTurn, audio, haptic]);

  const lastTick = useRef<number | null>(null);
  const second = tickSecond(remaining, myTurn);
  useEffect(() => {
    if (second !== null && second !== lastTick.current) audio.play('tick');
    lastTick.current = second;
  }, [second, audio]);

  const announced = useRef<GameOverPayload | null>(gameOver);
  useEffect(() => {
    if (!gameOver || gameOver === announced.current) return;
    announced.current = gameOver;
    const cue = gameOverCue(gameOver, viewerId, table);
    if (cue && !stingerByReveal) {
      audio.play(cue);
      haptic(cue);
    }
    // `table` is read when game:over arrives; it must not re-trigger the stinger.
  }, [gameOver, viewerId, audio, haptic, stingerByReveal]);
}
