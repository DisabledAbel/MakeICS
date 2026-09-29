import fs from 'node:fs/promises';
import { evaluateSources, SOURCES } from '../lib/schedule-freshness.js';
import { successfulWorkflowRuns } from '../lib/workflow-freshness.js';

const checkedAt = new Date().toISOString();
const successes = await successfulWorkflowRuns({ sources: SOURCES, repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN });
const results = evaluateSources({ now: checkedAt, successes });
const report = { checkedAt, results };
await fs.writeFile(process.env.SCHEDULE_FRESHNESS_REPORT || 'schedule-freshness-report.json', `${JSON.stringify(report, null, 2)}\n`);
for (const item of results) console.log(`${item.status.toUpperCase()}: ${item.source}: ${item.signal}; ${item.reason}; last success: ${item.lastSuccess || 'never'}`);
if (results.some(item => item.status === 'stale')) process.exitCode = 1;
