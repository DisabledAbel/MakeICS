import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchScheduleFromWebsite, fetchScheduleFromESPN, normalizeScrapedEvent } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../lib/data/sports');
const SUPPLEMENTAL_DATA_DIR = path.join(DATA_DIR, 'supplemental');
const SPORTSDB_BASE_URL = 'https://www.thesportsdb.com/api/v1/json/3';
const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

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
      id: 'id'
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
      id: 'id'
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
      id: 'game_id'
    }
  },
  // NHL
  '4380': {
    url: 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/nhl_schedules/nhl_schedule_2026.csv',
    mapping: {
      date: 'game_date',
      time: 'game_time',
      home: 'home_team_name',
      away: 'away_team_name',
      venue: 'venue',
      id: 'game_id'
    }
  }
};

// Major leagues to track
const LEAGUES = [
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
  { id: '4392', name: 'NCAA Football' },
  { id: '4408', name: 'NCAA Basketball' },
  { id: '4480', name: 'UEFA Champions League' },
  { id: '4481', name: 'UEFA Europa League' },
  { id: '4482', name: 'FA Cup' }
];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, retryCount = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MakeICS-Data-Fetcher/1.0'
      }
    });

    if (response.status === 429) {
      if (retryCount < MAX_RETRIES) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, retryCount);
        console.warn(`Rate limited (429) for ${url}. Retrying in ${backoff}ms...`);
        await sleep(backoff);
        return await fetchJson(url, retryCount + 1);
      }
      throw new Error(`Rate limit exceeded for ${url} after ${MAX_RETRIES} retries.`);
    }

    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) for ${url}`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      if (retryCount < MAX_RETRIES) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, retryCount);
        console.warn(`Timeout for ${url}. Retrying in ${backoff}ms...`);
        await sleep(backoff);
        return await fetchJson(url, retryCount + 1);
      }
      throw new Error(`Request timed out for ${url} after ${MAX_RETRIES} retries.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLeagueSupplementalCSV(league, teams) {
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

    // Handle last row if no trailing newline
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
      const eventId = indices.id !== -1 ? parts[indices.id] : `${i}`;
      const timeRaw = indices.time !== -1 ? parts[indices.time] : null;

      if (!dateRaw || !homeRaw || !awayRaw) continue;

      let dateEvent = dateRaw;
      let strTime = '00:00:00';
      let strTimestamp = null;

      if (dateRaw.includes('T')) {
        [dateEvent, strTime] = dateRaw.split('T');
        strTime = strTime.replace('Z', '');
        strTimestamp = dateRaw;
      } else if (timeRaw) {
        strTime = timeRaw;
      }

      if (strTime.length === 5) strTime += ':00'; // HH:mm -> HH:mm:ss
      if (!strTimestamp) {
        strTimestamp = `${dateEvent}T${strTime}Z`;
      } else if (!strTimestamp.endsWith('Z') && !/[-+]\d{2}:?\d{2}$/.test(strTimestamp)) {
        strTimestamp += 'Z';
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
        const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${team.idTeam}.json`);
        await fs.writeFile(filePath, JSON.stringify({
          teamId: team.idTeam,
          teamName: team.strTeam,
          updatedAt: new Date().toISOString(),
          events: teamEvents
        }, null, 2));
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
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLeagueEvents(leagueId) {
  console.log(`Fetching league ${leagueId}...`);

  // 1. Get current season
  const leagueUrl = `${SPORTSDB_BASE_URL}/lookupleague.php?id=${leagueId}`;
  const leagueData = await fetchJson(leagueUrl);
  const season = leagueData.leagues?.[0]?.strCurrentSeason;

  if (!season) {
    console.log(`No current season found for league ${leagueId}`);
    return [];
  }

  console.log(`Current season for ${leagueId}: ${season}`);

  const allEvents = [];
  let emptyRoundCount = 0;
  const EMPTY_ROUND_THRESHOLD = 3;

  // 2. Fetch by rounds (since eventsseason.php is limited)
  // Most leagues don't have more than 50 rounds/weeks
  for (let r = 1; r <= 50; r++) {
    const roundUrl = `${SPORTSDB_BASE_URL}/eventsround.php?id=${leagueId}&r=${r}&s=${season}`;
    const roundData = await fetchJson(roundUrl);

    if (!roundData.events || roundData.events.length === 0) {
      emptyRoundCount++;
      if (emptyRoundCount >= EMPTY_ROUND_THRESHOLD) {
        console.log(`  Stopping after ${emptyRoundCount} consecutive empty rounds at round ${r}`);
        break;
      }
      continue;
    }

    emptyRoundCount = 0;
    allEvents.push(...roundData.events);
    console.log(`  Round ${r}: ${roundData.events.length} events`);

    // Increased throttle to be more respectful of the free API key limit (~30 req/min)
    await sleep(2500);
  }

  return allEvents;
}

function getESPNTeamSlug(team) {
  if (TEAM_ESPN_SLUG_OVERRIDES[team.idTeam]) {
    return TEAM_ESPN_SLUG_OVERRIDES[team.idTeam];
  }
  return team.strTeamShort?.toLowerCase() || team.strTeam?.toLowerCase().replace(/\s+/g, '-');
}


async function isSupplementalStale(teamId) {
  try {
    const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${teamId}.json`);
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


async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(SUPPLEMENTAL_DATA_DIR, { recursive: true });

  for (const league of LEAGUES) {
    try {
      // 1. Fetch League Events (Legacy)
      const events = await fetchLeagueEvents(league.id);
      if (events.length > 0) {
        const filePath = path.join(DATA_DIR, `${league.id}.json`);
        await fs.writeFile(filePath, JSON.stringify({
          leagueId: league.id,
          leagueName: league.name,
          updatedAt: new Date().toISOString(),
          events
        }, null, 2));
        console.log(`Saved ${events.length} events for ${league.name} to ${filePath}`);
      }

      // 2. Discover Teams and Scrape (New)
      console.log(`Discovering teams for ${league.name}...`);
      const teamsUrl = `${SPORTSDB_BASE_URL}/lookup_all_teams.php?id=${league.id}`;
      const teamsData = await fetchJson(teamsUrl);
      const teams = teamsData.teams || [];

      if (SUPPLEMENTAL_CONFIGS[league.id]) {
        await fetchLeagueSupplementalCSV(league, teams);
      }

      if (process.env.FIRECRAWL_API_KEY) {
        for (const team of teams) {
          const isStale = await isSupplementalStale(team.idTeam);
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

          // 2c. Save Merged Results
          if (allScrapedGames.length > 0) {
            const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${team.idTeam}.json`);
            const normalizedEvents = allScrapedGames.map(g => normalizeScrapedEvent(g, team.strTeam));

            await fs.writeFile(filePath, JSON.stringify({
              teamId: team.idTeam,
              teamName: team.strTeam,
              updatedAt: new Date().toISOString(),
              events: normalizedEvents
            }, null, 2));
            console.log(`    Saved ${normalizedEvents.length} total supplemental events for ${team.strTeam}`);

            // Significant throttle for Firecrawl
            await sleep(8000);
          }
        }
      }
    } catch (error) {
      console.error(`Error fetching ${league.name}:`, error.message);
    }
    // Significant inter-league delay
    await sleep(5000);
  }
}

main().catch(console.error);
