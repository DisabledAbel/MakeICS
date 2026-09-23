import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeScrapedEvent } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPLEMENTAL_DATA_DIR = path.join(__dirname, '../lib/data/sports/supplemental');
const SPORTSDB_TEAMS_URL = 'https://www.thesportsdb.com/api/v1/json/3/search_all_teams.php?l=NBA';
const NBA_SCHEDULE_URL = 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json';
const FETCH_TIMEOUT_MS = 30_000;

async function fetchJson(url, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MakeICS-NBA-Fetcher/1.0'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
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
  now = new Date()
} = {}) {
  const [teamsPayload, schedulePayload] = await Promise.all([
    fetchJson(SPORTSDB_TEAMS_URL, fetchImpl),
    fetchJson(NBA_SCHEDULE_URL, fetchImpl)
  ]);
  const teams = teamsPayload?.teams || [];
  const games = parseUpcomingGames(schedulePayload, now);

  if (teams.length < 30) throw new Error(`Expected all 30 NBA teams, received ${teams.length}`);
  if (games.length === 0) throw new Error('NBA schedule contained no upcoming games');

  for (const team of teams) {
    if (!/^\d{6}$/.test(String(team.idTeam || ''))) {
      throw new Error(`Invalid NBA team ID for ${team.strTeam || 'unknown team'}: ${team.idTeam}`);
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
    const events = teamGames.map(game => normalizeScrapedEvent(game, team.strTeam));
    let existing = null;
    try {
      existing = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

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
