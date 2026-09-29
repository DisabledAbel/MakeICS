import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { nflSeasonYear } from '../scripts/nfl/fetch-nfl.js';

test('selects the current NFL season across the calendar-year boundary', () => {
  assert.equal(nflSeasonYear(new Date('2027-01-15T00:00:00Z')), 2026);
  assert.equal(nflSeasonYear(new Date('2026-09-29T00:00:00Z')), 2026);
});

test('NFL fetcher writes to the repository schedule directory', async () => {
  const source = await fs.readFile(new URL('../scripts/nfl/fetch-nfl.js', import.meta.url), 'utf8');
  assert.match(source, /path\.join\(__dirname, '\.\.\/\.\.\/lib\/data\/sports\/supplemental'\)/);
  assert.doesNotMatch(source, /path\.join\(__dirname, '\.\.\/lib\/data\/sports\/supplemental'\)/);
});
