import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchScheduleFromWebsite, normalizeScrapedEvent } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../lib/data/sports');
const SUPPLEMENTAL_DATA_DIR = path.join(DATA_DIR, 'supplemental');
const SPORTSDB_BASE_URL = 'https://www.thesportsdb.com/api/v1/json/3';
const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

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

async function fetchWNBASupplemental(teams) {
  console.log('Fetching WNBA supplemental data from SportsDataverse...');
  const url = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_wnba_schedules/wnba_schedule_2026.csv';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Failed to fetch WNBA CSV: ${response.status}`);
    const csvText = await response.text();

    const teamSupplemental = new Map(); // teamName -> events[]
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
    const dateIdx = header.indexOf('date');
    const homeNameIdx = header.indexOf('home_display_name');
    const awayNameIdx = header.indexOf('away_display_name');
    const venueIdx = header.indexOf('venue_full_name');
    const idIdx = header.indexOf('id');

    if (dateIdx === -1 || homeNameIdx === -1 || awayNameIdx === -1) {
      throw new Error('Malformed WNBA CSV header');
    }

    for (let i = 1; i < rows.length; i++) {
      const parts = rows[i];
      const date = parts[dateIdx];
      const homeName = parts[homeNameIdx];
      const awayName = parts[awayNameIdx];
      const venue = parts[venueIdx];
      const eventId = parts[idIdx];

      if (!date || !homeName || !awayName) continue;

      let strTime = date.split('T')[1]?.replace('Z', '') || '00:00:00';
      if (strTime.length === 5) strTime += ':00'; // HH:mm -> HH:mm:ss

      const event = {
        idEvent: `wnba-sdv-${eventId}`,
        strEvent: `${homeName} vs ${awayName}`,
        strHomeTeam: homeName,
        strAwayTeam: awayName,
        dateEvent: date.split('T')[0],
        strTime,
        strTimestamp: date,
        strLeague: 'WNBA',
        strVenue: venue,
        strStatus: 'NS',
        source: 'wehoop'
      };

      if (!teamSupplemental.has(homeName)) teamSupplemental.set(homeName, []);
      if (!teamSupplemental.has(awayName)) teamSupplemental.set(awayName, []);

      teamSupplemental.get(homeName).push(event);
      teamSupplemental.get(awayName).push(event);
    }

    // Save for each team
    for (const team of teams) {
      let teamEvents = teamSupplemental.get(team.strTeam);

      if (!teamEvents) {
        // Fallback: lowercase/trimmed match
        const normalizedTarget = team.strTeam.toLowerCase().trim();
        for (const [name, events] of teamSupplemental.entries()) {
          if (name.toLowerCase().trim() === normalizedTarget) {
            teamEvents = events;
            console.log(`    Found tolerant match for WNBA team: "${name}" -> "${team.strTeam}"`);
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
        console.log(`    Saved ${teamEvents.length} WNBA supplemental events for ${team.strTeam} (${team.idTeam})`);
      } else {
        console.warn(`    No WNBA supplemental events found for ${team.strTeam} (${team.idTeam})`);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`  WNBA CSV request timed out after ${FETCH_TIMEOUT_MS}ms`);
    } else {
      console.error('  Error fetching WNBA supplemental data:', error.message);
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

async function isSupplementalStale(teamId) {
  try {
    const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${teamId}.json`);
    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    if (!data.updatedAt) return true;

    const lastUpdated = new Date(data.updatedAt).getTime();
    if (Number.isNaN(lastUpdated)) return true;

    const now = Date.now();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    return now - lastUpdated > twentyFourHoursMs;
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

      if (league.id === '4516') {
        await fetchWNBASupplemental(teams);
      }

      if (process.env.FIRECRAWL_API_KEY) {
        for (const team of teams) {
          if (team.strWebsite) {
            const isStale = await isSupplementalStale(team.idTeam);
            if (isStale) {
              console.log(`  Scraping ${team.strTeam} website: ${team.strWebsite}...`);
              try {
                const games = await fetchScheduleFromWebsite(team.strWebsite);
                const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${team.idTeam}.json`);
                const normalizedEvents = games && games.length ? games.map(g => normalizeScrapedEvent(g, team.strTeam)) : [];

                await fs.writeFile(filePath, JSON.stringify({
                  teamId: team.idTeam,
                  teamName: team.strTeam,
                  updatedAt: new Date().toISOString(),
                  events: normalizedEvents
                }, null, 2));
                console.log(`    Saved ${normalizedEvents.length} scraped events for ${team.strTeam}`);
                // Rate limit for Firecrawl
                await sleep(5000);
              } catch (error) {
                console.error(`    Error scraping ${team.strTeam}:`, error.message);
              }
            } else {
              console.log(`  Supplemental data for ${team.strTeam} is fresh.`);
            }
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
