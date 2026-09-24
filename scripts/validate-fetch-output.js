import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);

export const SOURCE_RULES = {
  af1: { paths: [/^lib\/data\/sports\/supplemental\/(?:148343|148348|148353|af1-[^/]+)\.json$/], minPrevious: 4, maxDrop: 0.6, emptyMonths: [8, 9, 10, 11, 12] },
  milb: { paths: [/^lib\/data\/sports\/supplemental\/[^/]+\.json$/], leagues: ['International League', 'Pacific Coast League', 'Northwest League'], minPrevious: 20, maxDrop: 0.65, emptyMonths: [10, 11, 12, 1, 2] },
  nba: { paths: [/^lib\/data\/sports\/supplemental\/\d+\.json$/], leagues: ['NBA'], minPrevious: 8, maxDrop: 0.6, emptyMonths: [7, 8] },
  nfl: { paths: [/^lib\/data\/sports\/supplemental\/\d+\.json$/], leagues: ['NFL'], minPrevious: 4, maxDrop: 0.6, emptyMonths: [2, 3, 4] },
  wnba: { paths: [/^lib\/data\/sports\/supplemental\/\d+\.json$/], leagues: ['WNBA'], minPrevious: 5, maxDrop: 0.65, emptyMonths: [11, 12, 1, 2, 3] },
  'portland-fire': { paths: [/^lib\/data\/sports\/supplemental\/152565\.json$/], leagues: ['WNBA'], minPrevious: 5, maxDrop: 0.65, emptyMonths: [11, 12, 1, 2, 3] },
  sports: { paths: [/^lib\/data\/sports\/(?!supplemental\/)[^/]+\.json$/, /^lib\/data\/sports\/supplemental\/[^/]+\.json$/], minPrevious: 8, maxDrop: 0.7, emptyMonths: [] },
  movies: { paths: [/^lib\/data\/movies\/upcoming\.json$/], minPrevious: 8, maxDrop: 0.65, emptyMonths: [] },
  imdb: { paths: [/^lib\/data\/tv\/imdb-episodes\.json$/], minPrevious: 5, maxDrop: 0.7, emptyMonths: [] }
};

function strictDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function eventDate(item) {
  return item.dateEvent || item.airdate || item.releaseDate || item.strTimestamp;
}

function validEventDate(item) {
  const value = eventDate(item);
  if (typeof value !== 'string' || !value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? strictDate(value) : Number.isFinite(Date.parse(value));
}

function records(data) {
  if (Array.isArray(data?.events)) return data.events.map(event => ({ event, key: event.idEvent }));
  if (Array.isArray(data?.movies)) return data.movies.map(movie => ({ event: movie, key: movie.id }));
  if (data?.shows && typeof data.shows === 'object') {
    return Object.entries(data.shows).flatMap(([showId, show]) => (show.episodes || []).map(episode => ({
      event: episode,
      key: `${showId}:${episode.url || `${episode.season}:${episode.number}`}`
    })));
  }
  throw new Error('expected an events, movies, or shows collection');
}

function upcomingCount(data, now) {
  return records(data).filter(({ event }) => Date.parse(eventDate(event)) >= now.getTime()).length;
}

export function validateData({ file, current, previous = null, rule, now = new Date() }) {
  const errors = [];
  let entries;
  try {
    entries = records(current);
  } catch (error) {
    return [`${file}: ${error.message}`];
  }

  const keys = new Set();
  entries.forEach(({ event, key }, index) => {
    if (!validEventDate(event)) errors.push(`${file}: event ${index + 1} has invalid date ${JSON.stringify(eventDate(event))}`);
    if (!key) errors.push(`${file}: event ${index + 1} has no stable ID`);
    else if (keys.has(String(key))) errors.push(`${file}: duplicate event ID ${key}`);
    keys.add(String(key));
  });

  if (rule.leagues && entries.some(({ event }) => event.strLeague && !rule.leagues.includes(event.strLeague))) {
    errors.push(`${file}: contains events outside this fetcher's leagues (${rule.leagues.join(', ')})`);
  }

  if (previous) {
    const before = upcomingCount(previous, now);
    const after = upcomingCount(current, now);
    const month = now.getUTCMonth() + 1;
    const expectedEmpty = after === 0 && rule.emptyMonths.includes(month);
    if (!expectedEmpty && before >= rule.minPrevious && after < before * (1 - rule.maxDrop)) {
      const drop = Math.round((1 - after / before) * 100);
      errors.push(`${file}: suspicious upcoming-event drop from ${before} to ${after} (${drop}%; maximum ${Math.round(rule.maxDrop * 100)}%)`);
    }
  }
  return errors;
}

async function git(args, options = {}) {
  return (await execFile('git', args, { encoding: 'utf8', ...options })).stdout;
}

async function changedDataFiles() {
  const [tracked, untracked] = await Promise.all([
    git(['diff', '--name-only', '--diff-filter=ACMRT', '-z', '--', 'lib/data']),
    git(['ls-files', '--others', '--exclude-standard', '-z', '--', 'lib/data'])
  ]);
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))];
}

async function previousJson(file) {
  try {
    return JSON.parse(await git(['show', `HEAD:${file}`]));
  } catch {
    return null;
  }
}

async function restore(files) {
  const tracked = [];
  const untracked = [];
  for (const file of files) {
    try { await git(['cat-file', '-e', `HEAD:${file}`]); tracked.push(file); }
    catch { untracked.push(file); }
  }
  if (tracked.length) await git(['restore', '--worktree', '--', ...tracked]);
  await Promise.all(untracked.map(file => fs.rm(file, { force: true })));
}

export async function validateChangedFiles(source, { stage = false, now = new Date() } = {}) {
  const rule = SOURCE_RULES[source];
  if (!rule) throw new Error(`Unknown fetch source ${source}`);
  const allChanged = await changedDataFiles();
  const files = allChanged.filter(file => rule.paths.some(pattern => pattern.test(file)));
  const foreign = allChanged.filter(file => !files.includes(file));
  const errors = foreign.map(file => `${file}: is not owned by the ${source} fetcher`);

  for (const file of files) {
    let current;
    try { current = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { errors.push(`${file}: malformed JSON (${error.message})`); continue; }
    errors.push(...validateData({ file, current, previous: await previousJson(file), rule, now }));
  }

  if (errors.length) {
    await restore(allChanged);
    throw new Error(`Data quality gate rejected the ${source} update; restored committed data:\n- ${errors.join('\n- ')}`);
  }
  if (stage && files.length) await git(['add', '--', ...files]);
  return files;
}

async function main() {
  const source = process.argv[2];
  const files = await validateChangedFiles(source, { stage: process.argv.includes('--stage') });
  console.log(files.length ? `Data quality gate passed for ${files.length} changed file(s).` : 'No data files changed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
