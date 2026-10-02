import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSource, SOURCES } from '../lib/schedule-freshness.js';

const source = { id: 'demo', name: 'Demo', workflow: 'fetch-demo.yml', activeMonths: [6], horizonDays: 7, fetchGraceDays: 3 };
const signal = newest => ({ newest, datedRecords: 10, matchedFiles: 1 });

test('fresh data with a recent successful fetch passes', () => {
  const result = evaluateSource(source, { now: '2026-06-10T00:00:00Z', lastSuccess: '2026-06-09T00:00:00Z', signal: signal('2026-07-01T00:00:00Z') });
  assert.equal(result.status, 'fresh');
  assert.deepEqual(result.reasonCategories, []);
});

test('a genuinely stale data horizon is flagged despite workflow success', () => {
  const result = evaluateSource(source, { now: '2026-06-10T00:00:00Z', lastSuccess: '2026-06-10T00:00:00Z', signal: signal('2026-06-01T00:00:00Z') });
  assert.equal(result.status, 'stale');
  assert.deepEqual(result.reasonCategories, ['data-horizon']);
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

test('stable reason categories distinguish fetch age from data horizon failures', () => {
  const result = evaluateSource(source, { now: '2026-06-10T00:00:00Z', lastSuccess: '2026-06-01T00:00:00Z', signal: signal('2026-06-01T00:00:00Z') });
  assert.deepEqual(result.reasonCategories, ['fetch-age', 'data-horizon']);
});

const finiteTeamSchedule = {
  ...source,
  id: 'finite-team',
  allowEndedSchedule: true,
  requireDatedRecords: true
};

test('a recent successful fetch confirms a team schedule that recently ended', () => {
  const result = evaluateSource(finiteTeamSchedule, {
    now: '2026-06-10T00:00:00Z',
    lastSuccess: '2026-06-10T00:00:00Z',
    signal: signal('2026-06-01T00:00:00Z')
  });
  assert.equal(result.status, 'schedule-ended');
  assert.deepEqual(result.reasonCategories, []);
  assert.match(result.reason, /no remaining future events/);
});

test('incomplete future coverage is stale rather than an ended schedule', () => {
  const result = evaluateSource(finiteTeamSchedule, {
    now: '2026-06-10T00:00:00Z',
    lastSuccess: '2026-06-10T00:00:00Z',
    signal: signal('2026-06-12T00:00:00Z')
  });
  assert.equal(result.status, 'stale');
  assert.deepEqual(result.reasonCategories, ['data-horizon']);
});

test('an ended schedule with an old fetch is stale', () => {
  const result = evaluateSource(finiteTeamSchedule, {
    now: '2026-06-10T00:00:00Z',
    lastSuccess: '2026-06-01T00:00:00Z',
    signal: signal('2026-06-01T00:00:00Z')
  });
  assert.equal(result.status, 'stale');
  assert.ok(result.reasonCategories.includes('fetch-age'));
  assert.ok(result.reasonCategories.includes('data-horizon'));
});

test('an active finite source with missing or undated data is stale', () => {
  for (const missingSignal of [
    { newest: null, datedRecords: 0, matchedFiles: 0 },
    { newest: null, datedRecords: 0, matchedFiles: 1 }
  ]) {
    const result = evaluateSource(finiteTeamSchedule, {
      now: '2026-06-10T00:00:00Z',
      lastSuccess: '2026-06-10T00:00:00Z',
      signal: missingSignal
    });
    assert.equal(result.status, 'stale');
    assert.deepEqual(result.reasonCategories, ['missing-data']);
  }
});

test('an ended schedule is reported as offseason outside its active months', () => {
  const result = evaluateSource(finiteTeamSchedule, {
    now: '2026-12-10T00:00:00Z',
    lastSuccess: '2026-12-09T00:00:00Z',
    signal: signal('2026-06-01T00:00:00Z')
  });
  assert.equal(result.status, 'offseason');
});

test('existing active sources still enforce their configured horizon', () => {
  const result = evaluateSource(source, {
    now: '2026-06-10T00:00:00Z',
    lastSuccess: '2026-06-10T00:00:00Z',
    signal: signal('2026-06-01T00:00:00Z')
  });
  assert.equal(result.status, 'stale');
  assert.deepEqual(result.reasonCategories, ['data-horizon']);
});

test('MLS freshness follows its February-November season and dedicated workflow', () => {
  const mls = SOURCES.find(item => item.id === 'mls');
  assert.equal(mls.workflow, 'fetch-mls.yml');
  assert.equal(mls.matchLeague, 'MLS');
  assert.deepEqual(mls.activeMonths, [2,3,4,5,6,7,8,9,10,11]);
});
