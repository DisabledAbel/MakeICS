#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { checkFeeds } from '../lib/feed-health.js';

const feeds = [
  { name: 'TV', path: '/api/episodes?show=The%20Last%20of%20Us&format=ics' },
  { name: 'Sports', path: '/api/sports-events?teamId=136450&format=ics' },
  { name: 'Movies', path: '/api/movies?q=Animation&type=genre&format=ics' },
  { name: 'Combined', path: '/api/calendar?shows=Sofia%20the%20First&teamIds=136450&movies=Disney&movieType=studio&format=ics' }
];

const argument = process.argv.find(value => value.startsWith('--base-url='));
const baseUrl = argument?.slice('--base-url='.length) || process.env.FEED_HEALTH_BASE_URL;
if (!baseUrl) {
  console.error('FEED_HEALTH_BASE_URL or --base-url is required.');
  process.exitCode = 2;
} else {
  const timeoutMs = Number(process.env.FEED_HEALTH_TIMEOUT_MS || 20_000);
  const results = await checkFeeds(feeds, { baseUrl, timeoutMs });
  const report = { checkedAt: new Date().toISOString(), baseUrl, results };
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.ok ? `${result.eventCount} event(s)` : result.reason} (${result.url})`);
  }
  if (process.env.FEED_HEALTH_REPORT) {
    await writeFile(process.env.FEED_HEALTH_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (results.some(result => !result.ok)) process.exitCode = 1;
}
