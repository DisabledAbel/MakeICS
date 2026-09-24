import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchJson, fetchNbaSchedules, parseUpcomingGames } from '../scripts/fetch-nba.js';

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

test('fetchJson retries timeouts with a fresh signal and retries transient HTTP errors', async () => {
  const signals = [];
  const fetchImpl = async (_url, { signal }) => {
    signals.push(signal);
    if (signals.length === 1) return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    if (signals.length === 2) return new Response('', { status: 503 });
    return Response.json({ recovered: true });
  };
  assert.deepEqual(await fetchJson('https://example.test/schedule', fetchImpl, { timeoutMs: 10, retryDelayMs: 0 }), { recovered: true });
  assert.equal(signals.length, 3);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.notEqual(signals[0], signals[1]);
});

test('fetchJson reports the failing URL and does not retry permanent HTTP failures', async () => {
  let calls = 0;
  await assert.rejects(fetchJson('https://example.test/schedule', async () => {
    calls++;
    return new Response('', { status: 403 });
  }), /https:\/\/example.test\/schedule: HTTP 403/);
  assert.equal(calls, 1);
});

function fallbackFixture({ failTeam = false } = {}) {
  const teams = Array.from({ length: 30 }, (_, index) => ({
    idTeam: String(100000 + index),
    strTeam: index === 0 ? 'Boston Celtics' : index === 1 ? 'New York Knicks' : `Inactive Team ${index}`
  }));
  const calls = [];
  const event = {
    id: '401000001', date: games[0].gameDateTimeUTC,
    competitions: [{
      status: { type: { state: 'pre' } },
      competitors: [{ homeAway: 'home', team: { id: '1' } }, { homeAway: 'away', team: { id: '2' } }],
      venue: { fullName: 'Test Arena' }, broadcasts: [{ media: { shortName: 'NBA TV' } }]
    }]
  };
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('thesportsdb')) return Response.json({ teams });
    if (url.includes('cdn.nba.com')) throw new DOMException('aborted', 'AbortError');
    if (url.endsWith('/teams?limit=100')) return Response.json({ sports: [{ leagues: [{ teams: teams.map((team, index) => ({ team: { id: String(index + 1), displayName: team.strTeam } })) }] }] });
    if (failTeam && url.includes('/teams/30/')) return new Response('', { status: 503 });
    return Response.json({ events: url.includes('seasontype=2') ? [event] : [] });
  };
  return { fetchImpl, calls };
}

test('NBA timeout falls back to all ESPN team schedules, deduplicates games and retains calendar IDs', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-nba-fallback-'));
  const { fetchImpl, calls } = fallbackFixture();
  const options = { fetchImpl, outputDir, now: new Date('2026-09-23T00:00:00Z'), requestOptions: { attempts: 1 } };
  try {
    const result = await fetchNbaSchedules(options);
    assert.equal(result.games, 1);
    assert.equal(result.writtenTeams, 2);
    assert.equal(calls.filter(url => url.includes('/schedule?season=2027')).length, 90);
    assert.ok(calls.some(url => url.startsWith('https://site.web.api.espn.com/')));
    const filePath = path.join(outputDir, '100000.json');
    const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(data.events[0].dateEvent, '2026-10-02');
    assert.equal(data.events[0].strTVStation, 'NBA TV');
    data.events[0].idEvent = 'scraped-original-nba-id';
    await fs.writeFile(filePath, JSON.stringify(data));
    const before = await fs.readFile(filePath, 'utf8');
    assert.equal((await fetchNbaSchedules(options)).writtenTeams, 0);
    assert.equal(await fs.readFile(filePath, 'utf8'), before);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('a partial ESPN failure leaves every saved schedule unchanged', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-nba-failure-'));
  const { fetchImpl } = fallbackFixture({ failTeam: true });
  const filePath = path.join(outputDir, '100000.json');
  const original = '{"events":[{"idEvent":"saved"}]}\n';
  try {
    await fs.writeFile(filePath, original);
    await assert.rejects(fetchNbaSchedules({ fetchImpl, outputDir, now: new Date('2026-09-23T00:00:00Z'), requestOptions: { attempts: 1 } }), /Both NBA and ESPN schedule sources failed/);
    assert.deepEqual(await fs.readdir(outputDir), ['100000.json']);
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('truncated team lookup uses saved NBA IDs and rejects an incomplete saved mapping', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-nba-teams-'));
  const leagueFile = path.join(outputDir, 'league.json');
  const events = Array.from({ length: 30 }, (_, index) => ({
    idHomeTeam: String(100000 + index),
    strHomeTeam: index === 0 ? 'Boston Celtics' : index === 1 ? 'New York Knicks' : `Inactive Team ${index}`
  }));
  const fetchImpl = async url => Response.json(url.includes('thesportsdb') ? { teams: [] } : schedule);
  try {
    await fs.writeFile(leagueFile, JSON.stringify({ leagueId: '4387', events }));
    const result = await fetchNbaSchedules({ fetchImpl, leagueFile, outputDir, now: new Date('2026-09-23T00:00:00Z') });
    assert.equal(result.teams, 30);
    assert.equal(result.writtenTeams, 2);
    const before = await fs.readFile(path.join(outputDir, '100000.json'), 'utf8');
    await fs.writeFile(leagueFile, JSON.stringify({ leagueId: '4387', events: events.slice(0, 10) }));
    await assert.rejects(fetchNbaSchedules({ fetchImpl, leagueFile, outputDir }), /Expected 30 saved NBA team IDs, received 10/);
    assert.equal(await fs.readFile(path.join(outputDir, '100000.json'), 'utf8'), before);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

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
