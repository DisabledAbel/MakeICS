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
