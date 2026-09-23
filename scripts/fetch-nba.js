import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeScrapedEvent } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPLEMENTAL_DATA_DIR = path.join(__dirname, '../lib/data/sports/supplemental');
const SPORTSDB_TEAMS_URL = 'https://www.thesportsdb.com/api/v1/json/3/search_all_teams.php?l=NBA';
const NBA_SCHEDULE_URL = 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json';
const ESPN_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const FETCH_TIMEOUT_MS = 30_000;
const NBA_LEAGUE_FILE = path.join(__dirname, '../lib/data/sports/4387.json');

async function fetchTeams(fetchImpl, requestOptions, leagueFile) {
  try {
    const payload = await fetchJson(SPORTSDB_TEAMS_URL, fetchImpl, requestOptions);
    if (!Array.isArray(payload?.teams) || payload.teams.length !== 30) {
      throw new Error(`Expected all 30 NBA teams, received ${payload?.teams?.length || 0}`);
    }
    return payload.teams;
  } catch (error) {
    console.warn(`NBA team lookup unavailable: ${error.message}; using saved NBA team IDs.`);
    const payload = JSON.parse(await fs.readFile(leagueFile, 'utf8'));
    const teams = new Map();
    if (String(payload.leagueId) !== '4387') throw new Error('Saved team mapping is not NBA data');
    for (const event of payload.events || []) {
      for (const side of ['Home', 'Away']) {
        const idTeam = String(event[`id${side}Team`] || '');
        const strTeam = event[`str${side}Team`];
        if (/^\d{6}$/.test(idTeam) && strTeam) teams.set(idTeam, { idTeam, strTeam });
      }
    }
    if (teams.size !== 30) throw new Error(`Expected 30 saved NBA team IDs, received ${teams.size}`);
    return [...teams.values()];
  }
}

export async function fetchJson(url, fetchImpl = globalThis.fetch, {
  timeoutMs = FETCH_TIMEOUT_MS,
  attempts = 3,
  retryDelayMs = 1000
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let failure;
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'MakeICS-NBA-Fetcher/1.0' }
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = [408, 429].includes(response.status) || response.status >= 500;
        await response.body?.cancel();
        throw error;
      }
      return await response.json();
    } catch (error) {
      failure = new Error(`${url}: ${controller.signal.aborted ? `timed out after ${timeoutMs}ms` : error.message} (attempt ${attempt}/${attempts})`, { cause: error });
      if (error.retryable === false || attempt === attempts) throw failure;
    } finally {
      clearTimeout(timeout);
    }
    console.warn(`${failure.message}; retrying.`);
    await new Promise(resolve => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
  }
}

/** Fetch each team's full season, avoiding ESPN's truncated league scoreboard. */
async function fetchEspnGames(teams, now, fetchImpl, requestOptions) {
  const directory = await fetchJson(`${ESPN_BASE_URL}/teams?limit=100`, fetchImpl, requestOptions);
  const espnTeams = directory?.sports?.[0]?.leagues?.[0]?.teams?.map(entry => entry.team) || [];
  const teamNames = new Map();
  const canonicalName = name => normalizeName(name).replace(/^la(?=clippers$)/, 'losangeles');
  for (const team of teams) {
    const matches = espnTeams.filter(candidate => canonicalName(candidate.displayName) === canonicalName(team.strTeam));
    if (matches.length !== 1 || !/^\d+$/.test(String(matches[0].id))) {
      throw new Error(`Could not resolve ESPN team for ${team.strTeam}`);
    }
    teamNames.set(String(matches[0].id), team.strTeam);
  }

  // ESPN uses the year in which the season ends. July starts the next season.
  const season = now.getUTCFullYear() + (now.getUTCMonth() >= 6 ? 1 : 0);
  const requests = [...teamNames.keys()].flatMap(id => [1, 2, 3].map(type => ({ id, type })));
  const games = [];
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (!failure && next < requests.length) {
      const { id, type } = requests[next++];
      try {
        const url = `${ESPN_BASE_URL}/teams/${id}/schedule?season=${season}&seasontype=${type}`;
        const payload = await fetchJson(url, fetchImpl, requestOptions);
        if (!Array.isArray(payload?.events)) throw new Error(`Missing ESPN events for team ${id}, season type ${type}`);
        for (const event of payload.events) {
          const competition = event.competitions?.[0];
          if (competition?.status?.type?.state !== 'pre' || Date.parse(event.date) < now.getTime()) continue;
          const home = competition.competitors?.find(team => team.homeAway === 'home')?.team;
          const away = competition.competitors?.find(team => team.homeAway === 'away')?.team;
          // Preseason can include non-NBA opponents; only NBA-vs-NBA games can be mapped.
          if (!teamNames.has(String(home?.id)) || !teamNames.has(String(away?.id))) continue;
          if (!event.id || !Number.isFinite(Date.parse(event.date))) throw new Error(`Invalid ESPN game for team ${id}`);
          const homeTeam = teamNames.get(String(home.id));
          const awayTeam = teamNames.get(String(away.id));
          games.push({
            id: `espn-${event.id}`,
            date: new Date(event.date).toISOString().replace('.000Z', 'Z'),
            officialDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(event.date)),
            name: `${homeTeam} vs ${awayTeam}`, homeTeam, awayTeam,
            venue: competition.venue?.fullName || null,
            broadcast: competition.broadcasts?.[0]?.media?.shortName || competition.broadcasts?.[0]?.names?.[0] || null,
            league: 'NBA'
          });
        }
      } catch (error) {
        failure ||= error;
      }
    }
  }));
  if (failure) throw failure;
  return [...new Map(games.map(game => [game.id, game])).values()]
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
}

/** Convert the NBA's complete league schedule into upcoming, normalized source games. */
export function parseUpcomingGames(payload, now = new Date()) {
  const gameDates = payload?.leagueSchedule?.gameDates;
  if (!Array.isArray(gameDates)) {
    throw new Error('NBA schedule response did not contain leagueSchedule.gameDates');
  }

  const nowMs = now.getTime();
  const games = gameDates.flatMap(({ games: dateGames = [] }) => dateGames)
    .filter(game => {
      const start = Date.parse(game.gameDateTimeUTC);
      return Number.isFinite(start) && start >= nowMs && Number(game.gameStatus) === 1;
    })
    .map(game => {
      const homeTeam = `${game.homeTeam?.teamCity || ''} ${game.homeTeam?.teamName || ''}`.trim();
      const awayTeam = `${game.awayTeam?.teamCity || ''} ${game.awayTeam?.teamName || ''}`.trim();
      const localDate = game.gameDateTimeEst?.slice(0, 10);
      const gameDate = game.gameDate?.slice(0, 10);
      return {
        id: game.gameId,
        date: game.gameDateTimeUTC,
        officialDate: [gameDate, localDate].find(date => /^\d{4}-\d{2}-\d{2}$/.test(date || ''))
          || game.gameDateTimeUTC.slice(0, 10),
        name: `${homeTeam} vs ${awayTeam}`,
        homeTeam,
        awayTeam,
        homeTricode: game.homeTeam?.teamTricode,
        awayTricode: game.awayTeam?.teamTricode,
        venue: game.arenaName || null,
        broadcast: game.broadcasters?.nationalBroadcasters?.[0]?.broadcasterDisplay || null,
        league: 'NBA'
      };
    });

  return [...new Map(games.map(game => [game.id, game])).values()]
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function belongsToTeam(game, team) {
  const names = [team.strTeam, team.strTeamShort].map(normalizeName).filter(Boolean);
  const gameNames = [game.homeTeam, game.awayTeam].map(normalizeName);
  const tricodes = [game.homeTricode, game.awayTricode].map(normalizeName);
  return names.some(name => gameNames.includes(name) || tricodes.includes(name));
}

function eventsEqual(first, second) {
  const withoutUpdateMetadata = events => events.map(({ updatedAt, ...event }) => event);
  return JSON.stringify(withoutUpdateMetadata(first)) === JSON.stringify(withoutUpdateMetadata(second));
}

function retainEventUpdateMetadata(events, existingEvents, updatedAt) {
  const existingById = new Map(existingEvents.map(event => [event.idEvent, event]));
  return events.map(event => {
    const existing = existingById.get(event.idEvent);
    if (existing && eventsEqual([event], [existing])) {
      return { ...event, updatedAt: existing.updatedAt || updatedAt };
    }
    return { ...event, updatedAt };
  });
}

export async function fetchNbaSchedules({
  fetchImpl = globalThis.fetch,
  outputDir = SUPPLEMENTAL_DATA_DIR,
  now = new Date(),
  requestOptions = {},
  leagueFile = NBA_LEAGUE_FILE
} = {}) {
  const teams = await fetchTeams(fetchImpl, requestOptions, leagueFile);

  if (teams.length < 30) throw new Error(`Expected all 30 NBA teams, received ${teams.length}`);

  for (const team of teams) {
    if (!/^\d{6}$/.test(String(team.idTeam || ''))) {
      throw new Error(`Invalid NBA team ID for ${team.strTeam || 'unknown team'}: ${team.idTeam}`);
    }
  }

  let games;
  try {
    games = parseUpcomingGames(await fetchJson(NBA_SCHEDULE_URL, fetchImpl, requestOptions), now);
    if (games.length === 0) throw new Error('NBA schedule contained no upcoming games');
  } catch (error) {
    console.warn(`NBA feed unavailable: ${error.message}. Trying ESPN team schedules.`);
    try {
      games = await fetchEspnGames(teams, now, fetchImpl, requestOptions);
      if (games.length === 0) throw new Error('ESPN schedule contained no upcoming games');
    } catch (fallbackError) {
      throw new AggregateError([error, fallbackError], 'Both NBA and ESPN schedule sources failed; existing schedules were not changed');
    }
  }

  const unmatchedGames = games.filter(game => teams.filter(team => belongsToTeam(game, team)).length !== 2);
  if (unmatchedGames.length > 0) {
    throw new Error(`Could not match both NBA teams for ${unmatchedGames.length} upcoming games`);
  }

  await fs.mkdir(outputDir, { recursive: true });
  let activeTeams = 0;
  let writtenTeams = 0;
  let skippedTeams = 0;
  for (const team of teams) {
    const teamGames = games.filter(game => belongsToTeam(game, team));
    if (teamGames.length === 0) {
      console.warn(`No upcoming games matched ${team.strTeam}; skipping its existing file.`);
      skippedTeams++;
      continue;
    }

    activeTeams++;
    const filePath = path.join(outputDir, `${team.idTeam}.json`);
    let events = teamGames.map(game => normalizeScrapedEvent(game, team.strTeam));
    let existing = null;
    try {
      existing = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    // Keep calendar UIDs when the same fixture moves between NBA and ESPN feeds.
    events = events.map(event => {
      const matches = (existing?.events || []).filter(old =>
        old.dateEvent === event.dateEvent && old.strHomeTeam === event.strHomeTeam && old.strAwayTeam === event.strAwayTeam);
      return matches.length === 1 ? { ...event, idEvent: matches[0].idEvent } : event;
    });

    if (existing && eventsEqual(events, existing.events || [])) {
      continue;
    }

    const updatedAt = now.toISOString();
    const eventsWithMetadata = retainEventUpdateMetadata(events, existing?.events || [], updatedAt);
    await fs.writeFile(filePath, `${JSON.stringify({
      teamId: team.idTeam,
      teamName: team.strTeam,
      updatedAt,
      events: eventsWithMetadata
    }, null, 2)}\n`);
    writtenTeams++;
  }

  return { teams: teams.length, activeTeams, writtenTeams, skippedTeams, games: games.length };
}

async function main() {
  console.log('Fetching every upcoming NBA game...');
  const result = await fetchNbaSchedules();
  console.log(`Found ${result.games} upcoming games for ${result.activeTeams} NBA teams; wrote ${result.writtenTeams} schedules and retained ${result.skippedTeams} empty schedules.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('NBA schedule fetch failed:', error);
    process.exitCode = 1;
  });
}
