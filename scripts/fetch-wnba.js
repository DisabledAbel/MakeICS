import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWNBASchedule, fetchScheduleFromWebsite, closeBrowser } from '../lib/scraper.js';
import { normalizeScrapedEvent } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPLEMENTAL_DATA_DIR = path.join(__dirname, '../lib/data/sports/supplemental');
const SPORTSDB_BASE_URL = 'https://www.thesportsdb.com/api/v1/json/3';
const WNBA_LEAGUE_ID = '4516';
const WNBA_SCHEDULE_URL = 'https://www.wnba.com/schedule?season=2026&month=all';

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'MakeICS-WNBA-Fetcher/1.0'
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function main() {
  console.log('Starting WNBA schedule fetch...');
  await fs.mkdir(SUPPLEMENTAL_DATA_DIR, { recursive: true });

  try {
    // 1. Fetch WNBA teams from TheSportsDB
    console.log(`Fetching WNBA teams (League ID: ${WNBA_LEAGUE_ID})...`);
    const teamsData = await fetchJson(`${SPORTSDB_BASE_URL}/lookup_all_teams.php?id=${WNBA_LEAGUE_ID}`);
    const teams = teamsData.teams || [];
    console.log(`Found ${teams.length} WNBA teams.`);

    // 2. Scrape main WNBA schedule
    console.log(`Scraping main WNBA schedule: ${WNBA_SCHEDULE_URL}`);
    const globalGames = await fetchWNBASchedule(WNBA_SCHEDULE_URL);
    console.log(`Found ${globalGames.length} games on main WNBA schedule.`);

    // 3. Process each team
    for (const team of teams) {
      console.log(`Processing team: ${team.strTeam} (${team.idTeam})`);
      let teamGames = [];

      // Filter global games for this team
      const filteredGlobal = globalGames.filter(g =>
        g.homeTeam?.toLowerCase().includes(team.strTeam.toLowerCase()) ||
        g.awayTeam?.toLowerCase().includes(team.strTeam.toLowerCase()) ||
        (team.strTeamShort && (g.homeTeam?.toLowerCase().includes(team.strTeamShort.toLowerCase()) || g.awayTeam?.toLowerCase().includes(team.strTeamShort.toLowerCase())))
      );

      if (filteredGlobal.length > 0) {
        console.log(`  Found ${filteredGlobal.length} games from global schedule.`);
        teamGames.push(...filteredGlobal);
      }

      // 4. Try to scrape team's official website if available
      if (team.strWebsite) {
        console.log(`  Scraping team website: ${team.strWebsite}`);
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
        await fs.writeFile(filePath, JSON.stringify({
          teamId: team.idTeam,
          teamName: team.strTeam,
          updatedAt: new Date().toISOString(),
          events: uniqueEvents
        }, null, 2));
        console.log(`  Saved ${uniqueEvents.length} supplemental events to ${filePath}`);
      } else {
        console.log(`  No events found for ${team.strTeam}.`);
      }

      // Delay to be polite
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

  } catch (error) {
    console.error('Error in WNBA fetch script:', error);
  } finally {
    await closeBrowser();
  }
}

main().catch(console.error);
