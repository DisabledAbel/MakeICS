import fs from 'node:fs';
import path from 'node:path';

const DAY = 86_400_000;

// Months are UTC month numbers.  A source is only held to its data-horizon
// expectation while it normally publishes a schedule.
export const SOURCES = [
  { id: 'movies', name: 'IMDb movie releases', workflow: 'fetch-movies.yml', files: ['lib/data/movies/upcoming.json'], activeMonths: [1,2,3,4,5,6,7,8,9,10,11,12], horizonDays: 14, fetchGraceDays: 3 },
  { id: 'imdb', name: 'IMDb TV episodes', workflow: 'fetch-imdb.yml', files: ['lib/data/tv/imdb-episodes.json'], activeMonths: [1,2,3,4,5,6,7,8,9,10,11,12], horizonDays: -14, fetchGraceDays: 3 },
  { id: 'sports', name: 'TheSportsDB sports schedules', workflow: 'fetch-sports.yml', directories: ['lib/data/sports'], excludeSupplemental: true, activeMonths: [1,2,3,4,5,6,7,8,9,10,11,12], horizonDays: 7, fetchGraceDays: 2 },
  { id: 'nba', name: 'NBA schedule', workflow: 'fetch-nba.yml', matchLeague: 'NBA', directories: ['lib/data/sports/supplemental'], activeMonths: [1,2,3,4,5,6,8,9,10,11,12], horizonDays: 7, fetchGraceDays: 2 },
  { id: 'nfl', name: 'NFL schedule', workflow: 'fetch-nfl.yml', matchLeague: 'NFL', directories: ['lib/data/sports/supplemental'], activeMonths: [1,2,5,6,7,8,9,10,11,12], horizonDays: 14, fetchGraceDays: 3 },
  { id: 'wnba', name: 'WNBA schedule', workflow: 'fetch-wnba.yml', matchLeague: 'WNBA', directories: ['lib/data/sports/supplemental'], activeMonths: [1,2,3,4,5,6,7,8,9,10], horizonDays: -7, fetchGraceDays: 3 },
  { id: 'portland-fire', name: 'Portland Fire schedule', workflow: 'fetch-wnba.yml', files: ['lib/data/sports/supplemental/152565.json'], activeMonths: [1,2,3,4,5,6,7,8,9,10], horizonDays: -7, fetchGraceDays: 3 },
  { id: 'milb', name: 'MiLB schedules', workflow: 'fetch-milb.yml', matchLeague: /League$/, directories: ['lib/data/sports/supplemental'], activeMonths: [1,2,3,4,5,6,7,8,9], horizonDays: -7, fetchGraceDays: 3 },
  { id: 'af1', name: 'AF1 schedule', workflow: 'fetch-af1.yml', filePrefix: 'af1-', fileNames: ['148343.json', '148348.json', '148353.json'], directories: ['lib/data/sports/supplemental'], activeMonths: [1,2,3,4,5,6,7,8], horizonDays: 7, fetchGraceDays: 3 }
];

function walkJson(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walkJson(full) : entry.name.endsWith('.json') ? [full] : [];
  });
}

function datesFrom(value, dates = []) {
  if (Array.isArray(value)) value.forEach(item => datesFrom(item, dates));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['dateEvent', 'strTimestamp', 'releaseDate', 'airdate', 'date'].includes(key) && typeof child === 'string') {
        const time = Date.parse(child);
        if (Number.isFinite(time)) dates.push(time);
      } else datesFrom(child, dates);
    }
  }
  return dates;
}

export function inspectSourceData(source, root = process.cwd()) {
  let files = (source.files || []).map(file => path.join(root, file));
  for (const directory of source.directories || []) files.push(...walkJson(path.join(root, directory)));
  files = [...new Set(files)].filter(file => {
    if (source.excludeSupplemental && file.includes(`${path.sep}supplemental${path.sep}`)) return false;
    if (source.filePrefix && !path.basename(file).startsWith(source.filePrefix) && !source.fileNames?.includes(path.basename(file))) return false;
    return true;
  });
  const dates = [];
  let matchedFiles = 0;
  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (source.matchLeague) {
      const leagues = (data.events || []).map(event => event?.strLeague).filter(Boolean);
      const match = leagues.some(league => source.matchLeague instanceof RegExp ? source.matchLeague.test(league) : league === source.matchLeague);
      if (!match) continue;
    }
    matchedFiles++;
    datesFrom(data, dates);
  }
  const newest = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
  return { newest, matchedFiles, datedRecords: dates.length };
}

export function evaluateSource(source, { now, lastSuccess, signal }) {
  const current = new Date(now);
  const active = source.activeMonths.includes(current.getUTCMonth() + 1);
  const fetchAgeDays = lastSuccess ? (current - new Date(lastSuccess)) / DAY : Infinity;
  const horizonDays = signal.newest ? (new Date(signal.newest) - current) / DAY : -Infinity;
  const reasons = [];
  if (fetchAgeDays > source.fetchGraceDays) reasons.push(lastSuccess ? `last successful workflow run was ${Math.floor(fetchAgeDays)} days ago` : 'no successful workflow run was found');
  if (active && horizonDays < source.horizonDays) reasons.push(signal.newest ? `newest scheduled item is only ${Math.floor(horizonDays)} days ahead` : 'no dated schedule items were found');
  return {
    id: source.id, source: source.name, workflow: source.workflow, status: reasons.length ? 'stale' : active ? 'fresh' : 'offseason',
    lastSuccess: lastSuccess || null,
    signal: signal.newest ? `newest dated item ${signal.newest.slice(0, 10)} (${signal.datedRecords} dates in ${signal.matchedFiles} files)` : `no dated items (${signal.matchedFiles} matching files)`,
    reason: reasons.join('; ') || (active ? `successful fetch is recent and data extends ${Math.floor(horizonDays)} days ahead` : `month ${current.getUTCMonth() + 1} is an expected offseason`)
  };
}

export function evaluateSources({ sources = SOURCES, now = new Date(), successes = {}, root = process.cwd(), signals = {} } = {}) {
  return sources.map(source => evaluateSource(source, { now, lastSuccess: successes[source.workflow], signal: signals[source.id] || inspectSourceData(source, root) }));
}
