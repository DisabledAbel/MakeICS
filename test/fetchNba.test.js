import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchNbaSchedules, parseUpcomingGames } from '../scripts/fetch-nba.js';

const games = [
  {
    gameId: 'future-1', gameStatus: 1, gameDate: '2026-10-02', gameDateTimeUTC: '2026-10-02T23:30:00Z', arenaName: 'Test Arena',
    homeTeam: { teamCity: 'Boston', teamName: 'Celtics', teamTricode: 'BOS' },
    awayTeam: { teamCity: 'New York', teamName: 'Knicks', teamTricode: 'NYK' },
    broadcasters: { nationalBroadcasters: [{ broadcasterDisplay: 'NBA TV' }] }
  },
  {
    gameId: 'past-1', gameStatus: 3, gameDate: '2026-09-01', gameDateTimeUTC: '2026-09-01T23:30:00Z',
    homeTeam: { teamCity: 'Boston', teamName: 'Celtics', teamTricode: 'BOS' },
    awayTeam: { teamCity: 'New York', teamName: 'Knicks', teamTricode: 'NYK' }
  }
];
const schedule = { leagueSchedule: { gameDates: [{ games }] } };

test('parseUpcomingGames keeps every scheduled future game and excludes completed games', () => {
  const result = parseUpcomingGames(schedule, new Date('2026-09-23T00:00:00Z'));
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'future-1');
  assert.equal(result[0].broadcast, 'NBA TV');
});

test('fetchNbaSchedules writes normalized schedules for every NBA team', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-nba-'));
  const teams = Array.from({ length: 30 }, (_, index) => ({
    idTeam: String(1000 + index),
    strTeam: index % 2 === 0 ? 'Boston Celtics' : 'New York Knicks',
    strTeamShort: index % 2 === 0 ? 'BOS' : 'NYK'
  }));
  const fetchImpl = async url => Response.json(url.includes('thesportsdb') ? { teams } : schedule);

  try {
    const result = await fetchNbaSchedules({ fetchImpl, outputDir, now: new Date('2026-09-23T00:00:00Z') });
    assert.deepEqual(result, { teams: 30, games: 1 });
    const data = JSON.parse(await fs.readFile(path.join(outputDir, '1000.json'), 'utf8'));
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].strTimestamp, '2026-10-02T23:30:00Z');
    assert.equal(data.events[0].strVenue, 'Test Arena');
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
