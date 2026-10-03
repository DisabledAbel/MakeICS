import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
export const ARCHIVE_FILE = 'lib/data/archive/events.json';
const DATA_PREFIX = 'lib/data/';

async function git(args) {
  try {
    return (await execFile('git', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new Error(`unable to read trustworthy Git baseline (${args.join(' ')}): ${error.stderr?.trim() || error.message}`);
  }
}

function nonempty(value) { return value !== null && value !== undefined && String(value).trim() !== ''; }
function recordDate(record) { return record.dateEvent || record.airdate || record.releaseDate || record.strTimestamp || record.airstamp; }

export function entriesFromDocument(file, data) {
  if (file === ARCHIVE_FILE) {
    if (!data || data.version !== 1 || !Array.isArray(data.events)) throw new Error(`${file}: expected a version 1 events archive`);
    return data.events.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || !entry.identity || !entry.uid || !entry.kind || !entry.record || !entry.source) {
        throw new Error(`${file}: archived event ${index + 1} is malformed`);
      }
      return { ...entry, archived: true };
    });
  }
  if (file.endsWith('/upcoming.json') && Array.isArray(data?.movies)) {
    return data.movies.map(record => ({ kind: 'movie', identity: `movie:${record.id}`, uid: `imdb-movie-${record.id}@makeics.local`, source: file, record }));
  }
  if (file.endsWith('/imdb-episodes.json') && data?.shows && typeof data.shows === 'object') {
    return Object.entries(data.shows).flatMap(([showId, show]) => (show.episodes || []).map(record => {
      const id = record.id || record.url || `${record.season}:${record.number}`;
      return { kind: 'tv', identity: `tv:${showId}:${id}`, uid: `tvmaze-${id}@makeics.local`, source: file, record: { ...record, showId, showName: show.title } };
    }));
  }
  if (Array.isArray(data?.events)) return data.events.map(record => ({
    kind: 'sports', identity: `sports:${record.idEvent}`, uid: `sportsdb-${record.idEvent}@makeics.local`, source: file, record
  }));
  // Auxiliary data (for example TV date overrides) is not an event store.
  return [];
}

function validateEntry(entry, label) {
  const errors = [];
  if (!nonempty(entry.identity) || /:(?:undefined|null)?$/.test(entry.identity)) errors.push(`${label}: missing stable event identity`);
  if (!nonempty(entry.uid)) errors.push(`${label}: missing calendar UID`);
  const record = entry.record || {};
  if (!nonempty(recordDate(record))) errors.push(`${label}: missing required event date`);
  if (entry.kind === 'sports' && (!nonempty(record.idEvent) || !nonempty(record.strEvent))) errors.push(`${label}: sports event requires idEvent and strEvent`);
  if (entry.kind === 'movie' && (!nonempty(record.id) || !nonempty(record.title))) errors.push(`${label}: movie requires id and title`);
  if (entry.kind === 'tv' && (!nonempty(record.id || record.url || (nonempty(record.season) && nonempty(record.number))) || !nonempty(record.name))) errors.push(`${label}: TV episode requires identity and name`);
  if (!Number.isFinite(Date.parse(recordDate(record)))) errors.push(`${label}: invalid event date ${JSON.stringify(recordDate(record))}`);
  return errors;
}

async function filesAt(ref) {
  const output = await git(['ls-tree', '-r', '--name-only', '-z', ref, '--', 'lib/data']);
  return output.split('\0').filter(file => file.endsWith('.json'));
}

async function baselineDataset(ref) {
  // Resolve first so a shallow/mistyped SHA cannot be interpreted as an empty tree.
  await git(['cat-file', '-e', `${ref}^{commit}`]);
  const entries = [];
  for (const file of await filesAt(ref)) {
    let data;
    try { data = JSON.parse(await git(['show', `${ref}:${file}`])); }
    catch (error) { throw new Error(`unable to read trustworthy Git baseline file ${ref}:${file}: ${error.message}`); }
    entries.push(...entriesFromDocument(file, data));
  }
  return entries;
}

async function workspaceDataset() {
  const tracked = (await git(['ls-files', '-z', '--', 'lib/data'])).split('\0').filter(Boolean);
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', 'lib/data'])).split('\0').filter(Boolean);
  const entries = [];
  for (const file of new Set([...tracked, ...untracked])) {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    try { entries.push(...entriesFromDocument(file, JSON.parse(text))); }
    catch (error) { throw new Error(`${file}: malformed record data (${error.message})`); }
  }
  return entries;
}

export function compareHistory(before, after) {
  const errors = [];
  const current = new Map();
  const archived = new Set();
  for (const entry of after) {
    errors.push(...validateEntry(entry, `${entry.source} (${entry.identity})`));
    if (entry.archived && archived.has(entry.identity)) errors.push(`${entry.source}: duplicate archived identity ${entry.identity}`);
    if (entry.archived) archived.add(entry.identity);
    const existing = current.get(entry.identity);
    if (existing && existing.uid !== entry.uid) errors.push(`${entry.identity}: conflicting calendar UIDs (${existing.uid}, ${entry.uid})`);
    current.set(entry.identity, entry);
  }
  for (const old of before) {
    const retained = current.get(old.identity);
    if (!retained) errors.push(`${old.identity}: previously saved event is missing from live data and permanent archive`);
    else if (retained.uid !== old.uid) errors.push(`${old.identity}: calendar UID changed from ${old.uid} to ${retained.uid}`);
  }
  return errors;
}

export async function preserveAndValidate({ baseline = 'HEAD', archive = false } = {}) {
  const before = await baselineDataset(baseline);
  let after = await workspaceDataset();
  if (archive) {
    const currentIds = new Set(after.map(entry => entry.identity));
    const lost = before.filter(entry => !currentIds.has(entry.identity));
    if (lost.length) {
      let document = { version: 1, events: [] };
      try { document = JSON.parse(await fs.readFile(ARCHIVE_FILE, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const archiveIds = new Set(document.events.map(entry => entry.identity));
      for (const entry of lost) if (!archiveIds.has(entry.identity)) {
        document.events.push({ kind: entry.kind, identity: entry.identity, uid: entry.uid, source: entry.source, record: entry.record });
        archiveIds.add(entry.identity);
      }
      document.events.sort((a, b) => a.identity.localeCompare(b.identity));
      await fs.mkdir(path.dirname(ARCHIVE_FILE), { recursive: true });
      await fs.writeFile(ARCHIVE_FILE, `${JSON.stringify(document, null, 2)}\n`);
      after = await workspaceDataset();
    }
  }
  const errors = compareHistory(before, after);
  if (errors.length) throw new Error(`Calendar history validation failed against ${baseline}:\n- ${errors.join('\n- ')}`);
  return { baseline, previous: before.length, current: after.length };
}

async function main() {
  const baselineArg = process.argv.find(value => value.startsWith('--baseline='))?.slice(11);
  const result = await preserveAndValidate({ baseline: baselineArg || process.env.CALENDAR_HISTORY_BASELINE || 'HEAD^', archive: process.argv.includes('--archive') });
  if (process.argv.includes('--stage')) await git(['add', '--', 'lib/data']);
  console.log(`Calendar history preserved: ${result.previous} baseline event(s), ${result.current} resulting event(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
