import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchTeamSuggestions, getEvents, toIcs, normalizeScrapedEvent } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '../lib/data/sports');

const teamPayload = {
  teams: [
    {
      idTeam: '133604',
      strTeam: 'Arsenal',
      strSport: 'Soccer',
      strLeague: 'English Premier League',
      idLeague: '9999',
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
      idLeague: '9999',
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

test('getEvents returns merged and deduplicated events for a team, including past ones', (t) => {
  const clock = t.mock.timers;
  clock.enable({ names: ['Date'], now: new Date('2027-01-01T00:00:00Z') });

  return t.test('merging logic', async () => {
    const result = await getEvents({
      teamId: '133604',
      fetchImpl: createFetchMock()
    });

    assert.equal(result.team.name, 'Arsenal');
    // Should have: Arsenal vs Real Betis (4), Arsenal vs Everton (1), Chelsea vs Arsenal (3)
    // Deduplicated and sorted by date, all are in the past now but should be included
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].id, '4');
    assert.equal(result.events[1].id, '1');
    assert.equal(result.events[2].id, '3');
  });
});

test('getEvents utilizes local cache if available', async (t) => {
  const leagueId = '9999';
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
    const result = await getEvents({
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

test('getEvents merges supplemental (scraped) data', async (t) => {
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
    const result = await getEvents({
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

  const result = await getEvents({
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

test('getEvents handles strTimestamp with offset correctly', async (t) => {
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
    // Return empty for other calls to avoid errors in getEvents
    if (url.includes('lookupleague.php')) return Response.json({ leagues: [] });
    return Response.json({});
  };

  const result = await getEvents({
    teamId: '133604',
    fetchImpl
  });

  assert.equal(result.events[0].timestamp, '2026-08-10T15:00:00+01:00');

  const ics = toIcs(result);
  // 15:00+01:00 is 14:00 UTC
  assert.match(ics, /DTSTART:20260810T140000Z/);
});

// ── normalizeScrapedEvent: new ISO timestamp handling (PR changes) ──────────

test('normalizeScrapedEvent: game.date as ISO string sets timestamp and extracts HH:mm time with :00 suffix', () => {
  // Scenario produced by the Portland Fire scraper: date field is a full ISO timestamp
  const game = {
    date: '2026-05-10T01:00Z',
    name: 'vs Chicago Sky',
    homeTeam: 'Portland Fire',
    awayTeam: 'Chicago Sky'
  };

  const event = normalizeScrapedEvent(game, 'Portland Fire');

  assert.equal(event.strTimestamp, '2026-05-10T01:00Z');
  // HH:mm extracted → ':00' appended
  assert.equal(event.strTime, '01:00:00');
  // dateEvent should be the raw value from game.date
  assert.equal(event.dateEvent, '2026-05-10T01:00Z');
  assert.equal(event.strStatus, 'NS');
  assert.equal(event.source, 'scraped');
});

test('normalizeScrapedEvent: game.date as ISO string with full HH:mm:ss time does not double-append :00', () => {
  const game = {
    date: '2026-06-18T02:00:00Z',
    name: 'vs Seattle Storm',
    homeTeam: 'Portland Fire',
    awayTeam: 'Seattle Storm'
  };

  const event = normalizeScrapedEvent(game, 'Portland Fire');

  assert.equal(event.strTimestamp, '2026-06-18T02:00:00Z');
  // Time portion after 'T', strip 'Z' → length 8, no `:00` appended
  assert.equal(event.strTime, '02:00:00');
});

test('normalizeScrapedEvent: game.time as ISO string sets timestamp and extracts time', () => {
  // Some scrapers put the ISO string in the time field instead of date
  const game = {
    date: '2026-08-09',  // plain date
    time: '2026-08-09T00:30Z',
    name: 'vs Seattle Storm',
    homeTeam: 'Portland Fire',
    awayTeam: 'Seattle Storm'
  };

  // date is plain YYYY-MM-DD so the date check fails; time contains 'T'
  const event = normalizeScrapedEvent(game, 'Portland Fire');

  assert.equal(event.strTimestamp, '2026-08-09T00:30Z');
  assert.equal(event.strTime, '00:30:00');
});

test('normalizeScrapedEvent: ISO date takes priority over plain time field', () => {
  // When both game.date is ISO and game.time is set, ISO date wins for timestamp
  const game = {
    date: '2026-06-14T00:30Z',
    time: '00:30',
    name: 'vs Dallas Wings',
    homeTeam: 'Portland Fire',
    awayTeam: 'Dallas Wings'
  };

  const event = normalizeScrapedEvent(game, 'Portland Fire');

  // Timestamp comes from game.date (ISO), not reconstructed from date+plain time
  assert.equal(event.strTimestamp, '2026-06-14T00:30Z');
  assert.equal(event.strTime, '00:30:00');
});

test('normalizeScrapedEvent: plain YYYY-MM-DD date with HH:mm:ss time constructs timestamp (original behavior)', () => {
  const game = {
    date: '2026-08-05',
    time: '18:30:00',
    name: 'Arsenal vs Everton',
    homeTeam: 'Arsenal',
    awayTeam: 'Everton'
  };

  const event = normalizeScrapedEvent(game, 'Arsenal');

  assert.equal(event.strTime, '18:30:00');
  assert.equal(event.strTimestamp, '2026-08-05T18:30:00Z');
});

test('normalizeScrapedEvent: plain YYYY-MM-DD date with HH:mm time constructs timestamp and pads time (original behavior)', () => {
  const game = {
    date: '2026-08-05',
    time: '18:30',
    name: 'Arsenal vs Everton',
    homeTeam: 'Arsenal',
    awayTeam: 'Everton'
  };

  const event = normalizeScrapedEvent(game, 'Arsenal');

  assert.equal(event.strTime, '18:30:00');
  assert.equal(event.strTimestamp, '2026-08-05T18:30:00Z');
});

test('normalizeScrapedEvent: no time field defaults to 00:00:00 and constructs timestamp', () => {
  const game = {
    date: '2026-09-18',
    name: 'vs Phoenix Mercury',
    homeTeam: 'Portland Fire',
    awayTeam: 'Phoenix Mercury'
  };

  const event = normalizeScrapedEvent(game, 'Portland Fire');

  assert.equal(event.strTime, '00:00:00');
  assert.equal(event.strTimestamp, '2026-09-18T00:00:00Z');
});

test('normalizeScrapedEvent: no date and no time yields no timestamp and default time', () => {
  const game = {
    name: 'vs Unknown Opponent',
    homeTeam: 'Portland Fire',
    awayTeam: 'Unknown Opponent'
  };

  const event = normalizeScrapedEvent(game, 'Portland Fire');

  assert.equal(event.strTime, '00:00:00');
  assert.equal(event.strTimestamp, null);
});

test('normalizeScrapedEvent: stable ID generated from ISO date field', () => {
  // Matches the actual ID format in 152565.json
  const game = {
    date: '2026-05-10T01:00Z',
    name: 'vs Chicago Sky',
    homeTeam: 'Portland Fire',
    awayTeam: 'Chicago Sky'
  };

  const event = normalizeScrapedEvent(game, 'Portland Fire');

  // ID is built from lowercased date+name with non-alphanumeric chars replaced by '-'
  assert.equal(event.idEvent, 'scraped-2026-05-10t01-00z-vs-chicago-sky');
});

test('normalizeScrapedEvent: home/away teams inferred from name when not provided', () => {
  const game = {
    date: '2026-06-18',
    time: '02:00:00',
    name: 'Portland Fire vs Seattle Storm'
  };

  const event = normalizeScrapedEvent(game, 'Portland Fire');

  // Name starts with teamName → inferred as home team
  assert.equal(event.strHomeTeam, 'Portland Fire');
  assert.equal(event.strAwayTeam, null);
});

test('normalizeScrapedEvent: away game inferred from name ending with teamName', () => {
  const game = {
    date: '2026-05-20',
    time: '23:00:00',
    name: 'Indiana Fever vs Portland Fire'
  };

  const event = normalizeScrapedEvent(game, 'Portland Fire');

  assert.equal(event.strHomeTeam, null);
  assert.equal(event.strAwayTeam, 'Portland Fire');
});

// ── 152565.json data file structure validation ──────────────────────────────

test('152565.json supplemental data file has valid structure', async () => {
  const filePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../lib/data/sports/supplemental/152565.json'
  );

  const content = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(content);

  assert.equal(data.teamId, '152565');
  assert.equal(data.teamName, 'Portland Fire');
  assert.ok(typeof data.updatedAt === 'string', 'updatedAt should be a string');
  assert.ok(!isNaN(Date.parse(data.updatedAt)), 'updatedAt should be a valid ISO date');
  assert.ok(Array.isArray(data.events), 'events should be an array');
  assert.ok(data.events.length > 0, 'events should not be empty');

  for (const event of data.events) {
    assert.ok(typeof event.idEvent === 'string', `idEvent should be a string: ${event.idEvent}`);
    assert.match(event.idEvent, /^scraped-/, 'idEvent should start with scraped-');
    assert.ok(typeof event.strEvent === 'string', 'strEvent should be a string');
    assert.ok(typeof event.strHomeTeam === 'string', 'strHomeTeam should be a string');
    assert.ok(typeof event.strAwayTeam === 'string', 'strAwayTeam should be a string');
    assert.ok(typeof event.dateEvent === 'string', 'dateEvent should be a string');
    assert.equal(event.strStatus, 'NS', 'strStatus should be NS');
    assert.equal(event.source, 'scraped', 'source should be scraped');
    // Each event involves Portland Fire as either home or away
    assert.ok(
      event.strHomeTeam === 'Portland Fire' || event.strAwayTeam === 'Portland Fire',
      `Portland Fire should be home or away: ${event.idEvent}`
    );
  }
});

test('152565.json events have no duplicate idEvent values', async () => {
  const filePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../lib/data/sports/supplemental/152565.json'
  );

  const content = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(content);

  const ids = data.events.map(e => e.idEvent);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, 'All event IDs should be unique');
});

test('152565.json events timestamps match dateEvent field when dateEvent is ISO', async () => {
  const filePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../lib/data/sports/supplemental/152565.json'
  );

  const content = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(content);

  for (const event of data.events) {
    if (event.strTimestamp) {
      assert.ok(!isNaN(Date.parse(event.strTimestamp)), `strTimestamp should be a valid date: ${event.strTimestamp}`);
    }
  }
});
