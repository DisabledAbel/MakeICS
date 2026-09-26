import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateMlbGames } from '../scripts/fetch-milb.js';
import { normalizeScrapedEvent } from '../lib/sports.js';

const game = (id, overrides = {}) => ({
  id,
  gamePk: id,
  scheduleDate: '2026-08-26',
  date: '2026-08-26T21:40:00Z',
  officialDate: '2026-08-26',
  name: 'Oklahoma City Comets vs El Paso Chihuahuas',
  homeTeam: 'Oklahoma City Comets',
  awayTeam: 'El Paso Chihuahuas',
  venue: 'Chickasaw Bricktown Ballpark',
  broadcast: null,
  league: 'Pacific Coast League',
  status: 'Scheduled',
  ...overrides
});

test('collapses duplicate MLB gamePk values and keeps the consistent record', () => {
  const warnings = [];
  const duplicate = game(815200, {
    scheduleDate: '2026-07-11',
    date: '2026-07-12T00:05:00Z',
    broadcast: 'MiLB.TV'
  });
  const expected = game(815200);

  const result = deduplicateMlbGames([duplicate, expected], { warn: message => warnings.push(message) });

  assert.deepEqual(result, [expected]);
  assert.deepEqual(deduplicateMlbGames([expected, duplicate], { warn: () => {} }), [expected]);
  assert.match(warnings[0], /duplicate gamePk 815200/);
  assert.match(warnings[0], /kept 2026-08-26T21:40:00Z/);
});

test('leaves unique games and doubleheaders with distinct gamePk values untouched', () => {
  const first = game(900001, { date: '2026-06-01T17:00:00Z', officialDate: '2026-06-01', scheduleDate: '2026-06-01' });
  const second = game(900002, { date: '2026-06-01T23:00:00Z', officialDate: '2026-06-01', scheduleDate: '2026-06-01' });

  assert.deepEqual(deduplicateMlbGames([first, second]), [first, second]);
});

test('deduplicated MiLB output has one normalized idEvent per gamePk', () => {
  const games = [game(815200), game(815200, { venue: null }), game(815329)];
  const events = deduplicateMlbGames(games, { warn: () => {} })
    .map(item => normalizeScrapedEvent(item, 'Oklahoma City Comets'));

  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.idEvent), ['scraped-815200', 'scraped-815329']);
  assert.equal(events[0].strVenue, 'Chickasaw Bricktown Ballpark');
  assert.equal(new Set(events.map(event => event.idEvent)).size, events.length);
});
