import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSportsDbClient, currentSeasonFromResponse, fetchLeagueSchedule, LEAGUES, main, nflKickoffTimestamp, saveSupplementalSchedule, teamsFromResponse } from '../scripts/fetch-sports.js';
import { SOURCE_RULES, validateData } from '../scripts/validate-fetch-output.js';

const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

function fakeClient(fetchImpl, options = {}) {
  let time = Date.parse('2026-09-29T12:00:00Z');
  const starts = [];
  const waits = [];
  const warnings = [];
  const client = createSportsDbClient({
    fetchImpl: async (url, init) => {
      starts.push(time);
      return fetchImpl(url, init, time);
    },
    now: () => time,
    sleepImpl: async ms => { waits.push(ms); time += ms; },
    logger: { warn: message => warnings.push(message) },
    ...options
  });
  return { client, starts, waits, warnings };
}

const leaguePayload = id => ({ leagues: [{ idLeague: id, strLeague: id === '4387' ? 'NBA' : 'UEFA Europa League', strCurrentSeason: '2026-2027' }] });
const event = (leagueId, id = 'event-1') => ({ idEvent: id, idLeague: leagueId, dateEvent: '2026-10-05', strEvent: 'Home vs Away', intHomeScore: '3' });

async function tempDataDir(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-sports-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function scheduleApi(id, { teams, teamError, calls = [] } = {}) {
  return async url => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname.endsWith('/lookupleague.php')) return leaguePayload(id);
    if (parsed.pathname.endsWith('/eventsround.php')) return { events: parsed.searchParams.get('r') === '1' ? [event(id)] : null };
    if (parsed.pathname.endsWith('/search_all_teams.php')) {
      if (teamError) throw teamError;
      return { teams };
    }
    throw new Error(`Unexpected request ${url}`);
  };
}

test('requires a non-empty league response with a usable current season', () => {
  assert.throws(() => currentSeasonFromResponse('4328', {}), /no league record/);
  assert.throws(() => currentSeasonFromResponse('4328', { leagues: [] }), /no league record/);
  assert.throws(() => currentSeasonFromResponse('4328', { leagues: [{}] }), /no current season/);
  assert.throws(() => currentSeasonFromResponse('4328', { leagues: [{ strCurrentSeason: '  ' }] }), /no current season/);
  assert.throws(() => currentSeasonFromResponse('4328', leaguePayload('4387')), /received league 4387/);
  assert.equal(currentSeasonFromResponse('4328', { leagues: [{ strCurrentSeason: '2026-2027' }] }), '2026-2027');
});

test('uses the verified NCAA Division 1 Football league ID', () => {
  assert.equal(LEAGUES.find(league => league.name === 'NCAA Football').id, '4479');
  assert.ok(!LEAGUES.some(league => league.id === '4392'));
});

test('converts NFL Eastern kickoff times to UTC in both daylight and standard time', () => {
  assert.equal(nflKickoffTimestamp('2026-10-04', '13:00'), '2026-10-04T17:00:00Z');
  assert.equal(nflKickoffTimestamp('2026-11-08', '13:00:00'), '2026-11-08T18:00:00Z');
  assert.equal(nflKickoffTimestamp('2026-10-08', '20:15'), '2026-10-09T00:15:00Z');
  assert.equal(nflKickoffTimestamp('2026-12-10', '20:15'), '2026-12-11T01:15:00Z');
});

test('handles a DST transition and rejects invalid NFL kickoff values', () => {
  assert.equal(nflKickoffTimestamp('2026-03-08', '03:30'), '2026-03-08T07:30:00Z');
  assert.throws(() => nflKickoffTimestamp('2026-02-30', '13:00'), /Invalid NFL kickoff date/);
  assert.throws(() => nflKickoffTimestamp('2026-10-04', '25:00'), /Invalid NFL kickoff/);
  assert.throws(() => nflKickoffTimestamp('2026-10-04', 'TBD'), /Invalid NFL kickoff/);
  assert.throws(() => nflKickoffTimestamp('2026-03-08', '02:30'), /Unresolvable Eastern kickoff/);
});

test('paces concurrent lookups and all three empty round requests', async () => {
  const { client, starts } = fakeClient(async url => jsonResponse(url.includes('lookupleague') ? leaguePayload('4481') : { events: null }));
  const [schedule] = await Promise.all([
    fetchLeagueSchedule('4481', { fetchJsonImpl: client }),
    client('https://example.test/teams')
  ]);
  assert.deepEqual(schedule.events, []);
  assert.equal(starts.length, 5);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 2500);
});

test('waits a full cooldown on 429 and honors Retry-After seconds', async () => {
  let attempts = 0;
  const { client, waits } = fakeClient(async () => ++attempts === 1
    ? jsonResponse({}, 429, { 'Retry-After': '90' })
    : jsonResponse({ recovered: true }));
  assert.deepEqual(await client('https://example.test/schedule'), { recovered: true });
  assert.deepEqual(waits, [90_000]);
});

test('honors an HTTP-date Retry-After header', async () => {
  let attempts = 0;
  const { client, waits } = fakeClient(async (_url, _init, time) => ++attempts === 1
    ? jsonResponse({}, 429, { 'Retry-After': new Date(time + 120_000).toUTCString() })
    : jsonResponse({ recovered: true }));
  await client('https://example.test/schedule');
  assert.deepEqual(waits, [120_000]);
});

test('bounds repeated rate-limit retries and keeps the queue usable after a failure', async () => {
  let attempts = 0;
  const { client, waits } = fakeClient(async url => {
    attempts++;
    return jsonResponse({}, url.endsWith('/unavailable') ? 429 : 200);
  }, { maxRetries: 2 });
  await assert.rejects(client('https://example.test/unavailable'), /429/);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [60_000, 60_000]);
  assert.deepEqual(await client('https://example.test/recovered'), {});
});

test('clears the old timeout before sleeping for the next attempt', async () => {
  const signals = [];
  const { client } = fakeClient(async (_url, { signal }) => {
    signals.push(signal);
    return signals.length === 1 ? jsonResponse({}, 429) : jsonResponse({ recovered: true });
  }, {
    timeoutMs: 5,
    requestIntervalMs: 0,
    sleepImpl: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(signals[0].aborted, false);
    }
  });
  await client('https://example.test/schedule');
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1].aborted, false);
});

test('retries request timeouts with a fresh abort signal', async () => {
  const signals = [];
  const { client } = fakeClient(async (_url, { signal }) => {
    signals.push(signal);
    if (signals.length === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true }));
    return jsonResponse({ recovered: true });
  }, { timeoutMs: 5, maxRetries: 1 });
  assert.deepEqual(await client('https://example.test/schedule'), { recovered: true });
  assert.equal(signals[0].aborted, true);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1].aborted, false);
});

test('retries transient server failures but rejects permanent HTTP errors', async () => {
  let attempts = 0;
  const { client } = fakeClient(async () => jsonResponse({}, ++attempts === 1 ? 503 : 200));
  await client('https://example.test/schedule');
  assert.equal(attempts, 2);
  let permanentAttempts = 0;
  const permanent = fakeClient(async () => { permanentAttempts++; return jsonResponse({}, 404); }).client;
  await assert.rejects(permanent('https://example.test/missing'), /404/);
  assert.equal(permanentAttempts, 1);
});

test('rejects malformed round responses instead of treating them as an empty offseason', async () => {
  for (const payload of [{}, { events: {} }, null]) {
    await assert.rejects(fetchLeagueSchedule('4481', {
      fetchJsonImpl: async url => url.includes('lookupleague') ? leaguePayload('4481') : payload
    }), /Malformed round/);
  }
});

test('deduplicates rounds by stable event ID and rejects unrelated events', async () => {
  const schedule = await fetchLeagueSchedule('4481', {
    fetchJsonImpl: async url => {
      if (url.includes('lookupleague')) return leaguePayload('4481');
      return { events: Number(new URL(url).searchParams.get('r')) <= 2 ? [event('4481')] : [] };
    }
  });
  assert.equal(schedule.events.length, 1);
  await assert.rejects(fetchLeagueSchedule('4481', {
    fetchJsonImpl: async url => url.includes('lookupleague') ? leaguePayload('4481') : { events: [event('4328')] }
  }), /wrong league/);
});

test('rejects team lookup results from another sport or league', () => {
  const teams = [{ idTeam: '134865', strTeam: 'Golden State Warriors', idLeague: '4387' }];
  assert.equal(teamsFromResponse('4387', { teams }), teams);
  assert.throws(() => teamsFromResponse('4387', { teams: [{ idTeam: '133607', strTeam: 'Wigan Athletic', idLeague: '4396' }] }), /unrelated teams/);
  assert.throws(() => teamsFromResponse('4387', { teams: null }), /no valid teams/);
});

test('refreshes Europa League without an unnecessary team lookup and produces valid stable output', async t => {
  const dataDir = await tempDataDir(t);
  const calls = [];
  const options = { leagues: [{ id: '4481', name: 'UEFA Europa League' }], dataDir, firecrawlApiKey: '', fetchJsonImpl: scheduleApi('4481', { calls }) };
  await main(options);
  assert.ok(!calls.some(url => url.pathname.includes('teams')));
  const file = path.join(dataDir, '4481.json');
  const before = await fs.readFile(file, 'utf8');
  const data = JSON.parse(before);
  assert.equal(data.events[0].intHomeScore, undefined);
  assert.deepEqual(validateData({ file, current: data, rule: SOURCE_RULES.sports }), []);
  await main(options);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('refreshes dedicated league caches without entering legacy supplemental discovery', async t => {
  for (const [id, name] of [['4380', 'NHL'], ['4346', 'MLS']]) {
    const dataDir = await tempDataDir(t);
    const calls = [];
    await main({
      leagues: [{ id, name }], dataDir, firecrawlApiKey: 'configured',
      fetchJsonImpl: scheduleApi(id, { calls }),
      supplementalFetcher: () => assert.fail(`dedicated ${name} fetcher owns supplemental output`)
    });
    assert.ok(await fs.readFile(path.join(dataDir, `${id}.json`), 'utf8'));
    assert.ok(!calls.some(url => url.pathname.includes('teams')));
  }
});

test('a failed optional team lookup keeps saved supplemental data and permits league output', async t => {
  const dataDir = await tempDataDir(t);
  const supplementalDir = path.join(dataDir, 'supplemental');
  await fs.mkdir(supplementalDir);
  const savedFile = path.join(supplementalDir, '134865.json');
  const saved = JSON.stringify({ events: [event('4387')] });
  await fs.writeFile(savedFile, saved);
  await main({
    leagues: [{ id: '4387', name: 'NBA' }], dataDir, firecrawlApiKey: '',
    fetchJsonImpl: scheduleApi('4387', { teamError: new Error('Rate limit exceeded (429)') }),
    supplementalFetcher: () => assert.fail('must not enrich when team discovery fails')
  });
  assert.equal(await fs.readFile(savedFile, 'utf8'), saved);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, '4387.json'), 'utf8')).events.length, 1);
});

test('uses the canonical team-search endpoint and isolates an optional CSV failure', async t => {
  const dataDir = await tempDataDir(t);
  const calls = [];
  let supplementalCalls = 0;
  await main({
    leagues: [{ id: '4387', name: 'NBA' }], dataDir, firecrawlApiKey: '',
    fetchJsonImpl: scheduleApi('4387', { teams: [{ idTeam: '134865', strTeam: 'Golden State Warriors', idLeague: '4387' }], calls }),
    supplementalFetcher: async () => { supplementalCalls++; throw new Error('CSV unavailable'); }
  });
  assert.equal(supplementalCalls, 1);
  assert.equal(calls.find(url => url.pathname.endsWith('search_all_teams.php')).searchParams.get('l'), 'NBA');
  assert.ok(!calls.some(url => url.pathname.endsWith('lookup_all_teams.php')));
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, '4387.json'), 'utf8')).events.length, 1);
});

test('rejects an outdated supplemental season before it can erase upcoming games', async t => {
  const dataDir = await tempDataDir(t);
  const file = path.join(dataDir, '134865.json');
  const saved = JSON.stringify({
    teamId: '134865', teamName: 'Golden State Warriors',
    events: Array.from({ length: 10 }, (_, i) => ({ ...event('4387', `upcoming-${i}`), dateEvent: '2099-10-05' }))
  });
  await fs.writeFile(file, saved);
  await assert.rejects(saveSupplementalSchedule(file, {
    teamId: '134865', teamName: 'Golden State Warriors',
    events: [{ ...event('4387'), dateEvent: '2025-10-05' }]
  }), /suspicious upcoming-event drop from 10 to 0/);
  assert.equal(await fs.readFile(file, 'utf8'), saved);
});

test('rejects invalid optional dates and duplicate IDs before writing any file', async t => {
  const dataDir = await tempDataDir(t);
  const file = path.join(dataDir, '134865.json');
  await assert.rejects(saveSupplementalSchedule(file, { events: [{ ...event('4387'), dateEvent: '2026-02-30' }] }), /invalid date/);
  await assert.rejects(saveSupplementalSchedule(file, { events: [event('4387'), event('4387')] }), /duplicate event ID/);
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

test('saves a valid supplemental update without changing its timestamp on an identical fetch', async t => {
  const dataDir = await tempDataDir(t);
  const file = path.join(dataDir, '134865.json');
  const data = { teamId: '134865', teamName: 'Golden State Warriors', events: [event('4387')] };
  await saveSupplementalSchedule(file, data);
  const before = await fs.readFile(file, 'utf8');
  await saveSupplementalSchedule(file, data);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('required league failures still fail the refresh and leave its saved schedule intact', async t => {
  const dataDir = await tempDataDir(t);
  const savedFile = path.join(dataDir, '4479.json');
  const saved = JSON.stringify({ events: [event('4479')] });
  await fs.writeFile(savedFile, saved);
  await assert.rejects(main({
    leagues: [{ id: '4479', name: 'NCAA Football' }], dataDir, firecrawlApiKey: '',
    fetchJsonImpl: async () => ({ leagues: null })
  }), /Sports refresh incomplete \(1\/1 leagues failed\)/);
  assert.equal(await fs.readFile(savedFile, 'utf8'), saved);
});
