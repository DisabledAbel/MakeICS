import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendar, toIcs } from '../lib/calendar.js';
import { createCalendarHandler, parseCalendarRequest } from '../api/calendar.js';

const calls = [];
const loaders = {
  async getEpisodes({ query, since }) {
    calls.push(['tv', query, since]);
    if (query === 'Broken') throw new Error('secret stack data');
    return { generatedAt: '2026-01-01T00:00:00.000Z', show: { id: query === 'Alpha' ? 10 : 11, name: query, tvmazeUrl: 'https://tvmaze.com/show' }, episodes: [{ id: 101, name: `${query}, finale; \\ cut\nnext`, summary: 'Line 1\nLine 2', airdate: '2026-09-20', airtime: '18:00', airstamp: '2026-09-20T18:00:00Z', runtime: 30, url: 'https://tvmaze.com/episode' }] };
  },
  async getEvents({ teamId, since }) {
    calls.push(['sports', teamId, since]);
    return { generatedAt: '2026-01-01T00:00:00.000Z', team: { id: teamId, name: `Team ${teamId}`, sport: 'Basketball' }, events: [{ id: `event-${teamId}`, name: 'Game', date: '2026-09-19', time: '18:00:00', timestamp: '2026-09-19T18:00:00Z', league: 'League', venue: 'Arena' }] };
  },
  async getMovies({ query, type, since }) {
    calls.push(['movies', query, since, type]);
    if (query === 'Broken') throw new Error('filesystem path');
    return { query, type, movies: [{ id: `tt-${query}`, title: query, date: '2026-09-21', releaseDate: '2026-09-21', genres: ['Family'], people: ['Person'] }] };
  }
};

function url(query) { return new URL(`http://localhost/api/calendar?${query}`); }
function request(handler, query, method = 'GET') {
  return new Promise(resolve => {
    const headers = {};
    const res = { statusCode: 0, setHeader(key, value) { headers[key.toLowerCase()] = value; }, end(body = '') { resolve({ status: this.statusCode, headers, body, json: headers['content-type']?.includes('json') ? JSON.parse(body || '{}') : null }); } };
    handler({ method, url: `/api/calendar?${query}`, headers: { host: 'localhost' } }, res);
  });
}

test('builds TV-only, sports-only, and movie-only calendars', async () => {
  assert.equal((await buildCalendar({ shows: ['Alpha'], loaders })).events[0].type, 'tv');
  assert.equal((await buildCalendar({ teamIds: ['1'], loaders })).events[0].type, 'sports');
  const movie = (await buildCalendar({ movies: ['Disney'], movieType: 'studio', loaders })).events[0];
  assert.equal(movie.type, 'movie'); assert.equal(movie.allDay, true); assert.equal(movie.start, '2026-09-21');
});

test('combines TV and sports and all three types in chronological order', async () => {
  const two = await buildCalendar({ shows: ['Alpha'], teamIds: ['1'], loaders });
  assert.deepEqual(two.events.map(event => event.type), ['sports', 'tv']);
  const all = await buildCalendar({ shows: ['Alpha'], teamIds: ['1'], movies: ['Disney'], loaders });
  assert.deepEqual(all.events.map(event => event.type), ['sports', 'tv', 'movie']);
});

test('loads multiple shows and teams and removes duplicate sources', async () => {
  const parsed = parseCalendarRequest(url('shows=Alpha,Alpha,Beta&teamIds=1,1,2'));
  assert.deepEqual(parsed.shows, ['Alpha', 'Beta']); assert.deepEqual(parsed.teamIds, ['1', '2']);
  const result = await buildCalendar({ ...parsed, loaders }); assert.equal(result.sources.tv.length, 2); assert.equal(result.sources.sports.length, 2);
});

test('validates empty input, timezone, team IDs and source limits', () => {
  assert.throws(() => parseCalendarRequest(url('')), /At least one/);
  assert.throws(() => parseCalendarRequest(url('shows=A&tz=Mars%2FOlympus')), /Unsupported timezone/);
  assert.throws(() => parseCalendarRequest(url('teamIds=bad%20id')), /team IDs/);
  assert.throws(() => parseCalendarRequest(url(`shows=${Array.from({ length: 11 }, (_, i) => `s${i}`).join(',')}`)), /maximum of 10/);
  assert.throws(() => parseCalendarRequest(url(`movies=${Array.from({ length: 6 }, (_, i) => `m${i}`).join(',')}`)), /maximum of 5/);
});

test('partial failures retain good events and hide internal errors', async () => {
  const result = await buildCalendar({ shows: ['Alpha', 'Broken'], movies: ['Broken'], loaders });
  assert.equal(result.events.length, 1); assert.equal(result.failures.length, 2);
  assert.equal(JSON.stringify(result.failures).includes('secret'), false); assert.equal(result.successfulSources, 1);
});

test('UIDs are stable and deduplication uses them', async () => {
  const first = await buildCalendar({ shows: ['Alpha', 'Alpha'], loaders });
  const second = await buildCalendar({ shows: ['Alpha'], loaders });
  assert.equal(first.events.length, 1); assert.equal(first.events[0].uid, second.events[0].uid);
});

test('ICS is one valid escaped calendar with all-day movies', async () => {
  const result = await buildCalendar({ shows: ['Alpha'], movies: ['Disney'], timezone: 'America/Los_Angeles', loaders });
  const ics = toIcs(result, { now: new Date('2026-01-01T00:00:00Z') });
  assert.equal((ics.match(/BEGIN:VCALENDAR/g) || []).length, 1);
  assert.match(ics, /PRODID:-\/\/MakeICS\/\/Combined Calendar\/\/EN/);
  assert.match(ics, /SUMMARY:Alpha\\, finale\\; \\\\ cut\\nnext/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260921\r\nDTEND;VALUE=DATE:20260922/);
  assert.match(ics, /X-WR-TIMEZONE:America\/Los_Angeles/); assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('handler serves JSON and ICS content types and 400 for no sources', async () => {
  const handler = createCalendarHandler(loaders);
  const json = await request(handler, 'shows=Alpha'); assert.equal(json.status, 200); assert.match(json.headers['content-type'], /application\/json/); assert.equal(json.json.calendar.eventCount, 1);
  const ics = await request(handler, 'shows=Alpha&format=ics'); assert.equal(ics.status, 200); assert.equal(ics.headers['content-type'], 'text/calendar; charset=utf-8');
  const bad = await request(handler, ''); assert.equal(bad.status, 400); assert.match(bad.json.error, /At least one/);
});

test('returns complete failure only when every loader rejects', async () => {
  const response = await request(createCalendarHandler(loaders), 'shows=Broken&movies=Broken');
  assert.equal(response.status, 502); assert.equal(response.json.failures.length, 2);
});

test('propagates since and movie type to existing loaders', async () => {
  calls.length = 0;
  await buildCalendar({ shows: ['Alpha'], teamIds: ['1'], movies: ['Disney'], movieType: 'genre', since: '2026-09-01', loaders });
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call[2] === '2026-09-01')); assert.equal(calls[2][3], 'genre');
});
