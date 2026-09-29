import test from 'node:test';
import assert from 'node:assert/strict';
import { currentSeasonFromResponse } from '../scripts/fetch-sports.js';

test('requires a non-empty league response with a usable current season', () => {
  assert.throws(() => currentSeasonFromResponse('4328', {}), /no league record/);
  assert.throws(() => currentSeasonFromResponse('4328', { leagues: [] }), /no league record/);
  assert.throws(() => currentSeasonFromResponse('4328', { leagues: [{}] }), /no current season/);
  assert.throws(() => currentSeasonFromResponse('4328', { leagues: [{ strCurrentSeason: '  ' }] }), /no current season/);
  assert.equal(currentSeasonFromResponse('4328', { leagues: [{ strCurrentSeason: '2026-2027' }] }), '2026-2027');
});
