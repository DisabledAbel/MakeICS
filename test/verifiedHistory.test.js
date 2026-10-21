import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareHistory, entriesFromDocument } from '../scripts/calendar-history.js';
import { loadVerifiedOverrides, VERIFIED_FILE, VERIFIED_ARCHIVE_FILE } from '../lib/verified-history.js';
import { getEpisodes, toIcs } from '../lib/tvEpisodes.js';
import { buildCalendar, toIcs as combinedToIcs } from '../lib/calendar.js';

const key = 'Example-Show-1-2';
const old = { airdate: '2026-01-02', name: 'Saved title', verifiedAt: '2026-01-01T00:00:00Z' };
const newer = { ...old, airdate: '2026-01-03' };
const entries = (file, value) => entriesFromDocument(file, { [key]: value });

test('history guard rejects deleted verifications and stale archives but allows live corrections', () => {
  const before = entries(VERIFIED_FILE, newer);
  assert.match(compareHistory(before, []).join('\n'), /missing from live data and permanent archive/);
  assert.deepEqual(compareHistory(before, entries(VERIFIED_ARCHIVE_FILE, newer)), []);
  assert.match(compareHistory(before, entries(VERIFIED_ARCHIVE_FILE, old)).join('\n'), /latest saved correction/);
  for (const after of [
    [...entries(VERIFIED_FILE, newer), ...entries(VERIFIED_ARCHIVE_FILE, old)],
    [...entries(VERIFIED_ARCHIVE_FILE, old), ...entries(VERIFIED_FILE, newer)]
  ]) assert.deepEqual(compareHistory(entries(VERIFIED_FILE, old), after), []);
});

test('verification history rejects malformed documents, episode keys and dates', () => {
  assert.throws(() => entriesFromDocument(VERIFIED_FILE, []), /verification map/);
  const bad = entriesFromDocument(VERIFIED_FILE, { bad: { airdate: 'invalid' } });
  assert.match(compareHistory([], bad).join('\n'), /requires a show-season-episode key and airdate/);
});

test('verification loader merges archives and live corrections, and handles missing files', async () => {
  const fsImpl = { readFile: async url => JSON.stringify(url.pathname.includes('/archive/') ? { [key]: old, 'Past-1-1': old } : { [key]: newer }) };
  assert.deepEqual(await loadVerifiedOverrides(fsImpl), { [key]: newer, 'Past-1-1': old });
  assert.deepEqual(await loadVerifiedOverrides({ readFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), {});
  await assert.rejects(loadVerifiedOverrides({ readFile: async () => '{' }), SyntaxError);
});

test('CLI archives pruned verifications, replaces stale copies, stages deletions and is repeatable', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-history-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await fs.writeFile(path.join(cwd, file), JSON.stringify(value));
  };
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  await write(VERIFIED_FILE, { [key]: newer, 'Another-0-1': old });
  await write(VERIFIED_ARCHIVE_FILE, { [key]: old });
  git('add', '.');
  git('commit', '--quiet', '-m', 'baseline');
  await fs.unlink(path.join(cwd, VERIFIED_FILE));
  const script = fileURLToPath(new URL('../scripts/calendar-history.js', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, '--baseline=HEAD', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run().status, 1, 'a stale archive must not conceal a deleted correction');
  const first = run('--archive', '--stage');
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(cwd, VERIFIED_ARCHIVE_FILE);
  const saved = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(saved), { 'Another-0-1': old, [key]: newer });
  assert.match(git('diff', '--cached', '--name-only'), /archive\/google-verified.json/);
  assert.match(git('diff', '--cached', '--diff-filter=D', '--name-only'), /tv\/google-verified.json/);
  assert.equal(run('--archive', '--stage').status, 0);
  assert.equal(await fs.readFile(file, 'utf8'), saved, 'retries must not duplicate or rewrite history');
  git('commit', '--quiet', '-m', 'archive');
  assert.equal(run('--archive', '--stage').status, 0);
  assert.equal(git('status', '--porcelain'), '', 'unchanged runs must leave nothing to commit');
  await fs.unlink(file);
  assert.equal(run().status, 1, 'deleting the permanent archive must fail validation');
});

test('recovered verification preserves date, title and UIDs in individual and combined ICS feeds', async () => {
  const fetchImpl = async url => {
    if (url.includes('/singlesearch/shows')) return Response.json({ id: 900, name: 'Studio C', externals: {} });
    if (url.includes('/shows/900/episodes')) return Response.json([
      { id: 901, season: 23, number: 1, name: 'Changed provider title', airdate: '2026-09-01', airstamp: '2026-09-01T20:00:00Z', runtime: 30 }
    ]);
    throw new Error(`Unexpected request: ${url}`);
  };
  const result = await getEpisodes({ query: 'Studio C', fetchImpl, env: {}, since: '2026-10-01' });
  assert.equal(result.episodes.length, 1, 'archived date must be applied before the since filter');
  assert.equal(result.episodes[0].airdate, '2026-10-19');
  assert.equal(result.episodes[0].name, 'Have I Shocked You? with Pete Holmes');
  const individual = toIcs(result);
  assert.match(individual, /UID:tvmaze-901@makeics.local/);
  assert.match(individual, /DTSTART:20261019T200000Z/);
  const combined = await buildCalendar({ shows: ['Studio C'], loaders: { getEpisodes: async () => result } });
  const feed = combinedToIcs(combined);
  assert.match(feed, /UID:makeics-tv-900-901@makeics/);
  assert.match(feed, /DTSTART:20261019T200000Z/);
  assert.equal((feed.match(/BEGIN:VEVENT/g) || []).length, 1);
  const filtered = await getEpisodes({ query: 'Studio C', fetchImpl, env: {}, since: '2026-10-20' });
  assert.equal(filtered.episodes.length, 0, 'explicit since filters still apply');
});
