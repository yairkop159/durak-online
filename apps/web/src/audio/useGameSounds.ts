import type { GameOverPayload } from '@durak/shared';
import { useEffect, useRef } from 'react';
import type { BoardAnimation } from '../anim/useBoardAnimation';
import { useAudio } from '../settings/react';
import { gameOverCue, soundsFor, tickSecond, turnCue } from './soundPlan';

/**
 * Plays the table's sounds: every animation event (timed with its flight), the "your turn" chime,
 * the last-seconds ticks of my own turn, and the win / durak stinger.
 */
export function useGameSounds({
  anim,
  myTurn,
  remaining,
  gameOver,
  viewerId,
}: {
  anim: BoardAnimation;
  myTurn: boolean;
  remaining: number | null;
  gameOver: GameOverPayload | null;
  viewerId: string | null;
}): void {
  const audio = useAudio();

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
    if (cue) audio.play(cue);
  }, [myTurn, audio]);

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
    const cue = gameOverCue(gameOver, viewerId);
    if (cue) audio.play(cue);
  }, [gameOver, viewerId, audio]);
}
