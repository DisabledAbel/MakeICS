import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFeed, validateIcalendar } from '../lib/feed-health.js';

const calendar = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const event = start => ['BEGIN:VEVENT', `DTSTART${start}`, 'END:VEVENT'];

test('accepts calendars with valid UTC, zoned, and all-day event dates', () => {
  const result = validateIcalendar(calendar(
    ...event(':20260924T120000Z'),
    ...event(';TZID=America/Los_Angeles:20260924T050000'),
    ...event(';VALUE=DATE:20260924')
  ));
  assert.deepEqual(result, { eventCount: 3 });
});

test('accepts a legitimate calendar with no upcoming events', () => {
  assert.deepEqual(validateIcalendar(calendar()), { eventCount: 0 });
});

test('rejects malformed calendars and impossible or ambiguous dates', () => {
  assert.throws(() => validateIcalendar('not a calendar'), /complete VCALENDAR/);
  assert.throws(() => validateIcalendar(calendar(...event(';VALUE=DATE:20260230'))), /invalid DTSTART/);
  assert.throws(() => validateIcalendar(calendar(...event(':20260924T120000'))), /without TZID/);
  assert.throws(() => validateIcalendar(calendar(
    'BEGIN:VEVENT', 'DTSTART:20260924T120000Z', 'DTEND;VALUE=DATE:20260230', 'END:VEVENT'
  )), /invalid DTEND/);
});

test('reports the feed name and HTTP failure reason', async () => {
  const result = await checkFeed(
    { name: 'Sports', path: '/sports.ics' },
    { baseUrl: 'https://example.test', fetchImpl: async () => new Response('', { status: 503, statusText: 'Unavailable' }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.name, 'Sports');
  assert.match(result.reason, /HTTP 503 Unavailable/);
});

test('reports parsing failures returned by a successful request', async () => {
  const result = await checkFeed(
    { name: 'TV', path: '/tv.ics' },
    { baseUrl: 'https://example.test', fetchImpl: async () => new Response(calendar(...event(':bad'))) }
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid DTSTART/);
});
