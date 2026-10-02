import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchMlsSchedules, mapActiveTeams, MLS_TEAMS, parseSchedule, seasonCandidates } from '../scripts/fetch-mls.js';
import { toIcs as sportsToIcs } from '../lib/sports.js';
import { toIcs as combinedToIcs } from '../lib/calendar.js';

const response = body => ({ ok: true, status: 200, json: async () => body });
const directory = () => ({ sports: [{ leagues: [{ slug: 'usa.1', name: 'Major League Soccer', teams: MLS_TEAMS.map((team, index) => ({ team: {
  id: String(9000 + index),
  // Exercise the explicitly required provider-name differences.
  displayName: team.name === 'Los Angeles FC' ? 'LAFC' : team.name === 'D.C. United' ? 'DC United' : team.name === 'New York Red Bulls' ? 'Red Bull New York' : team.name
} })) }] }] });
const teamByName = name => ({ ...MLS_TEAMS.find(team => team.name === name), espnId: String(9000 + MLS_TEAMS.findIndex(team => team.name === name)) });
const fixture = ({ id = '401999001', date = '2026-04-12T23:30:00Z', venue = 'Providence Park', status = { state: 'pre', name: 'STATUS_SCHEDULED' } } = {}) => ({
  id, date,
  competitions: [{
    competitors: [
      { homeAway: 'home', team: { id: teamByName('Portland Timbers').espnId } },
      { homeAway: 'away', team: { id: teamByName('FC Dallas').espnId } }
    ],
    venue: { fullName: venue }, status: { type: status }, broadcasts: [{ names: ['MLS Season Pass'] }]
  }]
});
const schedule = (events, year = 2026) => ({ season: { year }, league: { slug: 'usa.1', name: 'Major League Soccer', abbreviation: 'MLS' }, events });

function fetcher({ event = fixture(), malformedTeam = null, calls = [] } = {}) {
  return async url => {
    calls.push(url);
    if (url.includes('/teams?')) return response(directory());
    const id = /\/teams\/(\d+)\/schedule/.exec(url)?.[1];
    const year = Number(new URL(url).searchParams.get('season'));
    if (id === malformedTeam) return response({ season: { year }, league: { name: 'Major League Soccer' } });
    return response(schedule([event], year));
  };
}

test('maps every active MLS club to stable TheSportsDB IDs with explicit aliases', () => {
  const teams = mapActiveTeams(directory());
  assert.equal(teams.length, 30);
  assert.equal(new Set(teams.map(team => team.id)).size, 30);
  assert.equal(teams.find(team => team.name === 'FC Dallas').id, '134146');
  const ambiguous = directory();
  ambiguous.sports[0].leagues[0].teams[0].team.displayName = 'Unknown FC';
  assert.throws(() => mapActiveTeams(ambiguous), /not found/);
});

test('uses fixture=true, calendar-year seasons, and starts next-season discovery in November', async () => {
  assert.deepEqual(seasonCandidates(new Date('2026-10-31T23:59:59Z')), [2026]);
  assert.deepEqual(seasonCandidates(new Date('2026-11-01T00:00:00Z')), [2026, 2027]);
  const calls = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-mls-'));
  await fetchMlsSchedules({ fetchImpl: fetcher({ calls }), outputDir: dir, now: new Date('2026-04-01T00:00:00Z') });
  const scheduleCalls = calls.filter(url => url.includes('/schedule'));
  assert.equal(scheduleCalls.length, 30);
  assert.ok(scheduleCalls.every(url => url.endsWith('season=2026&fixture=true')));
});

test('parses upcoming playoff-compatible fixtures and rejects malformed season or league responses', () => {
  const teams = mapActiveTeams(directory());
  const byEspnId = new Map(teams.map(team => [team.espnId, team]));
  const events = parseSchedule(schedule([fixture()]), { season: 2026, byEspnId, now: new Date('2026-04-01') });
  assert.equal(events[0].idEvent, 'mls-401999001');
  assert.equal(events[0].idHomeTeam, '134155');
  assert.equal(events[0].idAwayTeam, '134146');
  assert.equal(events[0].strTimestamp, '2026-04-12T23:30:00Z');
  assert.equal(events[0].strTVStation, 'MLS Season Pass');
  assert.throws(() => parseSchedule({ ...schedule([]), season: { year: 2025 } }, { season: 2026, byEspnId }), /season 2025/);
  assert.throws(() => parseSchedule({ ...schedule([]), league: { name: 'Premier League' } }, { season: 2026, byEspnId }), /did not identify/);
});

test('deduplicates responses, clears inactive teams, preserves reschedule identity, and leaves unchanged reruns untouched', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-mls-'));
  const now = new Date('2026-04-01T00:00:00Z');
  const inactiveFile = path.join(dir, '135851.json');
  await fs.writeFile(inactiveFile, `${JSON.stringify({ teamId: '135851', teamName: 'Atlanta United', events: [{ idEvent: 'stale-fixture' }] })}\n`);
  const first = await fetchMlsSchedules({ fetchImpl: fetcher(), outputDir: dir, now });
  assert.deepEqual(first, { teams: 30, fixtures: 1, writtenTeams: 30 });
  assert.deepEqual(JSON.parse(await fs.readFile(inactiveFile, 'utf8')).events, []);
  const file = path.join(dir, '134155.json');
  const original = await fs.readFile(file, 'utf8');
  const rerun = await fetchMlsSchedules({ fetchImpl: fetcher(), outputDir: dir, now: new Date('2026-04-02T00:00:00Z') });
  assert.equal(rerun.writtenTeams, 0);
  assert.equal(await fs.readFile(file, 'utf8'), original);

  await fetchMlsSchedules({ fetchImpl: fetcher({ event: fixture({ date: '2026-04-13T01:30:00Z', venue: 'Rescheduled Field', status: { state: 'pre', description: 'Postponed' } }) }), outputDir: dir, now });
  const changed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(changed.events.length, 1);
  assert.equal(changed.events[0].idEvent, 'mls-401999001');
  assert.equal(changed.events[0].strVenue, 'Rescheduled Field');
  assert.equal(changed.events[0].strStatus, 'Postponed');
});

test('malformed, failed, and unexpectedly empty retrievals preserve saved schedules', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-mls-'));
  const file = path.join(dir, '134155.json');
  await fs.writeFile(file, '{"sentinel":true}\n');
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(fetchMlsSchedules({ fetchImpl: fetcher({ malformedTeam: '9000' }), outputDir: dir, now: new Date('2026-04-01'), requestOptions: { attempts: 1 } }), /did not contain events/);
  assert.equal(await fs.readFile(file, 'utf8'), before);

  const failed = async url => url.includes('/teams?') ? response(directory()) : ({ ok: false, status: 503, body: { cancel: async () => {} } });
  await assert.rejects(fetchMlsSchedules({ fetchImpl: failed, outputDir: dir, now: new Date('2026-04-01'), requestOptions: { attempts: 1 } }), /HTTP 503/);
  assert.equal(await fs.readFile(file, 'utf8'), before);

  await assert.rejects(fetchMlsSchedules({ fetchImpl: fetcher({ event: fixture({ date: '2026-03-01T00:00:00Z', status: { state: 'post', completed: true } }) }), outputDir: dir, now: new Date('2026-04-01') }), /no upcoming fixtures/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('MLS team and combined calendars consume normalized fixtures', () => {
  const teamIcs = sportsToIcs({ team: { sport: 'Soccer' }, events: [{ id: 'mls-1', sourceEventId: '1', name: 'Portland Timbers vs FC Dallas', league: 'MLS', timestamp: '2026-04-12T23:30:00Z', date: '2026-04-12', time: '23:30:00', venue: 'Providence Park' }] });
  assert.match(teamIcs, /SUMMARY:Portland Timbers vs FC Dallas/);
  assert.match(teamIcs, /DTSTART:20260412T233000Z/);
  const combined = combinedToIcs({ calendar: { timezone: 'UTC' }, events: [{ uid: 'sports-mls-1', type: 'sports', title: 'Portland Timbers vs FC Dallas', description: 'MLS', start: '2026-04-12T23:30:00Z', end: '2026-04-13T01:20:00Z', allDay: false, location: 'Providence Park', metadata: { league: 'MLS' } }] });
  assert.match(combined, /UID:sports-mls-1/);
  assert.match(combined, /LOCATION:Providence Park/);
});
