import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchScheduleFromWebsite, closeBrowser } from '../lib/scraper.js';
import { normalizeScrapedEvent } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPLEMENTAL_DATA_DIR = path.join(__dirname, '../lib/data/sports/supplemental');
const SPORTSDB_BASE_URL = 'https://www.thesportsdb.com/api/v1/json/3';
const CURRENT_YEAR = new Date().getFullYear();
const WNBA_SCHEDULE_CSV_URL = `https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_wnba_schedules/wnba_schedule_${CURRENT_YEAR}.csv`;
const FETCH_TIMEOUT_MS = 15000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MakeICS-WNBA-Fetcher/1.0'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out for ${url} after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWNBACSV() {
  console.log(`Fetching WNBA supplemental data from SportsDataverse: ${WNBA_SCHEDULE_CSV_URL}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(WNBA_SCHEDULE_CSV_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`Failed to fetch WNBA CSV: ${response.status}`);
    const csvText = await response.text();

    const games = [];
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

    if (rows.length < 2) return [];

    const header = rows[0];
    const mapping = {
      date: 'date',
      home: 'home_display_name',
      away: 'away_display_name',
      venue: 'venue_full_name',
      id: 'id',
      broadcast: 'broadcast'
    };
    const indices = {};
    for (const [key, field] of Object.entries(mapping)) {
      indices[key] = header.indexOf(field);
    }

    if (indices.date === -1 || indices.home === -1 || indices.away === -1) {
      throw new Error('Malformed WNBA CSV header (missing required fields)');
    }

    for (let i = 1; i < rows.length; i++) {
      const parts = rows[i];
      const dateRaw = parts[indices.date];
      const homeRaw = parts[indices.home];
      const awayRaw = parts[indices.away];
      const venue = indices.venue !== -1 ? parts[indices.venue] : null;
      const broadcast = indices.broadcast !== -1 ? parts[indices.broadcast] : null;

      if (!dateRaw || !homeRaw || !awayRaw) continue;

      let dateEvent = dateRaw;
      let strTime = '00:00:00';

      if (dateRaw.includes('T')) {
        [dateEvent, strTime] = dateRaw.split('T');
        strTime = strTime.replace('Z', '');
      }

      games.push({
        date: dateEvent,
        time: strTime,
        name: `${homeRaw} vs ${awayRaw}`,
        homeTeam: homeRaw,
        awayTeam: awayRaw,
        venue: venue,
        broadcast: broadcast,
        league: 'WNBA'
      });
    }

    return games;
  } catch (error) {
    console.error('Error fetching/parsing WNBA CSV:', error.message);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches, normalizes, deduplicates, and saves WNBA team schedules.
 *
 * Retrieves schedule data, uses team websites as a fallback, and preserves existing update timestamps when rewriting supplemental files.
 */
async function main() {
  console.log('Starting WNBA schedule fetch...');
  await fs.mkdir(SUPPLEMENTAL_DATA_DIR, { recursive: true });

  try {
    // 1. Fetch WNBA teams from TheSportsDB
    console.log('Fetching WNBA teams...');
    const teamsData = await fetchJson(`${SPORTSDB_BASE_URL}/search_all_teams.php?l=WNBA`);
    const teams = teamsData.teams || [];
    console.log(`Found ${teams.length} WNBA teams.`);

    // 2. Fetch CSV schedule
    const globalGames = await fetchWNBACSV();
    console.log(`Found ${globalGames.length} games in WNBA CSV.`);

    if (globalGames.length === 0) {
      throw new Error('No games found in WNBA CSV. Failing fast to prevent incomplete data.');
    }

    // 3. Process each team
    for (const team of teams) {
      console.log(`Processing team: ${team.strTeam} (${team.idTeam})`);
      let teamGames = [];

      // Filter global games for this team
      const filteredGlobal = globalGames.filter(g => {
        const home = g.homeTeam?.toLowerCase().trim() || '';
        const away = g.awayTeam?.toLowerCase().trim() || '';
        const target = team.strTeam.toLowerCase().trim();
        const shortTarget = team.strTeamShort?.toLowerCase().trim();

        // Use exact match or word boundaries for shortTarget to avoid "LA" matching "Dallas"
        const matchesTarget = home === target || away === target;
        const matchesShort = shortTarget && (home === shortTarget || away === shortTarget);

        // Also allow matching if the full team name is a substring, but be more careful
        // Most CSVs have the full name, so exact match is safest
        return matchesTarget || matchesShort;
      });

      if (filteredGlobal.length > 0) {
        console.log(`  Found ${filteredGlobal.length} games from CSV.`);
        teamGames.push(...filteredGlobal);
      }

      // 4. Try to scrape team's official website as fallback if CSV failed for this team
      if (teamGames.length === 0 && team.strWebsite) {
        console.log(`  Scraping team website fallback: ${team.strWebsite}`);
        try {
          const websiteGames = await fetchScheduleFromWebsite(team.strWebsite);
          if (websiteGames.length > 0) {
            console.log(`  Found ${websiteGames.length} games on team website.`);
            teamGames.push(...websiteGames);
          }
        } catch (e) {
          console.warn(`  Failed to scrape team website for ${team.strTeam}: ${e.message}`);
        }
      }

      // 5. Save merged and normalized events
      if (teamGames.length > 0) {
        const normalizedEvents = teamGames.map(g => normalizeScrapedEvent(g, team.strTeam));

        // Deduplicate by generated ID
        const seenIds = new Set();
        const uniqueEvents = [];
        for (const event of normalizedEvents) {
          if (!seenIds.has(event.idEvent)) {
            seenIds.add(event.idEvent);
            uniqueEvents.push(event);
          }
        }

        const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${team.idTeam}.json`);
        let existingUpdatedAt = null;
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const existingData = JSON.parse(content);
          existingUpdatedAt = existingData.updatedAt;
        } catch (e) {}

        await fs.writeFile(filePath, JSON.stringify({
          teamId: team.idTeam,
          teamName: team.strTeam,
          updatedAt: existingUpdatedAt || new Date().toISOString(),
          events: uniqueEvents
        }, null, 2));
        console.log(`  Saved ${uniqueEvents.length} supplemental events to ${filePath}`);
      } else {
        console.log(`  No events found for ${team.strTeam}.`);
      }

      // Delay to be polite and avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

  } catch (error) {
    console.error('Error in WNBA fetch script:', error);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}

main().catch(console.error);
