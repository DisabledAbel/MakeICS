import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeScrapedEvent } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '../lib/data/sports/supplemental');
const API = 'https://api-web.nhle.com/v1';
const ACTIVE_TEAMS_URL = `${API}/standings/now`;
const MAX_CONCURRENCY = 6;

// TheSportsDB IDs are MakeICS's public team IDs. Aliases are deliberately
// explicit: loose/fuzzy matching could silently assign New York teams wrongly.
export const NHL_TEAMS = Object.freeze([
  ['ANA','Anaheim Ducks','134846'], ['BOS','Boston Bruins','134830'], ['BUF','Buffalo Sabres','134831'],
  ['CGY','Calgary Flames','134848'], ['CAR','Carolina Hurricanes','134838'], ['CHI','Chicago Blackhawks','134854'],
  ['COL','Colorado Avalanche','134855'], ['CBJ','Columbus Blue Jackets','134839'], ['DAL','Dallas Stars','134856'],
  ['DET','Detroit Red Wings','134832'], ['EDM','Edmonton Oilers','134849'], ['FLA','Florida Panthers','134833'],
  ['LAK','Los Angeles Kings','134852'], ['MIN','Minnesota Wild','134857'], ['MTL','Montreal Canadiens','134834'],
  ['NSH','Nashville Predators','134858'], ['NJD','New Jersey Devils','134840'], ['NYI','New York Islanders','134841'],
  ['NYR','New York Rangers','134842'], ['OTT','Ottawa Senators','134835'], ['PHI','Philadelphia Flyers','134843'],
  ['PIT','Pittsburgh Penguins','134844'], ['SJS','San Jose Sharks','134853'], ['SEA','Seattle Kraken','140082'],
  ['STL','St. Louis Blues','134859'], ['TBL','Tampa Bay Lightning','134836'], ['TOR','Toronto Maple Leafs','134837'],
  ['UTA','Utah Mammoth','148494',['Utah Hockey Club']], ['VAN','Vancouver Canucks','134850'],
  ['VGK','Vegas Golden Knights','135913'], ['WSH','Washington Capitals','134845'], ['WPG','Winnipeg Jets','134851']
].map(([abbrev, name, id, aliases = []]) => ({ abbrev, name, id, aliases })));

const normalizeName = value => String(value || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const localized = value => typeof value === 'string' ? value : value?.default || value?.fr || '';

export async function fetchJson(url, fetchImpl = globalThis.fetch, {
  timeoutMs = 20_000, attempts = 4, baseDelayMs = 500, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'MakeICS-NHL-Fetcher/1.0' } });
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

export function mapActiveTeams(payload) {
  if (!Array.isArray(payload?.standings) || payload.standings.length < 32) throw new Error(`NHL standings response contained ${payload?.standings?.length || 0} teams; expected at least 32`);
  const configured = new Map();
  for (const team of NHL_TEAMS) for (const name of [team.name, ...team.aliases]) {
    const key = normalizeName(name);
    if (configured.has(key)) throw new Error(`Ambiguous configured NHL alias: ${name}`);
    configured.set(key, team);
  }
  const result = new Map();
  for (const row of payload.standings) {
    const abbreviation = localized(row.teamAbbrev);
    const apiName = localized(row.teamName) || `${localized(row.placeName)} ${localized(row.teamCommonName)}`.trim();
    const candidates = NHL_TEAMS.filter(team => team.abbrev === abbreviation || [team.name, ...team.aliases].some(name => normalizeName(name) === normalizeName(apiName)));
    if (candidates.length !== 1) throw new Error(`NHL team mapping for ${apiName || abbreviation} was ${candidates.length ? 'ambiguous' : 'not found'}`);
    if (result.has(candidates[0].id)) throw new Error(`NHL team ${candidates[0].name} appeared more than once`);
    result.set(candidates[0].id, candidates[0]);
  }
  if (result.size !== NHL_TEAMS.length) throw new Error(`Mapped ${result.size} active NHL teams; expected ${NHL_TEAMS.length}`);
  return [...result.values()].sort((a, b) => a.abbrev.localeCompare(b.abbrev));
}

export function seasonCandidates(now = new Date()) {
  const year = now.getUTCFullYear();
  // Query the seasons on either side of the summer boundary. The API confirms
  // which one has published future games, so rollover does not depend on a
  // hardcoded season year or publication date.
  return [year - 1, year, year + 1].map(start => `${start}${start + 1}`);
}

function statusFor(game) {
  const state = String(game.gameState || '').toUpperCase();
  const scheduleState = String(game.gameScheduleState || '').toUpperCase();
  if (state === 'POSTPONED' || ['PPD', 'POSTPONED'].includes(scheduleState)) return 'Postponed';
  if (['CANCELLED', 'CANCELED'].includes(state) || ['CNCL', 'CANCELLED', 'CANCELED'].includes(scheduleState)) return 'Cancelled';
  if (['LIVE', 'CRIT'].includes(state)) return 'In Progress';
  if (['OFF', 'FINAL'].includes(state)) return 'FT';
  if (!game.startTimeUTC || game.timeRemaining?.trim() === 'TBD') return 'TBD';
  return 'NS';
}

export function parseSchedule(payload, teams, now = new Date()) {
  if (!Array.isArray(payload?.games)) throw new Error('NHL club schedule response did not contain games');
  const byAbbrev = new Map(teams.map(team => [team.abbrev, team]));
  const games = [];
  for (const game of payload.games) {
    if (![1, 2, 3].includes(Number(game.gameType))) continue;
    if (!/^\d+$/.test(String(game.id || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(game.gameDate || '')) throw new Error('NHL game has an invalid ID or date');
    const timestamp = game.startTimeUTC || `${game.gameDate}T00:00:00Z`;
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`NHL game ${game.id} has an invalid start time`);
    const status = statusFor(game);
    if (Date.parse(timestamp) < now.getTime() && !['Postponed', 'TBD'].includes(status)) continue;
    const home = byAbbrev.get(localized(game.homeTeam?.abbrev));
    const away = byAbbrev.get(localized(game.awayTeam?.abbrev));
    if (!home || !away) throw new Error(`Unmapped NHL participants in game ${game.id || '(missing ID)'}`);
    games.push({
      id: String(game.id), date: new Date(timestamp).toISOString().replace('.000Z', 'Z'), officialDate: game.gameDate,
      name: `${home.name} vs ${away.name}`, homeTeam: home.name, awayTeam: away.name,
      homeId: home.id, awayId: away.id, league: 'NHL', venue: localized(game.venue) || null,
      broadcast: Array.isArray(game.tvBroadcasts) ? [...new Set(game.tvBroadcasts.map(item => item.network).filter(Boolean))].join(', ') || null : null,
      status
    });
  }
  return games;
}

async function pooled(items, limit, worker) {
  let next = 0;
  const output = [];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await worker(items[index]); }
  }));
  return output;
}

const withoutRevision = ({ updatedAt, ...event }) => event;
const equalEvent = (a, b) => JSON.stringify(withoutRevision(a)) === JSON.stringify(withoutRevision(b));

export async function fetchNhlSchedules({ fetchImpl = globalThis.fetch, outputDir = OUTPUT_DIR, now = new Date(), requestOptions = {} } = {}) {
  const teams = mapActiveTeams(await fetchJson(ACTIVE_TEAMS_URL, fetchImpl, requestOptions));
  const requests = teams.flatMap(team => seasonCandidates(now).map(season => ({ team, season })));
  const payloads = await pooled(requests, MAX_CONCURRENCY, async request => ({ ...request, payload: await fetchJson(`${API}/club-schedule-season/${request.team.abbrev}/${request.season}`, fetchImpl, requestOptions) }));
  let parsed = payloads.flatMap(({ payload }) => parseSchedule(payload, teams, now));
  // Every club endpoint repeats a game. The NHL game ID, rather than teams and
  // time, is the identity so a doubleheader is retained and a reschedule updates.
  const byId = new Map();
  for (const game of parsed) {
    const previous = byId.get(game.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(game)) throw new Error(`Conflicting NHL records for game ${game.id}`);
    byId.set(game.id, game);
  }
  parsed = [...byId.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
  const month = now.getUTCMonth() + 1;
  if (!parsed.length && ![7, 8].includes(month)) throw new Error('NHL returned no upcoming preseason, regular-season, or playoff games outside the normal offseason; existing files were preserved');

  await fs.mkdir(outputDir, { recursive: true });
  let writtenTeams = 0;
  for (const team of teams) {
    const teamGames = parsed.filter(game => game.homeId === team.id || game.awayId === team.id);
    if (!teamGames.length) continue; // retain the last known schedule in the offseason
    const file = path.join(outputDir, `${team.id}.json`);
    let existing;
    try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let events = teamGames.map(game => ({ ...normalizeScrapedEvent(game, team.name), idEvent: `nhl-${game.id}`, sourceEventId: String(game.id), idHomeTeam: game.homeId, idAwayTeam: game.awayId }));
    // One-time migration from non-NHL IDs only when date and participants identify exactly one fixture.
    events = events.map(event => {
      const identityMatch = (existing?.events || []).find(old => old.idEvent === event.idEvent || old.sourceEventId === event.sourceEventId);
      if (identityMatch) return { ...event, idEvent: identityMatch.idEvent };
      const matches = (existing?.events || []).filter(old => old.dateEvent === event.dateEvent && old.strHomeTeam === event.strHomeTeam && old.strAwayTeam === event.strAwayTeam);
      return matches.length === 1 ? { ...event, idEvent: matches[0].idEvent } : event;
    });
    const existingEvents = existing?.events || [];
    const unchanged = events.length === existingEvents.length && events.every((event, index) => equalEvent(event, existingEvents[index]));
    if (unchanged) continue;
    const updatedAt = now.toISOString();
    events = events.map(event => {
      const old = existingEvents.find(item => item.idEvent === event.idEvent);
      return { ...event, updatedAt: old && equalEvent(event, old) ? old.updatedAt || updatedAt : updatedAt };
    });
    await fs.writeFile(file, `${JSON.stringify({ teamId: team.id, teamName: team.name, updatedAt, events }, null, 2)}\n`);
    writtenTeams++;
  }
  return { teams: teams.length, games: parsed.length, writtenTeams };
}

async function main() {
  const result = await fetchNhlSchedules();
  console.log(`Found ${result.games} upcoming NHL games for ${result.teams} teams; wrote ${result.writtenTeams} schedules.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('NHL schedule fetch failed:', error); process.exitCode = 1; });
