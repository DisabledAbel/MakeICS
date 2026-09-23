import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchNbaSchedules, parseUpcomingGames } from '../scripts/fetch-nba.js';

const games = [
  {
    gameId: 'future-1', gameStatus: 1, gameDate: '2026-10-02', gameDateTimeEst: '2026-10-03T00:30:00', gameDateTimeUTC: '2026-10-02T23:30:00Z', arenaName: 'Test Arena',
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
  assert.equal(result[0].officialDate, '2026-10-02');
});

test('fetchNbaSchedules writes normalized schedules for every NBA team', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-nba-'));
  const teams = Array.from({ length: 30 }, (_, index) => ({
    idTeam: String(100000 + index),
    strTeam: index === 0 ? 'Boston Celtics' : index === 1 ? 'New York Knicks' : `Inactive Team ${index}`,
    strTeamShort: index === 0 ? 'BOS' : index === 1 ? 'NYK' : `T${index}`
  }));
  const fetchImpl = async url => Response.json(url.includes('thesportsdb') ? { teams } : schedule);

  try {
    const result = await fetchNbaSchedules({ fetchImpl, outputDir, now: new Date('2026-09-23T00:00:00Z') });
    assert.deepEqual(result, { teams: 30, activeTeams: 2, writtenTeams: 2, skippedTeams: 28, games: 1 });
    const filePath = path.join(outputDir, '100000.json');
    const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].strTimestamp, '2026-10-02T23:30:00Z');
    assert.equal(data.events[0].strVenue, 'Test Arena');

    const firstUpdatedAt = data.events[0].updatedAt;
    const secondResult = await fetchNbaSchedules({ fetchImpl, outputDir, now: new Date('2026-09-24T00:00:00Z') });
    assert.equal(secondResult.writtenTeams, 0);
    const unchanged = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(unchanged.updatedAt, data.updatedAt);
    assert.equal(unchanged.events[0].updatedAt, firstUpdatedAt);

    const additionalGame = { ...games[0], gameId: 'future-2', gameDateTimeUTC: '2026-10-04T23:30:00Z' };
    const changedSchedule = { leagueSchedule: { gameDates: [{ games: [games[0], additionalGame] }] } };
    const changedFetch = async url => Response.json(url.includes('thesportsdb') ? { teams } : changedSchedule);
    const changedResult = await fetchNbaSchedules({ fetchImpl: changedFetch, outputDir, now: new Date('2026-09-25T00:00:00Z') });
    assert.equal(changedResult.writtenTeams, 2);
    const changed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(changed.events[0].updatedAt, firstUpdatedAt);
    assert.equal(changed.events[1].updatedAt, '2026-09-25T00:00:00.000Z');
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('fetchNbaSchedules rejects non-numeric team IDs before writing files', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-nba-invalid-'));
  const teams = Array.from({ length: 30 }, (_, index) => ({
    idTeam: index === 0 ? '../escape' : String(100000 + index),
    strTeam: index === 0 ? 'Boston Celtics' : index === 1 ? 'New York Knicks' : `Inactive Team ${index}`,
    strTeamShort: index === 0 ? 'BOS' : index === 1 ? 'NYK' : `T${index}`
  }));
  const fetchImpl = async url => Response.json(url.includes('thesportsdb') ? { teams } : schedule);

  try {
    await assert.rejects(
      fetchNbaSchedules({ fetchImpl, outputDir, now: new Date('2026-09-23T00:00:00Z') }),
      /Invalid NBA team ID/
    );
    assert.deepEqual(await fs.readdir(outputDir).catch(() => []), []);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
