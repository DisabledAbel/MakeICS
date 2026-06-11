import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchTeamSuggestions, getUpcomingEvents, toIcs } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '../lib/data/sports');

const teamPayload = {
  teams: [
    {
      idTeam: '133604',
      strTeam: 'Arsenal',
      strSport: 'Soccer',
      strLeague: 'English Premier League',
      idLeague: '4328',
      strCountry: 'England',
      strBadge: 'https://example.test/badge.png',
      strWebsite: 'www.arsenal.com',
      strDescriptionEN: 'Arsenal Football Club...'
    }
  ]
};

const leaguePayload = {
  leagues: [
    {
      idLeague: '4328',
      strLeague: 'English Premier League',
      strCurrentSeason: '2024-2025'
    }
  ]
};

const seasonEventsPayload = {
  events: [
    {
      idEvent: '1',
      strEvent: 'Arsenal vs Everton',
      idHomeTeam: '133604',
      idAwayTeam: '133615',
      strHomeTeam: 'Arsenal',
      strAwayTeam: 'Everton',
      dateEvent: '2026-08-05',
      strTime: '18:30:00',
      strTimestamp: '2026-08-05T18:30:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Emirates Stadium',
      strStatus: 'NS'
    },
    {
      idEvent: '3',
      strEvent: 'Chelsea vs Arsenal',
      idHomeTeam: '133610',
      idAwayTeam: '133604',
      strHomeTeam: 'Chelsea',
      strAwayTeam: 'Arsenal',
      dateEvent: '2026-08-12',
      strTime: '20:00:00',
      strTimestamp: '2026-08-12T20:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Stamford Bridge',
      strStatus: 'NS'
    }
  ]
};

const nextEventsPayload = {
  events: [
    {
      idEvent: '1', // Duplicate of season event
      strEvent: 'Arsenal vs Everton',
      strHomeTeam: 'Arsenal',
      strAwayTeam: 'Everton',
      dateEvent: '2026-08-05',
      strTime: '18:30:00',
      strTimestamp: '2026-08-05T18:30:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Emirates Stadium',
      strStatus: 'NS'
    },
    {
      idEvent: '4', // Non-league event (e.g. Friendly)
      strEvent: 'Arsenal vs Real Betis',
      strHomeTeam: 'Arsenal',
      strAwayTeam: 'Real Betis',
      dateEvent: '2026-07-31',
      strTime: '23:30:00',
      strTimestamp: '2026-07-31T23:30:00Z',
      strLeague: 'Club Friendlies',
      strVenue: 'TBA',
      strStatus: 'NS'
    }
  ]
};

function createFetchMock(onCall) {
  return async (url) => {
    if (onCall) onCall(url);
    if (url.includes('searchteams.php')) {
      return Response.json(teamPayload);
    }
    if (url.includes('lookupteam.php')) {
      return Response.json(teamPayload);
    }
    if (url.includes('lookupleague.php')) {
      return Response.json(leaguePayload);
    }
    if (url.includes('eventsseason.php')) {
      return Response.json(seasonEventsPayload);
    }
    if (url.includes('eventsnext.php')) {
      return Response.json(nextEventsPayload);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test('searchTeamSuggestions returns team results', async () => {
  const suggestions = await searchTeamSuggestions({
    query: 'Ars',
    fetchImpl: createFetchMock()
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].name, 'Arsenal');
});

test('getUpcomingEvents returns merged and deduplicated events for a team', (t) => {
  const clock = t.mock.timers;
  clock.enable({ names: ['Date'], now: new Date('2026-01-01T00:00:00Z') });

  return t.test('merging logic', async () => {
    const result = await getUpcomingEvents({
      teamId: '133604',
      fetchImpl: createFetchMock()
    });

    assert.equal(result.team.name, 'Arsenal');
    // Should have: Arsenal vs Real Betis (4), Arsenal vs Everton (1), Chelsea vs Arsenal (3)
    // Deduplicated and sorted by date
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].id, '4');
    assert.equal(result.events[1].id, '1');
    assert.equal(result.events[2].id, '3');
  });
});

test('getUpcomingEvents utilizes local cache if available', async (t) => {
  const leagueId = '4328';
  const cacheFilePath = path.join(CACHE_DIR, `${leagueId}.json`);
  const cachedData = {
    leagueId,
    leagueName: 'English Premier League',
    updatedAt: new Date().toISOString(),
    events: [
      {
        idEvent: '999',
        strEvent: 'Arsenal vs Cached',
        idHomeTeam: '133604',
        idAwayTeam: '888',
        strHomeTeam: 'Arsenal',
        strAwayTeam: 'Cached',
        dateEvent: '2026-12-25',
        strTime: '15:00:00',
        strTimestamp: '2026-12-25T15:00:00Z',
        strLeague: 'English Premier League',
        strVenue: 'Cached Stadium',
        strStatus: 'NS'
      }
    ]
  };

  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cacheFilePath, JSON.stringify(cachedData));

  const calls = [];
  const onCall = (url) => calls.push(url);

  try {
    const result = await getUpcomingEvents({
      teamId: '133604',
      fetchImpl: createFetchMock(onCall)
    });

    // Should include cached event (999) + next events (4, 1)
    assert.ok(result.events.some(e => e.id === '999'));
    assert.equal(result.events.find(e => e.id === '999').name, 'Arsenal vs Cached');

    // Assert that lookupleague.php and eventsseason.php were NOT called
    const hasNetworkFallback = calls.some(url => url.includes('lookupleague.php') || url.includes('eventsseason.php'));
    assert.strictEqual(hasNetworkFallback, false, 'Should not hit network when cache is available');
  } finally {
    await fs.unlink(cacheFilePath).catch(() => {});
  }
});

test('getUpcomingEvents merges supplemental (scraped) data', async (t) => {
  const clock = t.mock.timers;
  clock.enable({ names: ['Date'], now: new Date('2026-01-01T00:00:00Z') });

  const teamId = '133604';
  const supplementalDir = path.join(CACHE_DIR, 'supplemental');
  const supplementalFilePath = path.join(supplementalDir, `${teamId}.json`);
  const scrapedData = {
    teamId,
    teamName: 'Arsenal',
    updatedAt: new Date().toISOString(),
    events: [
      {
        idEvent: 'scraped-2026-12-31-arsenal-vs-scraped',
        strEvent: 'Arsenal vs Scraped',
        strHomeTeam: 'Arsenal',
        strAwayTeam: 'Scraped',
        dateEvent: '2026-12-31',
        strTime: '15:00:00',
        strTimestamp: '2026-12-31T15:00:00Z',
        strLeague: 'Premier League',
        strVenue: 'Scraped Stadium',
        strStatus: 'NS',
        source: 'scraped'
      }
    ]
  };

  await fs.mkdir(supplementalDir, { recursive: true });
  await fs.writeFile(supplementalFilePath, JSON.stringify(scrapedData));

  try {
    const result = await getUpcomingEvents({
      teamId,
      fetchImpl: createFetchMock()
    });

    // Should include TSDB events (1, 3, 4) AND scraped event (scraped-...)
    assert.equal(result.events.length, 4);
    assert.ok(result.events.some(e => e.id === 'scraped-2026-12-31-arsenal-vs-scraped'));
    assert.equal(result.events.find(e => e.id.includes('scraped')).name, 'Arsenal vs Scraped');
  } finally {
    await fs.unlink(supplementalFilePath).catch(() => {});
  }
});

test('toIcs creates ICS for sports events', async (t) => {
  const clock = t.mock.timers;
  clock.enable({ names: ['Date'], now: new Date('2026-01-01T00:00:00Z') });

  const result = await getUpcomingEvents({
    teamId: '133604',
    fetchImpl: createFetchMock()
  });
  result.generatedAt = '2026-01-01T00:00:00Z';

  const ics = toIcs(result);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:Arsenal vs Everton/);
  assert.match(ics, /SUMMARY:Arsenal vs Real Betis/);
  assert.match(ics, /LOCATION:Emirates Stadium/);
});

test('getUpcomingEvents handles strTimestamp with offset correctly', async (t) => {
  const clock = t.mock.timers;
  clock.enable({ names: ['Date'], now: new Date('2026-01-01T00:00:00Z') });

  const customEventsPayload = {
    events: [
      {
        idEvent: '2',
        strEvent: 'Arsenal vs Brighton',
        strHomeTeam: 'Arsenal',
        strAwayTeam: 'Brighton',
        dateEvent: '2026-08-10',
        strTime: '15:00:00',
        strTimestamp: '2026-08-10T15:00:00+01:00',
        strLeague: 'English Premier League',
        strVenue: 'Emirates Stadium',
        strStatus: 'NS'
      }
    ]
  };

  const fetchImpl = async (url) => {
    if (url.includes('lookupteam.php')) return Response.json(teamPayload);
    if (url.includes('eventsnext.php')) return Response.json(customEventsPayload);
    // Return empty for other calls to avoid errors in getUpcomingEvents
    if (url.includes('lookupleague.php')) return Response.json({ leagues: [] });
    return Response.json({});
  };

  const result = await getUpcomingEvents({
    teamId: '133604',
    fetchImpl
  });

  assert.equal(result.events[0].timestamp, '2026-08-10T15:00:00+01:00');

  const ics = toIcs(result);
  // 15:00+01:00 is 14:00 UTC
  assert.match(ics, /DTSTART:20260810T140000Z/);
});
