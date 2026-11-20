/**
 * Non-team games must stay move-for-move identical to main's engine before team mode existed:
 * the same moves, states, views, knowledge and bot choices. See tests/golden/nonTeamGames.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { caseKey, goldenCases, playGoldenCase, type GoldenCase } from './golden/nonTeamGames.js';

const golden = JSON.parse(readFileSync(new URL('./golden/nonTeamGolden.json', import.meta.url), 'utf8')) as Record<
  string,
  string
>;

const cases = goldenCases();
const CHUNK = 6;

describe('non-team games are unchanged (golden record from main)', () => {
  it('the golden file covers exactly the current case list', () => {
    expect(Object.keys(golden).sort()).toEqual(cases.map(caseKey).sort());
  });

  const groups = new Map<string, GoldenCase[]>();
  for (const c of cases) {
    const key = `${c.kind} ${c.mode} ${c.players} players`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const [name, group] of groups) {
    for (let i = 0; i < group.length; i += CHUNK) {
      const chunk = group.slice(i, i + CHUNK);
      it(`${name}: cases ${i + 1}-${i + chunk.length} of ${group.length}`, () => {
        for (const c of chunk) expect({ c: caseKey(c), hash: playGoldenCase(c) }).toEqual({ c: caseKey(c), hash: golden[caseKey(c)] });
      }, 60_000);
    }
  }
});
