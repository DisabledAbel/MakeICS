import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchNhlSchedules, mapActiveTeams, NHL_TEAMS, parseSchedule, seasonCandidates } from '../scripts/fetch-nhl.js';
import { toIcs as sportsToIcs } from '../lib/sports.js';
import { toIcs as combinedToIcs } from '../lib/calendar.js';

const standings = () => ({ standings: NHL_TEAMS.map(team => ({ teamAbbrev: { default: team.abbrev }, teamName: { default: team.name } })) });
const game = (overrides = {}) => ({ id: 2026020001, gameType: 2, gameDate: '2026-10-11', startTimeUTC: '2026-10-12T02:30:00Z', gameState: 'FUT', venue: { default: 'Climate Pledge Arena' }, homeTeam: { abbrev: 'SEA' }, awayTeam: { abbrev: 'ANA' }, tvBroadcasts: [{ network: 'ESPN+' }], ...overrides });
const response = value => ({ ok: true, json: async () => value });

test('maps all active NHL teams and explicit current alias without fuzzy ambiguity', () => {
  const payload = standings();
  payload.standings.find(row => row.teamAbbrev.default === 'UTA').teamName.default = 'Utah Hockey Club';
  assert.equal(mapActiveTeams(payload).find(team => team.abbrev === 'UTA').name, 'Utah Mammoth');
  assert.throws(() => mapActiveTeams({ standings: payload.standings.map((row, i) => i ? row : { teamAbbrev: { default: 'XXX' }, teamName: { default: 'New York' } }) }), /not found/);
});

test('discovers transition seasons from the clock rather than a fixed year', () => {
  assert.deepEqual(seasonCandidates(new Date('2026-07-01T00:00:00Z')), ['20252026', '20262027', '20272028']);
});

test('normalizes Pacific date, UTC instant, broadcast, status, and retains distinct same-team games', () => {
  const teams = mapActiveTeams(standings());
  const games = parseSchedule({ games: [game(), game({ id: 2026020002, startTimeUTC: '2026-10-12T05:30:00Z' })] }, teams, new Date('2026-10-01T00:00:00Z'));
  assert.equal(games[0].officialDate, '2026-10-11');
  assert.equal(games[0].date, '2026-10-12T02:30:00Z');
  assert.equal(games[0].broadcast, 'ESPN+');
  assert.equal(games.length, 2);
});

test('normalizes broadcast networks independently of club ordering and duplicates', () => {
  const homeBroadcasts = [{ network: 'Prime Video' }, { network: 'KCOP-13' }, { network: 'NESN' }];
  const awayBroadcasts = [{ network: 'NESN' }, { network: 'Prime Video' }, { network: 'KCOP-13' }, { network: 'NESN' }, {}];
  const now = new Date('2026-10-01T00:00:00Z');
  const home = parseSchedule({ games: [game({ tvBroadcasts: homeBroadcasts })] }, NHL_TEAMS, now);
  const away = parseSchedule({ games: [game({ tvBroadcasts: awayBroadcasts })] }, NHL_TEAMS, now);
  assert.deepEqual(home, away);
  assert.equal(home[0].broadcast, 'KCOP-13, NESN, Prime Video');
  assert.equal(parseSchedule({ games: [game({ tvBroadcasts: [] })] }, NHL_TEAMS, now)[0].broadcast, null);
});

test('different club broadcast order deduplicates the game and does not rewrite schedules', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nhl-broadcast-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let networks = ['Prime Video', 'KCOP-13', 'NESN'];
  const fetchImpl = async url => {
    if (url.endsWith('/standings/now')) return response(standings());
    const isHome = url.includes('/SEA/');
    const games = (isHome || url.includes('/ANA/')) && url.endsWith('/20262027')
      ? [game({ id: 2026020120, tvBroadcasts: (isHome ? networks : [...networks].reverse()).map(network => ({ network })) })]
      : [];
    return response({ games });
  };
  const first = await fetchNhlSchedules({ fetchImpl, outputDir: dir, now: new Date('2026-10-01T00:00:00Z'), requestOptions: { attempts: 1 } });
  assert.equal(first.games, 1);
  assert.equal(first.writtenTeams, 2);
  const files = ['140082.json', '134846.json'];
  const before = await Promise.all(files.map(file => fs.readFile(path.join(dir, file), 'utf8')));
  for (const contents of before) {
    const { events } = JSON.parse(contents);
    assert.equal(events.length, 1);
    assert.equal(events[0].idEvent, 'nhl-2026020120');
    assert.equal(events[0].strTVStation, 'KCOP-13, NESN, Prime Video');
  }
  networks = ['NESN', 'Prime Video', 'KCOP-13'];
  const second = await fetchNhlSchedules({ fetchImpl, outputDir: dir, now: new Date('2026-10-01T06:00:00Z'), requestOptions: { attempts: 1 } });
  assert.equal(second.writtenTeams, 0);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(path.join(dir, file), 'utf8'))), before);
});

test('genuine duplicate game conflicts still reject the fetch before any schedules are written', async t => {
  for (const overrides of [
    { startTimeUTC: '2026-10-12T03:30:00Z' },
    { awayTeam: { abbrev: 'BOS' } },
    { tvBroadcasts: [{ network: 'NESN' }] }
  ]) {
    await t.test(JSON.stringify(overrides), async t => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nhl-conflict-'));
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const file = path.join(dir, '140082.json');
      await fs.writeFile(file, 'saved');
      const fetchImpl = async url => {
        if (url.endsWith('/standings/now')) return response(standings());
        const games = url.endsWith('/20262027')
          ? url.includes('/SEA/') ? [game()] : url.includes('/ANA/') ? [game(overrides)] : []
          : [];
        return response({ games });
      };
      await assert.rejects(fetchNhlSchedules({ fetchImpl, outputDir: dir, now: new Date('2026-10-01'), requestOptions: { attempts: 1 } }), /Conflicting NHL records for game 2026020001/);
      assert.equal(await fs.readFile(file, 'utf8'), 'saved');
      assert.deepEqual(await fs.readdir(dir), ['140082.json']);
    });
  }
});

test('complete club schedules deduplicate by NHL ID, are unchanged on rerun, and reschedule in place', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nhl-'));
  const now = new Date('2026-10-01T00:00:00Z');
  let current = game();
  const fetchImpl = async url => response(url.endsWith('/standings/now') ? standings() : { games: url.includes('/SEA/') || url.includes('/ANA/') ? [current] : [] });
  const first = await fetchNhlSchedules({ fetchImpl, outputDir: dir, now, requestOptions: { attempts: 1 } });
  assert.equal(first.games, 1);
  const file = path.join(dir, '140082.json');
  const before = await fs.readFile(file, 'utf8');
  const second = await fetchNhlSchedules({ fetchImpl, outputDir: dir, now: new Date('2026-10-01T06:00:00Z'), requestOptions: { attempts: 1 } });
  assert.equal(second.writtenTeams, 0);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  current = game({ startTimeUTC: '2026-10-12T03:30:00Z' });
  await fetchNhlSchedules({ fetchImpl, outputDir: dir, now: new Date('2026-10-01T12:00:00Z'), requestOptions: { attempts: 1 } });
  const changed = JSON.parse(await fs.readFile(file));
  assert.equal(changed.events[0].idEvent, 'nhl-2026020001');
  assert.equal(changed.events[0].strTimestamp, '2026-10-12T03:30:00Z');
});

test('failed or malformed retrieval preserves saved data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nhl-fail-'));
  const file = path.join(dir, '140082.json');
  await fs.writeFile(file, 'saved');
  const fetchImpl = async url => url.endsWith('/standings/now') ? response(standings()) : { ok: false, status: 503, body: { cancel: async () => {} } };
  await assert.rejects(fetchNhlSchedules({ fetchImpl, outputDir: dir, now: new Date('2026-10-01'), requestOptions: { attempts: 1 } }), /HTTP 503/);
  assert.equal(await fs.readFile(file, 'utf8'), 'saved');
});

test('a migrated legacy UID remains stable when the NHL later reschedules the game', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nhl-migrate-'));
  const file = path.join(dir, '140082.json');
  await fs.writeFile(file, JSON.stringify({ teamId: '140082', events: [{ idEvent: 'legacy-uid', dateEvent: '2026-10-11', strHomeTeam: 'Seattle Kraken', strAwayTeam: 'Anaheim Ducks' }] }));
  let current = game();
  const fetchImpl = async url => response(url.endsWith('/standings/now') ? standings() : { games: url.includes('/SEA/') || url.includes('/ANA/') ? [current] : [] });
  await fetchNhlSchedules({ fetchImpl, outputDir: dir, now: new Date('2026-10-01'), requestOptions: { attempts: 1 } });
  current = game({ gameDate: '2026-10-12', startTimeUTC: '2026-10-13T02:30:00Z' });
  await fetchNhlSchedules({ fetchImpl, outputDir: dir, now: new Date('2026-10-02'), requestOptions: { attempts: 1 } });
  const saved = JSON.parse(await fs.readFile(file));
  assert.equal(saved.events[0].idEvent, 'legacy-uid');
  assert.equal(saved.events[0].sourceEventId, '2026020001');
});

test('legacy migration never assigns one saved UID to competing NHL games', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nhl-ambiguous-'));
  const file = path.join(dir, '140082.json');
  await fs.writeFile(file, JSON.stringify({ teamId: '140082', events: [{ idEvent: 'legacy-uid', dateEvent: '2026-10-11', strHomeTeam: 'Seattle Kraken', strAwayTeam: 'Anaheim Ducks' }] }));
  const games = [game(), game({ id: 2026020002, startTimeUTC: '2026-10-12T05:30:00Z' })];
  const fetchImpl = async url => response(url.endsWith('/standings/now') ? standings() : { games: url.includes('/SEA/') || url.includes('/ANA/') ? games : [] });
  await fetchNhlSchedules({ fetchImpl, outputDir: dir, now: new Date('2026-10-01'), requestOptions: { attempts: 1 } });
  const saved = JSON.parse(await fs.readFile(file));
  assert.deepEqual(saved.events.map(event => event.idEvent), ['nhl-2026020001', 'nhl-2026020002']);
});

test('NHL team and combined calendars advertise six-hour refreshes', () => {
  const sports = sportsToIcs({ team: { sport: 'Ice Hockey' }, events: [{ id: '1', name: 'Game', league: 'NHL', timestamp: '2026-10-12T02:30:00Z', date: '2026-10-11', time: '19:30:00' }] });
  assert.match(sports, /X-PUBLISHED-TTL:PT6H/);
  const combined = combinedToIcs({ calendar: { timezone: 'America/Los_Angeles' }, events: [{ uid: '1', type: 'sports', title: 'Game', description: 'NHL', start: '2026-10-12T02:30:00Z', end: '2026-10-12T05:00:00Z', allDay: false, location: '', metadata: { league: 'NHL' } }] });
  assert.match(combined, /REFRESH-INTERVAL;VALUE=DURATION:PT6H/);
});
