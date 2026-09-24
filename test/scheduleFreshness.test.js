import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSource } from '../lib/schedule-freshness.js';

const source = { id: 'demo', name: 'Demo', workflow: 'fetch-demo.yml', activeMonths: [6], horizonDays: 7, fetchGraceDays: 3 };
const signal = newest => ({ newest, datedRecords: 10, matchedFiles: 1 });

test('fresh data with a recent successful fetch passes', () => {
  const result = evaluateSource(source, { now: '2026-06-10T00:00:00Z', lastSuccess: '2026-06-09T00:00:00Z', signal: signal('2026-07-01T00:00:00Z') });
  assert.equal(result.status, 'fresh');
});

test('a genuinely stale data horizon is flagged despite workflow success', () => {
  const result = evaluateSource(source, { now: '2026-06-10T00:00:00Z', lastSuccess: '2026-06-10T00:00:00Z', signal: signal('2026-06-01T00:00:00Z') });
  assert.equal(result.status, 'stale');
  assert.match(result.reason, /newest scheduled item/);
});

test('unchanged data is healthy when the successful fetch and horizon are fresh', () => {
  const result = evaluateSource(source, { now: '2026-06-10T00:00:00Z', lastSuccess: '2026-06-10T00:00:00Z', signal: signal('2026-08-01T00:00:00Z') });
  assert.equal(result.status, 'fresh');
});

test('an old schedule is accepted during an expected offseason', () => {
  const result = evaluateSource(source, { now: '2026-12-10T00:00:00Z', lastSuccess: '2026-12-09T00:00:00Z', signal: signal('2026-06-01T00:00:00Z') });
  assert.equal(result.status, 'offseason');
  assert.match(result.reason, /expected offseason/);
});
