import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTeamSuggestions, getUpcomingEvents, toIcs } from '../lib/sports.js';

const teamPayload = {
  teams: [
    {
      idTeam: '133604',
      strTeam: 'Arsenal',
      strSport: 'Soccer',
      strLeague: 'English Premier League',
      strCountry: 'England',
      strBadge: 'https://example.test/badge.png',
      strWebsite: 'www.arsenal.com',
      strDescriptionEN: 'Arsenal Football Club...'
    }
  ]
};

const eventsPayload = {
  events: [
    {
      idEvent: '1',
      strEvent: 'Arsenal vs Everton',
      strHomeTeam: 'Arsenal',
      strAwayTeam: 'Everton',
      dateEvent: '2026-08-05',
      strTime: '18:30:00',
      strTimestamp: '2026-08-05T18:30:00Z',
      strLeague: 'English Premier League',
      strVenue: 'Emirates Stadium',
      strStatus: 'NS'
    }
  ]
};

function createFetchMock() {
  return async (url) => {
    if (url.includes('searchteams.php')) {
      return Response.json(teamPayload);
    }
    if (url.includes('lookatteam.php')) {
      return Response.json(teamPayload);
    }
    if (url.includes('eventsnext.php')) {
      return Response.json(eventsPayload);
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

test('getUpcomingEvents returns events for a team', async () => {
  const result = await getUpcomingEvents({
    teamId: '133604',
    fetchImpl: createFetchMock()
  });

  assert.equal(result.team.name, 'Arsenal');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].name, 'Arsenal vs Everton');
});

test('toIcs creates ICS for sports events', async () => {
  const result = await getUpcomingEvents({
    teamId: '133604',
    fetchImpl: createFetchMock()
  });
  result.generatedAt = '2026-01-01T00:00:00Z';

  const ics = toIcs(result);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:Arsenal vs Everton/);
  assert.match(ics, /LOCATION:Emirates Stadium/);
});
