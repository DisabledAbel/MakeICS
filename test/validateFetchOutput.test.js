import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_RULES, validateData } from '../scripts/validate-fetch-output.js';

const now = new Date('2026-05-01T00:00:00Z');
const event = (id, date) => ({ idEvent: id, dateEvent: date, strLeague: 'NBA' });
const schedule = events => ({ events });

test('accepts a valid schedule update', () => {
  const errors = validateData({ file: 'team.json', current: schedule([event('a', '2026-05-02'), event('b', '2026-06-02')]), rule: SOURCE_RULES.nba, now });
  assert.deepEqual(errors, []);
});

test('accepts a legitimate empty schedule during an offseason', () => {
  const july = new Date('2026-07-15T00:00:00Z');
  const previous = schedule(Array.from({ length: 10 }, (_, i) => event(String(i), `2026-07-${String(i + 16).padStart(2, '0')}`)));
  assert.deepEqual(validateData({ file: 'team.json', current: schedule([]), previous, rule: SOURCE_RULES.nba, now: july }), []);
});

test('rejects duplicate event IDs', () => {
  const errors = validateData({ file: 'team.json', current: schedule([event('same', '2026-05-02'), event('same', '2026-05-03')]), rule: SOURCE_RULES.nba, now });
  assert.match(errors.join('\n'), /duplicate event ID same/);
});

test('rejects impossible and malformed dates', () => {
  const errors = validateData({ file: 'team.json', current: schedule([event('a', '2026-02-30'), event('b', 'not-a-date')]), rule: SOURCE_RULES.nba, now });
  assert.equal(errors.filter(message => message.includes('invalid date')).length, 2);
});

test('requires strict ISO date prefixes on timestamps', () => {
  const current = schedule([
    { idEvent: 'loose', strTimestamp: 'May 2, 2026 10:00 UTC', strLeague: 'NBA' },
    { idEvent: 'impossible', strTimestamp: '2026-02-30T10:00:00Z', strLeague: 'NBA' }
  ]);
  const errors = validateData({ file: 'team.json', current, rule: SOURCE_RULES.nba, now });
  assert.equal(errors.filter(message => message.includes('invalid date')).length, 2);
});

test('rejects a suspicious drop in upcoming events', () => {
  const previous = schedule(Array.from({ length: 10 }, (_, i) => event(String(i), `2026-06-${String(i + 1).padStart(2, '0')}`)));
  const errors = validateData({ file: 'team.json', current: schedule([event('0', '2026-06-01')]), previous, rule: SOURCE_RULES.nba, now });
  assert.match(errors.join('\n'), /suspicious upcoming-event drop from 10 to 1/);
});
