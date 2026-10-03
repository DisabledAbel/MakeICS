import test from 'node:test';
import assert from 'node:assert/strict';
import { compareHistory } from '../scripts/calendar-history.js';
import { getEvents, toIcs as sportsToIcs } from '../lib/sports.js';
import { buildCalendar, toIcs as combinedToIcs } from '../lib/calendar.js';

const sports = (id, date = '2025-01-02', extra = {}) => ({
  kind: 'sports', identity: `sports:${id}`, uid: `sportsdb-${id}@makeics.local`, source: 'lib/data/sports/1.json',
  record: { idEvent: id, strEvent: 'A vs B', dateEvent: date, ...extra }
});

test('rejects a completed event disappearing after refresh or a one-event deletion', () => {
  assert.match(compareHistory([sports('gone')], []).join('\n'), /previously saved event is missing/);
});

test('accepts unchanged data, season rollover moves, and a year-changing reschedule', () => {
  const old = sports('same', '2025-12-30');
  assert.deepEqual(compareHistory([old], [old]), []);
  assert.deepEqual(compareHistory([old], [{ ...sports('same', '2026-01-03'), source: 'lib/data/archive/events.json', archived: true }]), []);
});

test('accepts explicit cancellation while preserving identity and UID', () => {
  assert.deepEqual(compareHistory([sports('cancel')], [sports('cancel', '2025-01-02', { strStatus: 'Cancelled' })]), []);
});

test('rejects an emptied/deleted archive and accidental UID changes', () => {
  const archived = { ...sports('old'), source: 'lib/data/archive/events.json', archived: true };
  assert.match(compareHistory([archived], []).join('\n'), /missing from live data and permanent archive/);
  assert.match(compareHistory([sports('uid')], [{ ...sports('uid'), uid: 'changed@example' }]).join('\n'), /calendar UID changed/);
});

test('rejects duplicate archived identities and malformed required fields', () => {
  const archived = { ...sports('dup'), source: 'lib/data/archive/events.json', archived: true };
  assert.match(compareHistory([], [archived, archived]).join('\n'), /duplicate archived identity/);
  assert.match(compareHistory([], [sports('bad', 'not-a-date', { strEvent: '' })]).join('\n'), /requires idEvent and strEvent/);
});

test('individual and combined ICS feeds retain archived event UIDs', async () => {
  const raw = { id: '42', idEvent: '42', name: 'A vs B', date: '2025-01-02', time: '20:00:00', league: 'NBA', venue: 'Arena', __archived: true };
  const individual = sportsToIcs({ team: { sport: 'Basketball' }, events: [raw], generatedAt: '2026-01-01T00:00:00Z' });
  assert.match(individual, /UID:sportsdb-42@makeics\.local/);

  const result = await buildCalendar({ teamIds: ['7'], loaders: { getEvents: async () => ({ team: { name: 'A', sport: 'Basketball' }, events: [raw] }) } });
  const combined = combinedToIcs(result, { now: new Date('2026-01-01T00:00:00Z') });
  assert.match(combined, /UID:makeics-sports-7-42@makeics/);
});

test('real sports loading merges a requested team archive into its ICS feed', async () => {
  const teamId = '136438';
  const fetchImpl = async url => {
    if (url.includes('lookupteam.php')) return Response.json({ teams: [{ idTeam: teamId, strTeam: 'Connecticut Sun', strSport: 'Basketball' }] });
    if (url.includes('eventsnext.php')) return Response.json({ events: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  const result = await getEvents({ teamId, now: new Date('2026-10-03T00:00:00Z'), fetchImpl });
  const archived = result.events.find(event => event.id === 'scraped-401856890');
  assert.ok(archived, 'expected the committed archive record to be merged');
  assert.match(sportsToIcs(result), /UID:sportsdb-scraped-401856890@makeics\.local/);
});
