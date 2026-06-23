import test from 'node:test';
import assert from 'node:assert/strict';
import { getEvents } from '../lib/sports.js';

const teamPayload = {
  teams: [
    {
      idTeam: '133604',
      strTeam: 'Arsenal',
      strSport: 'Soccer',
      strLeague: 'English Premier League',
      idLeague: '4328',
      strStadium: 'Emirates Stadium'
    }
  ]
};

const eventsPayload = {
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
      idEvent: '2',
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

function createFetchMock() {
  return async (url) => {
    if (url.includes('lookupteam.php')) return Response.json(teamPayload);
    if (url.includes('eventsnext.php')) return Response.json(eventsPayload);
    if (url.includes('lookupleague.php')) return Response.json({ leagues: [] });
    return Response.json({});
  };
}

test('getEvents naming convention - verified fix', async () => {
  const result = await getEvents({
    teamId: '133604',
    fetchImpl: createFetchMock()
  });

  const homeGame = result.events.find(e => e.id === '1');
  const awayGame = result.events.find(e => e.id === '2');

  assert.equal(homeGame.name, 'Arsenal vs Everton');
  assert.equal(awayGame.name, 'Arsenal at Chelsea');
});

// Helper to build a minimal fetch mock with custom events payload
function createFetchMockWithEvents(events) {
  return async (url) => {
    if (url.includes('lookupteam.php')) return Response.json(teamPayload);
    if (url.includes('eventsnext.php')) return Response.json({ events });
    if (url.includes('lookupleague.php')) return Response.json({ leagues: [] });
    return Response.json({});
  };
}

test('home game matched by team name (not ID) gets "vs" format', async () => {
  // idHomeTeam does NOT match teamId, but strHomeTeam name matches
  const events = [
    {
      idEvent: '10',
      strEvent: 'Arsenal vs Tottenham',
      idHomeTeam: '999999', // different ID
      idAwayTeam: '133615',
      strHomeTeam: 'Arsenal',  // name matches
      strAwayTeam: 'Tottenham',
      dateEvent: '2026-09-01',
      strTime: '15:00:00',
      strTimestamp: '2026-09-01T15:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Emirates Stadium',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '10');
  assert.equal(event.name, 'Arsenal vs Tottenham');
});

test('away game matched by team name (not ID) gets "at" format', async () => {
  // idAwayTeam does NOT match teamId, but strAwayTeam name matches
  const events = [
    {
      idEvent: '11',
      strEvent: 'Liverpool vs Arsenal',
      idHomeTeam: '133602',
      idAwayTeam: '999999', // different ID
      strHomeTeam: 'Liverpool',
      strAwayTeam: 'Arsenal',  // name matches
      dateEvent: '2026-09-08',
      strTime: '17:30:00',
      strTimestamp: '2026-09-08T17:30:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Anfield',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '11');
  assert.equal(event.name, 'Arsenal at Liverpool');
});

test('home game with missing away team does not rename the event', async () => {
  const events = [
    {
      idEvent: '20',
      strEvent: 'Arsenal vs TBD',
      idHomeTeam: '133604',
      idAwayTeam: null,
      strHomeTeam: 'Arsenal',
      strAwayTeam: null,  // no opponent yet
      dateEvent: '2026-10-01',
      strTime: '15:00:00',
      strTimestamp: '2026-10-01T15:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Emirates Stadium',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '20');
  // opponent is falsy, so name should remain the original strEvent
  assert.equal(event.name, 'Arsenal vs TBD');
});

test('away game with missing home team does not rename the event', async () => {
  const events = [
    {
      idEvent: '21',
      strEvent: 'TBD vs Arsenal',
      idHomeTeam: null,
      idAwayTeam: '133604',
      strHomeTeam: null,  // no home team yet
      strAwayTeam: 'Arsenal',
      dateEvent: '2026-10-08',
      strTime: '15:00:00',
      strTimestamp: '2026-10-08T15:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'TBD',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '21');
  // opponent (homeTeam) is falsy, so name should remain the original strEvent
  assert.equal(event.name, 'TBD vs Arsenal');
});

test('event where tracked team is neither home nor away retains original name', async () => {
  const events = [
    {
      idEvent: '30',
      strEvent: 'Manchester United vs Liverpool',
      idHomeTeam: '133616',
      idAwayTeam: '133602',
      strHomeTeam: 'Manchester United',
      strAwayTeam: 'Liverpool',
      dateEvent: '2026-10-15',
      strTime: '20:00:00',
      strTimestamp: '2026-10-15T20:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Old Trafford',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '30');
  // Arsenal is neither home nor away, name stays as-is
  assert.equal(event.name, 'Manchester United vs Liverpool');
});

test('home game with TBD venue gets filled from team stadium', async () => {
  const events = [
    {
      idEvent: '40',
      strEvent: 'Arsenal vs Wolves',
      idHomeTeam: '133604',
      idAwayTeam: '133619',
      strHomeTeam: 'Arsenal',
      strAwayTeam: 'Wolves',
      dateEvent: '2026-11-01',
      strTime: '15:00:00',
      strTimestamp: '2026-11-01T15:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'TBD',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '40');
  assert.equal(event.venue, 'Emirates Stadium');
});

test('home game with TBA venue gets filled from team stadium', async () => {
  const events = [
    {
      idEvent: '41',
      strEvent: 'Arsenal vs Brighton',
      idHomeTeam: '133604',
      idAwayTeam: '133620',
      strHomeTeam: 'Arsenal',
      strAwayTeam: 'Brighton',
      dateEvent: '2026-11-08',
      strTime: '15:00:00',
      strTimestamp: '2026-11-08T15:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'TBA',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '41');
  assert.equal(event.venue, 'Emirates Stadium');
});

test('home game with empty venue gets filled from team stadium', async () => {
  const events = [
    {
      idEvent: '42',
      strEvent: 'Arsenal vs Fulham',
      idHomeTeam: '133604',
      idAwayTeam: '133621',
      strHomeTeam: 'Arsenal',
      strAwayTeam: 'Fulham',
      dateEvent: '2026-11-15',
      strTime: '15:00:00',
      strTimestamp: '2026-11-15T15:00:00Z',
      strLeague: 'English Premier League',
      strVenue: '',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '42');
  assert.equal(event.venue, 'Emirates Stadium');
});

test('home game with existing venue does not get overwritten', async () => {
  const events = [
    {
      idEvent: '43',
      strEvent: 'Arsenal vs Newcastle',
      idHomeTeam: '133604',
      idAwayTeam: '133622',
      strHomeTeam: 'Arsenal',
      strAwayTeam: 'Newcastle',
      dateEvent: '2026-11-22',
      strTime: '15:00:00',
      strTimestamp: '2026-11-22T15:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Emirates Stadium',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '43');
  // Venue present; should remain unchanged
  assert.equal(event.venue, 'Emirates Stadium');
});

test('away game with TBD venue does not get filled from team stadium', async () => {
  const events = [
    {
      idEvent: '50',
      strEvent: 'Tottenham vs Arsenal',
      idHomeTeam: '133612',
      idAwayTeam: '133604',
      strHomeTeam: 'Tottenham',
      strAwayTeam: 'Arsenal',
      dateEvent: '2026-12-01',
      strTime: '20:00:00',
      strTimestamp: '2026-12-01T20:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'TBD',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '50');
  // Away game: stadium fill should NOT apply
  assert.equal(event.venue, 'TBD');
});

test('team name matching is case-insensitive and trims whitespace', async () => {
  const events = [
    {
      idEvent: '60',
      strEvent: 'ARSENAL vs Brentford',
      idHomeTeam: '999',     // ID mismatch, must rely on name match
      idAwayTeam: '133625',
      strHomeTeam: '  Arsenal  ',  // leading/trailing spaces + different case
      strAwayTeam: 'Brentford',
      dateEvent: '2026-12-10',
      strTime: '15:00:00',
      strTimestamp: '2026-12-10T15:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Emirates Stadium',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const event = result.events.find(e => e.id === '60');
  assert.equal(event.name, 'Arsenal vs Brentford');
});

test('both home and away renaming applied correctly across multiple events', async () => {
  const events = [
    {
      idEvent: '70',
      strEvent: 'Arsenal vs West Ham',
      idHomeTeam: '133604',
      idAwayTeam: '133600',
      strHomeTeam: 'Arsenal',
      strAwayTeam: 'West Ham',
      dateEvent: '2026-12-15',
      strTime: '15:00:00',
      strTimestamp: '2026-12-15T15:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Emirates Stadium',
      strStatus: 'NS'
    },
    {
      idEvent: '71',
      strEvent: 'Aston Villa vs Arsenal',
      idHomeTeam: '133601',
      idAwayTeam: '133604',
      strHomeTeam: 'Aston Villa',
      strAwayTeam: 'Arsenal',
      dateEvent: '2026-12-22',
      strTime: '20:00:00',
      strTimestamp: '2026-12-22T20:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Villa Park',
      strStatus: 'NS'
    },
    {
      idEvent: '72',
      strEvent: 'Burnley vs Crystal Palace',
      idHomeTeam: '133607',
      idAwayTeam: '133611',
      strHomeTeam: 'Burnley',
      strAwayTeam: 'Crystal Palace',
      dateEvent: '2026-12-22',
      strTime: '15:00:00',
      strTimestamp: '2026-12-22T15:00:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Turf Moor',
      strStatus: 'NS'
    }
  ];

  const result = await getEvents({ teamId: '133604', fetchImpl: createFetchMockWithEvents(events) });
  const home = result.events.find(e => e.id === '70');
  const away = result.events.find(e => e.id === '71');
  const unrelated = result.events.find(e => e.id === '72');

  assert.equal(home.name, 'Arsenal vs West Ham');
  assert.equal(away.name, 'Arsenal at Aston Villa');
  assert.equal(unrelated.name, 'Burnley vs Crystal Palace');
});
