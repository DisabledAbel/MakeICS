import test from 'node:test';
import assert from 'node:assert/strict';
import { findLastValidatedRun, successfulWorkflowRuns } from '../lib/workflow-freshness.js';

const response = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

test('paginates run history and ignores green runs that skipped fetching', async () => {
  const calls = [];
  const skipped = Array.from({ length: 100 }, (_, id) => ({ id, status: 'completed', conclusion: 'success', updated_at: '2026-09-29T00:00:00Z' }));
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/workflows/') && url.includes('&page=1')) return response({ workflow_runs: skipped });
    if (url.includes('/workflows/') && url.includes('&page=2')) return response({ workflow_runs: [{ id: 200, status: 'completed', conclusion: 'success', updated_at: '2026-09-28T00:00:00Z' }] });
    if (url.includes('/runs/200/jobs')) return response({ jobs: [{ steps: [
      { name: 'Fetch MiLB Schedules', conclusion: 'success' },
      { name: 'Validate and stage fetched data', conclusion: 'success' }
    ] }] });
    return response({ jobs: [{ steps: [{ name: 'Checkout', conclusion: 'success' }] }] });
  };
  const run = await findLastValidatedRun({ repository: 'o/r', token: 'x', workflow: 'fetch-milb.yml', fetchImpl });
  assert.equal(run.id, 200);
  assert.ok(calls.some(url => url.includes('page=2')));
});

test('does not count validation that failed or was skipped', async () => {
  const fetchImpl = async url => url.includes('/jobs')
    ? response({ jobs: [{ steps: [{ name: 'Fetch NFL Schedules', conclusion: 'success' }, { name: 'Validate and stage fetched data', conclusion: 'skipped' }] }] })
    : response({ workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] });
  assert.equal(await findLastValidatedRun({ repository: 'o/r', token: 'x', workflow: 'fetch-nfl.yml', fetchImpl }), null);
});

test('fails closed when a workflow has no required-step configuration', async () => {
  const fetchImpl = async url => url.includes('/jobs')
    ? response({ jobs: [{ steps: [{ name: 'Fetch something', conclusion: 'success' }] }] })
    : response({ workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] });
  assert.equal(await findLastValidatedRun({ repository: 'o/r', token: 'x', workflow: 'unknown.yml', fetchImpl }), null);
});

test('surfaces GitHub API errors instead of reporting every source stale', async () => {
  const fetchImpl = async () => response({ message: 'rate limited' }, { ok: false, status: 403 });
  await assert.rejects(
    successfulWorkflowRuns({ sources: [{ workflow: 'fetch-imdb.yml' }], repository: 'o/r', token: 'x', fetchImpl }),
    /403.*rate limited/
  );
});
