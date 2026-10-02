import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '../lib/data/sports/supplemental');
const ESPN_BASE = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/usa.1';
const DIRECTORY_URL = `${ESPN_BASE}/teams?limit=100`;
const MAX_CONCURRENCY = 5;

// Public calendar URLs use TheSportsDB IDs. Keep this mapping explicit so an
// upstream rename cannot silently move a schedule to another subscription URL.
export const MLS_TEAMS = Object.freeze([
  ['Atlanta United', '135851'], ['Austin FC', '140079'], ['CF Montréal', '134150', ['CF Montreal', 'Montreal Impact']],
  ['Charlotte FC', '140078'], ['Chicago Fire', '134154', ['Chicago Fire FC']], ['Colorado Rapids', '134794'],
  ['Columbus Crew', '134152'], ['D.C. United', '134145', ['DC United']], ['FC Cincinnati', '136688'],
  ['FC Dallas', '134146'], ['Houston Dynamo', '134144', ['Houston Dynamo FC']], ['Inter Miami', '137699', ['Inter Miami CF']],
  ['LA Galaxy', '134153'], ['Los Angeles FC', '136050', ['LAFC']], ['Minnesota United', '135852', ['Minnesota United FC']],
  ['Nashville SC', '137700'], ['New England Revolution', '134159'], ['New York City FC', '134630'],
  ['New York Red Bulls', '134156', ['Red Bull New York']], ['Orlando City', '135292', ['Orlando City SC']],
  ['Philadelphia Union', '134142'], ['Portland Timbers', '134155'], ['Real Salt Lake', '134158'],
  ['San Diego FC', '150261'], ['San Jose Earthquakes', '134157'], ['Seattle Sounders', '134149', ['Seattle Sounders FC']],
  ['Sporting Kansas City', '134143'], ['St. Louis City SC', '147062', ['St. Louis CITY SC']],
  ['Toronto FC', '134148'], ['Vancouver Whitecaps', '134147', ['Vancouver Whitecaps FC']]
].map(([name, id, aliases = []]) => ({ name, id, aliases })));

const normalizeName = value => String(value || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function fetchJson(url, fetchImpl = globalThis.fetch, {
  timeoutMs = 20_000, attempts = 4, baseDelayMs = 500,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'MakeICS-MLS-Fetcher/1.0' } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        await response.body?.cancel();
        throw error;
      }
      const payload = await response.json();
      if (!payload || typeof payload !== 'object') throw new Error('response was not a JSON object');
      return payload;
    } catch (error) {
      last = new Error(`${url}: ${controller.signal.aborted ? `timed out after ${timeoutMs}ms` : error.message} (attempt ${attempt}/${attempts})`, { cause: error });
      if (error.retryable === false || attempt === attempts) throw last;
    } finally { clearTimeout(timer); }
    await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  throw last;
}

/** Resolve all active ESPN clubs to one explicit TheSportsDB identity each. */
export function mapActiveTeams(payload) {
  const league = payload?.sports?.[0]?.leagues?.[0];
  if (league?.slug !== 'usa.1' && !/major league soccer/i.test(league?.name || '')) throw new Error('ESPN team directory was not Major League Soccer');
  const directory = league?.teams?.map(entry => entry.team).filter(Boolean);
  if (!Array.isArray(directory) || directory.length !== MLS_TEAMS.length) throw new Error(`MLS directory contained ${directory?.length || 0} teams; expected ${MLS_TEAMS.length}`);
  const configuredNames = new Map();
  for (const team of MLS_TEAMS) for (const name of [team.name, ...team.aliases]) {
    const key = normalizeName(name);
    if (configuredNames.has(key) && configuredNames.get(key) !== team) throw new Error(`Ambiguous configured MLS alias: ${name}`);
    configuredNames.set(key, team);
  }
  const mapped = new Map();
  for (const espn of directory) {
    const candidates = [...new Set([espn.displayName, espn.name, espn.shortDisplayName]
      .map(name => configuredNames.get(normalizeName(name))).filter(Boolean))];
    if (candidates.length !== 1 || !/^\d+$/.test(String(espn.id || ''))) throw new Error(`MLS team mapping for ${espn.displayName || espn.name || '(unnamed team)'} was ${candidates.length > 1 ? 'ambiguous' : 'not found'}`);
    const team = candidates[0];
    if (mapped.has(team.id)) throw new Error(`MLS team ${team.name} appeared more than once`);
    mapped.set(team.id, { ...team, espnId: String(espn.id) });
  }
  if (mapped.size !== MLS_TEAMS.length) throw new Error(`Mapped ${mapped.size} active MLS teams; expected ${MLS_TEAMS.length}`);
  return [...mapped.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** MLS seasons are calendar years; begin probing next year late in the offseason. */
export function seasonCandidates(now = new Date()) {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 10 ? [year, year + 1] : [year];
}

function statusFor(competition) {
  const status = competition?.status?.type || {};
  const text = `${status.name || ''} ${status.description || ''} ${status.detail || ''}`.toLowerCase();
  if (text.includes('postpon')) return 'Postponed';
  if (text.includes('cancel')) return 'Cancelled';
  if (status.state === 'in') return 'In Progress';
  if (status.completed || status.state === 'post') return 'FT';
  if (text.includes('tbd') || text.includes('to be determined')) return 'TBD';
  return 'NS';
}

/** Parse an ESPN fixture response after verifying its requested season and league. */
export function parseSchedule(payload, { season, byEspnId, now = new Date() }) {
  const returnedSeason = Number(payload?.season?.year);
  const leagueText = `${payload?.league?.slug || ''} ${payload?.league?.name || ''} ${payload?.league?.abbreviation || ''}`;
  if (returnedSeason !== Number(season)) throw new Error(`MLS schedule returned season ${payload?.season?.year ?? '(missing)'} instead of ${season}`);
  if (!/(usa\.1|major league soccer|\bMLS\b)/i.test(leagueText)) throw new Error('MLS schedule response did not identify Major League Soccer');
  if (!Array.isArray(payload?.events)) throw new Error('MLS schedule response did not contain events');
  return payload.events.flatMap(event => {
    const competition = event?.competitions?.[0];
    if (!/^\d+$/.test(String(event?.id || '')) || !competition || !Number.isFinite(Date.parse(event.date))) throw new Error('MLS fixture has an invalid ID, competition, or kickoff');
    const status = statusFor(competition);
    if (Date.parse(event.date) < now.getTime() && !['Postponed', 'TBD'].includes(status)) return [];
    const homeEntry = competition.competitors?.find(item => item.homeAway === 'home');
    const awayEntry = competition.competitors?.find(item => item.homeAway === 'away');
    const home = byEspnId.get(String(homeEntry?.team?.id || ''));
    const away = byEspnId.get(String(awayEntry?.team?.id || ''));
    if (!home || !away) throw new Error(`Unmapped MLS participants in fixture ${event.id}`);
    const broadcasts = (competition.broadcasts || []).flatMap(item => item.names || item.media?.shortName || []).filter(Boolean);
    const timestamp = new Date(event.date).toISOString().replace('.000Z', 'Z');
    return [{
      idEvent: `mls-${event.id}`, sourceEventId: String(event.id), strEvent: `${home.name} vs ${away.name}`,
      strHomeTeam: home.name, strAwayTeam: away.name, idHomeTeam: home.id, idAwayTeam: away.id,
      dateEvent: timestamp.slice(0, 10), strTime: timestamp.slice(11, 19), strTimestamp: timestamp,
      strLeague: 'MLS', strVenue: competition.venue?.fullName || null, strStatus: status,
      strTVStation: [...new Set(broadcasts)].sort().join(', ') || null, source: 'espn'
    }];
  });
}

async function pooled(items, limit, worker) {
  let next = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await worker(items[index]); }
  }));
  return results;
}

const withoutRevision = ({ updatedAt, ...event }) => event;
const equalEvent = (a, b) => JSON.stringify(withoutRevision(a)) === JSON.stringify(withoutRevision(b));

export async function fetchMlsSchedules({ fetchImpl = globalThis.fetch, outputDir = OUTPUT_DIR, now = new Date(), requestOptions = {} } = {}) {
  const teams = mapActiveTeams(await fetchJson(DIRECTORY_URL, fetchImpl, requestOptions));
  const byEspnId = new Map(teams.map(team => [team.espnId, team]));
  const requests = teams.flatMap(team => seasonCandidates(now).map(season => ({ team, season })));
  const responses = await pooled(requests, MAX_CONCURRENCY, async ({ team, season }) => {
    const url = `${ESPN_BASE}/teams/${team.espnId}/schedule?season=${season}&fixture=true`;
    return { season, payload: await fetchJson(url, fetchImpl, requestOptions) };
  });
  const byId = new Map();
  for (const { season, payload } of responses) for (const event of parseSchedule(payload, { season, byEspnId, now })) {
    const old = byId.get(event.sourceEventId);
    if (old && JSON.stringify(old) !== JSON.stringify(event)) throw new Error(`Conflicting MLS records for fixture ${event.sourceEventId}`);
    byId.set(event.sourceEventId, event);
  }
  const events = [...byId.values()].sort((a, b) => Date.parse(a.strTimestamp) - Date.parse(b.strTimestamp) || a.sourceEventId.localeCompare(b.sourceEventId));
  const month = now.getUTCMonth() + 1;
  if (!events.length && ![12, 1].includes(month)) throw new Error('MLS returned no upcoming fixtures during the active season; existing files were preserved');

  await fs.mkdir(outputDir, { recursive: true });
  let writtenTeams = 0;
  for (const team of teams) {
    let teamEvents = events.filter(event => event.idHomeTeam === team.id || event.idAwayTeam === team.id);
    if (!teamEvents.length) continue;
    const file = path.join(outputDir, `${team.id}.json`);
    let existing;
    try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const oldEvents = existing?.events || [];
    // Identity comes only from the ESPN event ID, never mutable kickoff details.
    teamEvents = teamEvents.map(event => {
      const old = oldEvents.find(item => item.sourceEventId === event.sourceEventId || item.idEvent === event.idEvent);
      return old ? { ...event, idEvent: old.idEvent } : event;
    });
    if (teamEvents.length === oldEvents.length && teamEvents.every((event, index) => equalEvent(event, oldEvents[index]))) continue;
    const updatedAt = now.toISOString();
    teamEvents = teamEvents.map(event => {
      const old = oldEvents.find(item => item.idEvent === event.idEvent);
      return { ...event, updatedAt: old && equalEvent(event, old) ? old.updatedAt || updatedAt : updatedAt };
    });
    await fs.writeFile(file, `${JSON.stringify({ teamId: team.id, teamName: team.name, updatedAt, events: teamEvents }, null, 2)}\n`);
    writtenTeams++;
  }
  return { teams: teams.length, fixtures: events.length, writtenTeams };
}

async function main() {
  const result = await fetchMlsSchedules();
  console.log(`Found ${result.fixtures} upcoming MLS fixtures for ${result.teams} teams; wrote ${result.writtenTeams} schedules.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('MLS schedule fetch failed:', error); process.exitCode = 1; });
