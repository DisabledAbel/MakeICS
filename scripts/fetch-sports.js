import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../lib/data/sports');
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
  { id: '4427', name: 'WNBA' },
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

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  for (const league of LEAGUES) {
    try {
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
    } catch (error) {
      console.error(`Error fetching ${league.name}:`, error.message);
    }
    // Significant inter-league delay
    await sleep(5000);
  }
}

main().catch(console.error);
