import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchScheduleFromWebsite, fetchScheduleFromESPN, normalizeScrapedEvent } from '../lib/sports.js';
import { SOURCE_RULES, validateData } from './validate-fetch-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../lib/data/sports');
const SUPPLEMENTAL_DATA_DIR = path.join(DATA_DIR, 'supplemental');

function sanitizeScores(events) {
  if (!Array.isArray(events)) return events;
  const scoreKeys = ['intHomeScore', 'intHomeScoreExtra', 'intAwayScoreExtra', 'intAwayScore', 'intScore', 'intScoreVotes', 'strResult'];
  for (const event of events) {
    if (event) {
      for (const key of scoreKeys) {
        delete event[key];
      }
    }
  }
  return events;
}
const SPORTSDB_BASE_URL = 'https://www.thesportsdb.com/api/v1/json/3';
const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;
const REQUEST_INTERVAL_MS = 2500;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

const LEAGUE_TO_ESPN_SLUG = {
  '4328': 'soccer/league/_/name/eng.1', // EPL
  '4391': 'nfl',
  '4387': 'nba',
  '4424': 'mlb',
  '4380': 'nhl',
  '4427': 'wnba',
  '4516': 'wnba',
  '4335': 'soccer/league/_/name/esp.1', // La Liga
  '4332': 'soccer/league/_/name/ita.1'  // Serie A
};

const TEAM_ESPN_SLUG_OVERRIDES = {
  // Map TSDB Team IDs to ESPN slugs if shortname/name logic fails
  '134865': 'gs', // Golden State Warriors (GSW)
  '134948': 'sf', // San Francisco 49ers (SF)
  '135260': 'nyy', // New York Yankees
  '133604': 'ars'  // Arsenal
};

const SUPPLEMENTAL_CONFIGS = {
  // WNBA
  '4516': {
    url: 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_wnba_schedules/wnba_schedule_2026.csv',
    mapping: {
      date: 'date',
      home: 'home_display_name',
      away: 'away_display_name',
      venue: 'venue_full_name',
      id: 'id',
      broadcast: 'broadcast'
    }
  },
  // NBA
  '4387': {
    url: 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_schedules/nba_schedule_2026.csv',
    mapping: {
      date: 'date',
      home: 'home_display_name',
      away: 'away_display_name',
      venue: 'venue_full_name',
      id: 'id',
      broadcast: 'broadcast'
    }
  },
  // NFL
  '4391': {
    url: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv',
    mapping: {
      date: 'gameday',
      time: 'gametime',
      home: 'home_team',
      away: 'away_team',
      venue: 'stadium',
      id: 'game_id',
      broadcast: 'network'
    }
  },
  // NHL and MLS are intentionally absent. Their dedicated fetchers exclusively
  // own supplemental files using complete structured league feeds.
};

// Major leagues to track
export const LEAGUES = [
  { id: '4328', name: 'EPL' },
  { id: '4391', name: 'NFL' },
  { id: '4387', name: 'NBA' },
  { id: '4424', name: 'MLB' },
  { id: '4380', name: 'NHL' },
  { id: '4516', name: 'WNBA' },
  { id: '4335', name: 'La Liga' },
  { id: '4332', name: 'Serie A' },
  { id: '4331', name: 'Bundesliga' },
  { id: '4334', name: 'Ligue 1' },
  { id: '4337', name: 'Eredivisie' },
  { id: '4344', name: 'Primeira Liga' },
  { id: '4346', name: 'MLS' },
  { id: '4350', name: 'Liga MX' },
  { id: '4329', name: 'English Championship' },
  { id: '4339', name: 'Turkish Super Lig' },
  { id: '4330', name: 'Scottish Premiership' },
  { id: '4351', name: 'Brazilian Serie A' },
  { id: '4479', name: 'NCAA Football' },
  { id: '4408', name: 'NCAA Basketball' },
  { id: '4480', name: 'UEFA Champions League' },
  { id: '4481', name: 'UEFA Europa League' },
  { id: '4460', name: 'IPL' },
  { id: '4470', name: 'Arena Football League' },
  { id: '5434', name: 'UFL' },
  { id: '4738', name: 'American AHL' }
];

export function currentSeasonFromResponse(leagueId, leagueData) {
  if (!Array.isArray(leagueData?.leagues) || leagueData.leagues.length === 0) {
    throw new Error(`Malformed league response for ${leagueId}: no league record`);
  }
  const returnedId = leagueData.leagues[0]?.idLeague;
  if (returnedId && String(returnedId) !== String(leagueId)) {
    throw new Error(`Malformed league response for ${leagueId}: received league ${returnedId}`);
  }
  const season = leagueData.leagues[0]?.strCurrentSeason;
  if (typeof season !== 'string' || !season.trim()) {
    throw new Error(`Malformed league response for ${leagueId}: no current season`);
  }
  return season;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// One queue covers every request, including empty rounds, lookups and retries.
// Sleeping only after populated rounds allowed bursts above the free API limit.
export function createSportsDbClient({
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  now = Date.now,
  requestIntervalMs = REQUEST_INTERVAL_MS,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxRetries = MAX_RETRIES,
  rateLimitCooldownMs = RATE_LIMIT_COOLDOWN_MS,
  logger = console
} = {}) {
  let queue = Promise.resolve();
  let nextRequestAt = 0;

  async function request(url) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const wait = Math.max(0, nextRequestAt - now());
      if (wait) await sleepImpl(wait);
      nextRequestAt = now() + requestIntervalMs;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let failure;
      let retryDelay = INITIAL_BACKOFF_MS * 2 ** attempt;
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': 'MakeICS-Data-Fetcher/1.0' }
        });
        if (response.ok) return await response.json();

        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (response.status === 429) {
          const header = response.headers?.get('retry-after');
          const seconds = header?.trim() ? Number(header) : NaN;
          const retryAfter = Number.isFinite(seconds)
            ? seconds * 1000
            : Math.max(0, Date.parse(header) - now()) || 0;
          retryDelay = Math.max(retryDelay, rateLimitCooldownMs, retryAfter);
        }
        await response.body?.cancel();
        failure = new Error(`Request failed (${response.status}) for ${url}`);
        failure.retryable = retryable;
      } catch (error) {
        failure = new Error(`${controller.signal.aborted ? `Request timed out after ${timeoutMs}ms` : error.message} for ${url}`, { cause: error });
        failure.retryable = controller.signal.aborted || error instanceof TypeError;
      } finally {
        // The next attempt gets a fresh timeout after the cooldown has ended.
        clearTimeout(timeout);
      }
      if (!failure.retryable || attempt === maxRetries) throw failure;
      logger.warn(`${failure.message}. Retrying in ${retryDelay}ms (${attempt + 1}/${maxRetries})...`);
      await sleepImpl(retryDelay);
    }
  }

  return url => {
    const result = queue.then(() => request(url));
    queue = result.catch(() => {});
    return result;
  };
}

const fetchJson = createSportsDbClient();

// nflverse gameday/gametime are Eastern wall-clock values, including DST.
const easternClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

export function nflKickoffTimestamp(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) {
    throw new Error(`Invalid NFL kickoff ${date} ${time}`);
  }
  const wallClock = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (!Number.isFinite(wallClock) || new Date(wallClock).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid NFL kickoff date ${date}`);
  }
  let instant = wallClock;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(easternClock.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
    const eastern = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const adjustment = wallClock - eastern;
    if (!adjustment) return new Date(instant).toISOString().replace('.000Z', 'Z');
    instant += adjustment;
  }
  throw new Error(`Unresolvable Eastern kickoff ${date} ${time}`);
}

export async function saveSupplementalSchedule(filePath, data) {
  let previous = null;
  try { previous = JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const current = { ...data, updatedAt: previous?.updatedAt || new Date().toISOString() };
  const errors = validateData({ file: filePath, current, previous, rule: SOURCE_RULES.sports });
  if (errors.length) throw new Error(`Rejected optional supplemental output: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? `; ${errors.length - 3} more validation errors` : ''}`);
  await fs.writeFile(filePath, JSON.stringify(current, null, 2));
}

/**
 * Fetches supplemental schedule data for a configured league and saves events to each matching team's data file.
 * @param {Object} league - The league whose supplemental data should be fetched.
 * @param {Array<Object>} teams - The league's teams to associate with supplemental events.
 */
async function fetchLeagueSupplementalCSV(league, teams, { dataDir = SUPPLEMENTAL_DATA_DIR } = {}) {
  const config = SUPPLEMENTAL_CONFIGS[league.id];
  if (!config) return;

  console.log(`Fetching ${league.name} supplemental data from SportsDataverse...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Failed to fetch ${league.name} CSV: ${response.status}`);
    const csvText = await response.text();

    const teamSupplemental = new Map(); // teamName/abbr -> events[]
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;

    for (let j = 0; j < csvText.length; j++) {
      const char = csvText[j];
      const nextChar = csvText[j + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          currentField += '"';
          j++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        currentRow.push(currentField);
        currentField = '';
      } else if ((char === '\r' || char === '\n') && !inQuotes) {
        if (currentField !== '' || currentRow.length > 0) {
          currentRow.push(currentField);
          rows.push(currentRow);
          currentField = '';
          currentRow = [];
        }
        if (char === '\r' && nextChar === '\n') j++;
      } else {
        currentField += char;
      }
    }

    if (currentField !== '' || currentRow.length > 0) {
      currentRow.push(currentField);
      rows.push(currentRow);
    }

    const header = rows[0];
    const mapping = config.mapping;
    const indices = {};
    for (const [key, field] of Object.entries(mapping)) {
      indices[key] = header.indexOf(field);
    }

    if (indices.date === -1 || indices.home === -1 || indices.away === -1) {
      throw new Error(`Malformed ${league.name} CSV header (missing required fields)`);
    }

    for (let i = 1; i < rows.length; i++) {
      const parts = rows[i];
      const dateRaw = parts[indices.date];
      const homeRaw = parts[indices.home];
      const awayRaw = parts[indices.away];
      const venue = indices.venue !== -1 ? parts[indices.venue] : null;
      const broadcast = indices.broadcast !== -1 ? parts[indices.broadcast] : null;
      const eventId = indices.id !== -1 ? parts[indices.id] : `${i}`;
      const timeRaw = indices.time !== -1 ? parts[indices.time] : null;

      if (!dateRaw || !homeRaw || !awayRaw) continue;
      // Unknown kickoffs must not be invented as midnight games.
      if (league.id === '4391' && (!timeRaw || ['NA', 'TBD'].includes(timeRaw))) continue;

      let dateEvent = dateRaw;
      let strTime = '00:00:00';
      let strTimestamp = null;

      if (dateRaw.includes('T')) {
        [dateEvent, strTime] = dateRaw.split('T');
        strTime = strTime.replace('Z', '');
        strTimestamp = dateRaw;
      } else {
        if (timeRaw) strTime = timeRaw;

        // Validate date format YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEvent)) {
          const parsed = new Date(dateRaw);
          if (!Number.isNaN(parsed.getTime())) {
            dateEvent = parsed.toISOString().split('T')[0];
          } else {
            console.warn(`    Invalid date format for ${league.name}: "${dateRaw}"`);
          }
        }
      }

      if (strTime.length === 5) strTime += ':00'; // HH:mm -> HH:mm:ss

      if (!strTimestamp) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateEvent)) {
          strTimestamp = `${dateEvent}T${strTime}Z`;
        }
      } else if (!strTimestamp.endsWith('Z') && !/[-+]\d{2}:?\d{2}$/.test(strTimestamp)) {
        strTimestamp += 'Z';
      }

      if (league.id === '4391') {
        strTimestamp = nflKickoffTimestamp(dateEvent, timeRaw);
        dateEvent = strTimestamp.slice(0, 10);
        strTime = strTimestamp.slice(11, 19);
      }

      const event = {
        idEvent: `sdv-${league.name.toLowerCase()}-${eventId}`,
        strEvent: `${homeRaw} vs ${awayRaw}`,
        strHomeTeam: homeRaw,
        strAwayTeam: awayRaw,
        dateEvent,
        strTime,
        strTimestamp,
        strLeague: league.name,
        strVenue: venue,
        strTVStation: broadcast,
        strStatus: 'NS',
        source: 'sportsdataverse'
      };

      if (!teamSupplemental.has(homeRaw)) teamSupplemental.set(homeRaw, []);
      if (!teamSupplemental.has(awayRaw)) teamSupplemental.set(awayRaw, []);

      teamSupplemental.get(homeRaw).push(event);
      teamSupplemental.get(awayRaw).push(event);
    }

    // Save for each team
    for (const team of teams) {
      let teamEvents = teamSupplemental.get(team.strTeam);

      if (!teamEvents) {
        // Fallback: search keys in teamSupplemental
        const normalizedTarget = team.strTeam.toLowerCase().trim();
        const shortTarget = team.strTeamShort?.toLowerCase().trim();

        for (const [name, events] of teamSupplemental.entries()) {
          const normalizedName = name.toLowerCase().trim();
          if (normalizedName === normalizedTarget || (shortTarget && normalizedName === shortTarget) || normalizedTarget.includes(normalizedName) || normalizedName.includes(normalizedTarget)) {
            teamEvents = events;
            console.log(`    Found tolerant match for ${league.name} team: "${name}" -> "${team.strTeam}"`);
            break;
          }
        }
      }

      if (teamEvents) {
        sanitizeScores(teamEvents);
        const filePath = path.join(dataDir, `${team.idTeam}.json`);
        await saveSupplementalSchedule(filePath, {
          teamId: team.idTeam,
          teamName: team.strTeam,
          events: teamEvents
        });
        console.log(`    Saved ${teamEvents.length} supplemental events for ${team.strTeam} (${team.idTeam})`);
      } else {
        console.warn(`    No supplemental events found for ${team.strTeam} (${team.idTeam})`);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`  ${league.name} CSV request timed out after ${FETCH_TIMEOUT_MS}ms`);
    } else {
      console.error(`  Error fetching ${league.name} supplemental data:`, error.message);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchLeagueSchedule(leagueId, { fetchJsonImpl = fetchJson } = {}) {
  console.log(`Fetching league ${leagueId}...`);

  // 1. Get current season
  const leagueUrl = `${SPORTSDB_BASE_URL}/lookupleague.php?id=${leagueId}`;
  const leagueData = await fetchJsonImpl(leagueUrl);
  const season = currentSeasonFromResponse(leagueId, leagueData);

  console.log(`Current season for ${leagueId}: ${season}`);

  const allEvents = new Map();
  let emptyRoundCount = 0;
  const EMPTY_ROUND_THRESHOLD = 3;

  // 2. Fetch by rounds (since eventsseason.php is limited)
  // Most leagues don't have more than 50 rounds/weeks
  for (let r = 1; r <= 50; r++) {
    const roundUrl = `${SPORTSDB_BASE_URL}/eventsround.php?id=${leagueId}&r=${r}&s=${season}`;
    const roundData = await fetchJsonImpl(roundUrl);

    if (!roundData || !Object.hasOwn(roundData, 'events') || (roundData.events !== null && !Array.isArray(roundData.events))) {
      throw new Error(`Malformed round ${r} response for ${leagueId}: expected an events array or null`);
    }

    if (!roundData.events || roundData.events.length === 0) {
      emptyRoundCount++;
      if (emptyRoundCount >= EMPTY_ROUND_THRESHOLD) {
        console.log(`  Stopping after ${emptyRoundCount} consecutive empty rounds at round ${r}`);
        break;
      }
      continue;
    }

    emptyRoundCount = 0;
    for (const event of roundData.events) {
      if (!event?.idEvent || (event.idLeague && String(event.idLeague) !== String(leagueId))) {
        throw new Error(`Malformed event in round ${r} for ${leagueId}: missing ID or wrong league`);
      }
      allEvents.set(String(event.idEvent), event);
    }
    console.log(`  Round ${r}: ${roundData.events.length} events`);

  }

  return { events: [...allEvents.values()], leagueName: leagueData.leagues[0].strLeague };
}

export function teamsFromResponse(leagueId, teamsData) {
  const teams = teamsData?.teams;
  if (!Array.isArray(teams) || !teams.length) {
    throw new Error(`TheSportsDB returned no valid teams for league ${leagueId}`);
  }
  if (teams.some(team => !/^\d+$/.test(String(team?.idTeam || '')) || typeof team.strTeam !== 'string' || !team.strTeam.trim() || String(team.idLeague) !== String(leagueId))) {
    throw new Error(`TheSportsDB returned invalid or unrelated teams for league ${leagueId}`);
  }
  return teams;
}

function getESPNTeamSlug(team) {
  if (TEAM_ESPN_SLUG_OVERRIDES[team.idTeam]) {
    return TEAM_ESPN_SLUG_OVERRIDES[team.idTeam];
  }
  return team.strTeamShort?.toLowerCase() || team.strTeam?.toLowerCase().replace(/\s+/g, '-');
}

async function isSupplementalStale(teamId, dataDir = SUPPLEMENTAL_DATA_DIR) {
  try {
    const filePath = path.join(dataDir, `${teamId}.json`);
    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    if (!data.updatedAt) return true;

    const lastUpdated = new Date(data.updatedAt).getTime();
    if (Number.isNaN(lastUpdated)) return true;

    const now = Date.now();
    const sixHoursMs = 6 * 60 * 60 * 1000;
    return now - lastUpdated > sixHoursMs;
  } catch (error) {
    return true; // File doesn't exist or is invalid
  }
}


/**
 * Fetches, processes, and stores league events and team supplemental schedules.
 *
 * NHL and MLS refresh only their league caches; dedicated fetchers own their
 * supplemental files.
 * Required league failures reject after all leagues are attempted; optional enrichment
 * failures are caught. Directory creation errors propagate, and completed writes are
 * not rolled back on later failures.
 * The shared API client paces requests across rounds and leagues.
 */
export async function main({
  leagues = LEAGUES,
  dataDir = DATA_DIR,
  fetchJsonImpl = fetchJson,
  supplementalFetcher = fetchLeagueSupplementalCSV,
  firecrawlApiKey = process.env.FIRECRAWL_API_KEY,
  sleepImpl = sleep
} = {}) {
  const supplementalDataDir = path.join(dataDir, 'supplemental');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(supplementalDataDir, { recursive: true });

  const failures = [];
  for (const league of leagues) {
    try {
      // 1. Fetch League Events (Legacy)
      const { events, leagueName } = await fetchLeagueSchedule(league.id, { fetchJsonImpl });
      if (events.length > 0) {
        sanitizeScores(events);
        const filePath = path.join(dataDir, `${league.id}.json`);
        let existingUpdatedAt = null;
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const existingData = JSON.parse(content);
          existingUpdatedAt = existingData.updatedAt;
        } catch (e) {}

        await fs.writeFile(filePath, JSON.stringify({
          leagueId: league.id,
          leagueName: league.name,
          updatedAt: existingUpdatedAt || new Date().toISOString(),
          events
        }, null, 2));
        console.log(`Saved ${events.length} events for ${league.name} to ${filePath}`);
      }

      // Team discovery is only needed for optional supplemental sources.
      // A failed enrichment must not prevent publishing a valid league schedule.
      // Dedicated structured fetchers exclusively own NHL and MLS supplemental
      // files; this generic job still refreshes each league cache above.
      if (['4380', '4346'].includes(league.id)) continue;
      if (!SUPPLEMENTAL_CONFIGS[league.id] && !firecrawlApiKey) continue;
      try {
        console.log(`Discovering teams for ${league.name}...`);
        // The provider's canonical name avoids aliases, and search_all_teams
        // avoids lookup_all_teams returning English soccer teams for other sports.
        if (typeof leagueName !== 'string' || !leagueName.trim()) throw new Error('Missing canonical league name');
        const teamsUrl = `${SPORTSDB_BASE_URL}/search_all_teams.php?l=${encodeURIComponent(leagueName)}`;
        const teams = teamsFromResponse(league.id, await fetchJsonImpl(teamsUrl));

        if (SUPPLEMENTAL_CONFIGS[league.id]) {
          await supplementalFetcher(league, teams, { dataDir: supplementalDataDir });
        }

        if (firecrawlApiKey) {
          for (const team of teams) {
            const isStale = await isSupplementalStale(team.idTeam, supplementalDataDir);
            if (!isStale) {
              console.log(`  Supplemental data for ${team.strTeam} is fresh.`);
              continue;
            }

            let allScrapedGames = [];

            // 2a. Scrape ESPN (Priority)
            const espnLeagueSlug = LEAGUE_TO_ESPN_SLUG[league.id];
            if (espnLeagueSlug) {
              const teamSlug = getESPNTeamSlug(team);
              console.log(`  Scraping ESPN for ${team.strTeam} (${teamSlug})...`);
              try {
                const espnGames = await fetchScheduleFromESPN(espnLeagueSlug, teamSlug);
                if (espnGames.length > 0) {
                  allScrapedGames.push(...espnGames);
                  console.log(`    Found ${espnGames.length} games on ESPN.`);
                }
              } catch (error) {
                console.error(`    Error scraping ESPN for ${team.strTeam}:`, error.message);
              }
            }

            // 2b. Scrape Official Website (Fallback/Additional)
            if (team.strWebsite && allScrapedGames.length === 0) {
              console.log(`  Scraping ${team.strTeam} official website: ${team.strWebsite}...`);
              try {
                const websiteGames = await fetchScheduleFromWebsite(team.strWebsite);
                if (websiteGames.length > 0) {
                  allScrapedGames.push(...websiteGames);
                  console.log(`    Found ${websiteGames.length} games on official website.`);
                }
              } catch (error) {
                console.error(`    Error scraping official website for ${team.strTeam}:`, error.message);
              }
            }

            if (!allScrapedGames.length) {
              console.warn(`    No supplemental games found for ${team.strTeam}; keeping saved data.`);
              continue;
            }

            // 2c. Save successfully scraped results.
            const filePath = path.join(supplementalDataDir, `${team.idTeam}.json`);
            const normalizedEvents = allScrapedGames.map(g => normalizeScrapedEvent(g, team.strTeam));
            sanitizeScores(normalizedEvents);

            await saveSupplementalSchedule(filePath, {
              teamId: team.idTeam,
              teamName: team.strTeam,
              events: normalizedEvents
            });

            console.log(`    Saved ${normalizedEvents.length} total supplemental events for ${team.strTeam}`);
            await sleepImpl(8000);
          }
        }
      } catch (error) {
        console.warn(`Optional supplemental refresh for ${league.name} failed: ${error.message}. Keeping saved supplemental data.`);
      }
    } catch (error) {
      console.error(`Error fetching ${league.name}:`, error.message);
      failures.push(`${league.name}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Sports refresh incomplete (${failures.length}/${leagues.length} leagues failed): ${failures.join('; ')}`);
  console.log(`Sports refresh complete (${leagues.length} leagues).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
