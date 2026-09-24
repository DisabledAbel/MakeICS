import fs from 'node:fs/promises';
import { evaluateSources, SOURCES } from '../lib/schedule-freshness.js';

async function successfulRuns() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const successes = {};
  await Promise.all(SOURCES.map(async source => {
    const url = `https://api.github.com/repos/${repository}/actions/workflows/${source.workflow}/runs?status=success&per_page=1`;
    const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${source.workflow}`);
    const run = (await response.json()).workflow_runs?.[0];
    if (run) successes[source.workflow] = run.updated_at;
  }));
  return successes;
}

const checkedAt = new Date().toISOString();
const results = evaluateSources({ now: checkedAt, successes: await successfulRuns() });
const report = { checkedAt, results };
await fs.writeFile(process.env.SCHEDULE_FRESHNESS_REPORT || 'schedule-freshness-report.json', `${JSON.stringify(report, null, 2)}\n`);
for (const item of results) console.log(`${item.status.toUpperCase()}: ${item.source}: ${item.signal}; ${item.reason}; last success: ${item.lastSuccess || 'never'}`);
if (results.some(item => item.status === 'stale')) process.exitCode = 1;
