/**
 * Regenerates nonTeamGolden.json. Run ONLY for a deliberate change to the non-team rules or bots:
 *   npx tsx tests/golden/generate.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { caseKey, goldenCases, playGoldenCase } from './nonTeamGames.js';

const out: Record<string, string> = {};
const started = Date.now();
for (const c of goldenCases()) out[caseKey(c)] = playGoldenCase(c);
const file = fileURLToPath(new URL('./nonTeamGolden.json', import.meta.url));
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${Object.keys(out).length} cases in ${Date.now() - started} ms -> ${file}`);
