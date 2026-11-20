/**
 * Random self-play property tests for 2v2 team mode (seats 0+2 vs 1+3), both modes. Every step also
 * runs the classic harness checks (card conservation and the other invariants, view/state move
 * parity for every seat, lastBout). Chunked at 10 games per test (see tests/setup/eventLoop.ts).
 */
import { losingTeam, seatsAreOpponents, teamOfSeat, type GameMode, type Move } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { isFinished, playerIndex, type GameState } from '../src/index.js';
import { allCards, isFullDeckPermutation } from './helpers.js';
import { playRandomGame, SEEDS_PER_CASE, SEEDS_PER_TEST } from './selfPlay.js';

function fail(message: string, detail: unknown): never {
  throw new Error(`${message}: ${JSON.stringify(detail)}`);
}

/** Team rules that every single step must respect. */
function checkTeamStep(before: GameState, move: Move, after: GameState): void {
  const mover = playerIndex(before, move.playerId);
  // Nobody ever attacks, throws in or passes against their own partner.
  if (move.type === 'attack' || move.type === 'pass') {
    if (!seatsAreOpponents(before.config, mover, before.defenderIndex)) fail('attack/pass at a partner', move);
  }
  // A transfer always goes to an opponent of the transferring player.
  if (move.type === 'transfer' && after.phase.kind !== 'finished') {
    if (!seatsAreOpponents(after.config, mover, after.defenderIndex)) fail('transfer to a partner', move);
    if (after.attackerIndex !== mover) fail('the transferring player is not the main attacker', move);
  }
  if (!isFullDeckPermutation(allCards(after))) fail('cards not conserved', move);
  if (after.phase.kind !== 'finished') {
    // The main attacker and the defender are always on opposite teams.
    if (!seatsAreOpponents(after.config, after.attackerIndex, after.defenderIndex)) fail('attacker and defender are partners', after);
    // While the game runs, both teams still hold cards.
    const teamsIn = new Set(after.players.map((_, i) => i).filter((i) => !isFinished(after, i)).map(teamOfSeat));
    if (teamsIn.size !== 2) fail('a running game with one team left', after.finishOrder);
  }
}

/** The end of a team game: the durak's team loses, and it is the only team still holding cards. */
function checkTeamFinal(final: GameState): void {
  if (final.phase.kind !== 'finished') throw new Error('not finished');
  const remaining = final.players.map((_, i) => i).filter((i) => !isFinished(final, i));
  for (const id of final.finishOrder) expect(final.players.find((p) => p.id === id)!.hand).toEqual([]);
  for (const i of remaining) expect(final.players[i]!.hand.length).toBeGreaterThan(0);
  const durak = final.phase.durak;
  if (durak === null) {
    expect(remaining).toEqual([]);
    expect(losingTeam(final)).toBeNull();
    return;
  }
  const durakSeat = playerIndex(final, durak);
  expect(remaining).toContain(durakSeat);
  expect(remaining.map(teamOfSeat).every((t) => t === teamOfSeat(durakSeat))).toBe(true);
  const most = Math.max(...remaining.map((i) => final.players[i]!.hand.length));
  expect(final.players[durakSeat]!.hand.length).toBe(most);
  expect(losingTeam(final)).toBe(teamOfSeat(durakSeat));
  expect(final.finishOrder.length + remaining.length).toBe(4);
}

for (const mode of ['podkidnoy', 'perevodnoy'] as GameMode[]) {
  describe(`random self-play, 2v2 teams, ${mode} (property tests)`, () => {
    for (let from = 1; from <= SEEDS_PER_CASE * 2; from += SEEDS_PER_TEST) {
      const to = from + SEEDS_PER_TEST - 1;
      it(`games ${from}-${to} of ${SEEDS_PER_CASE * 2} terminate with every classic and team invariant holding`, () => {
        for (let seed = from; seed <= to; seed++) {
          checkTeamFinal(playRandomGame(4, mode, seed * 6007 + 4, { teams: true, onStep: checkTeamStep }));
        }
      }, 60_000);
    }

    it('the endings cover a loss by each team and both durak shapes (alone, or with a partner left)', () => {
      const outcomes = new Set<string>();
      for (let seed = 1; seed <= SEEDS_PER_CASE * 2; seed++) {
        const final = playRandomGame(4, mode, seed * 6007 + 4, { teams: true });
        const remaining = final.players.filter((_, i) => !isFinished(final, i)).length;
        outcomes.add(`team${losingTeam(final) ?? 'draw'}`);
        outcomes.add(`left${remaining}`);
      }
      expect(outcomes).toContain('team0');
      expect(outcomes).toContain('team1');
      expect(outcomes).toContain('left1');
      expect(outcomes).toContain('left2');
    }, 60_000);
  });
}
