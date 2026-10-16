import test from 'node:test';
import assert from 'node:assert/strict';
import { teamsFromWNBASchedule, WNBA_FRANCHISE_IDS } from '../scripts/wnba-team-source.js';

const names = [...WNBA_FRANCHISE_IDS.keys()];
function completeGames() {
  return names.map((name, i) => ({
    homeTeam: name,
    homeId: String(i + 1),
    awayTeam: names[(i + 1) % names.length],
    awayId: String((i + 1) % names.length + 1)
  }));
}

test('2026 WNBA schedule generates all 15 distinct franchise files', () => {
  const teams = teamsFromWNBASchedule(completeGames());
  assert.equal(teams.length, 15);
  assert.deepEqual(teams.map(team => team.strTeam), names);
  assert.equal(new Set(teams.map(team => team.idTeam)).size, 15);
  assert.equal(teams.find(team => team.strTeam === 'Portland Fire').idTeam, '152565');
  assert.equal(teams.find(team => team.strTeam === 'Golden State Valkyries').idTeam, '150722');
  assert.equal(teams.find(team => team.strTeam === 'Toronto Tempo').idTeam, '900000014');
});

test('truncated ten-team schedule fails before team processing', () => {
  const onlyTen = completeGames().slice(0, 9).map(({ homeTeam, homeId, awayTeam, awayId }) => ({
    homeTeam, homeId, awayTeam, awayId
  }));
  assert.throws(() => teamsFromWNBASchedule(onlyTen), /Incomplete WNBA schedule team list/);
});

test('rejects missing IDs even when franchise name is present', () => {
  const games = completeGames();
  games[0].homeId = '';
  assert.throws(() => teamsFromWNBASchedule(games), /Missing ESPN team ID for Atlanta Dream/);
});

test('rejects conflicting team IDs from different games', () => {
  const games = completeGames();
  games[0].homeId = '200';
  assert.throws(() => teamsFromWNBASchedule(games), /Conflicting ESPN team IDs for Atlanta Dream/);
});

test('does not treat all-star or unknown teams as 2026 franchises', () => {
  const games = completeGames().slice(0, 9);
  games.push({ homeTeam: 'WNBA All-Stars', homeId: '100', awayTeam: 'Team USA', awayId: '101' });
  assert.throws(() => teamsFromWNBASchedule(games), /Incomplete WNBA schedule team list/);
});
