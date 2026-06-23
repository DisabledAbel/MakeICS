import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeScrapedEvent } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPLEMENTAL_DATA_DIR = path.join(__dirname, '../lib/data/sports/supplemental');
const SPORTSDB_BASE_URL = 'https://www.thesportsdb.com/api/v1/json/3';
const MLB_API_BASE_URL = 'https://statsapi.mlb.com/api/v1';
const FETCH_TIMEOUT_MS = 15000;

const MILB_LEAGUES = [
  { id: '5085', name: 'International League', sportId: 11 },
  { id: '5065', name: 'Pacific Coast League', sportId: 11 },
  // Northwest League and others are often High-A (13) or Single-A (14) in MLB API
  { id: '5752', name: 'Northwest League', sportId: 13 }
];

const CURRENT_YEAR = new Date().getFullYear();

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MakeICS-MiLB-Fetcher/1.0'
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

async function main() {
  console.log('Starting MiLB schedule fetch via MLB API...');
  await fs.mkdir(SUPPLEMENTAL_DATA_DIR, { recursive: true });

  const levelSchedules = new Map();

  for (const league of MILB_LEAGUES) {
    console.log(`Processing league: ${league.name} (${league.id})`);
    try {
      const teamsUrl = `${SPORTSDB_BASE_URL}/search_all_teams.php?l=${encodeURIComponent(league.name)}`;
      const teamsData = await fetchJson(teamsUrl);
      const teams = teamsData.teams || [];
      console.log(`  Found ${teams.length} teams in TSDB.`);

      if (teams.length === 0) continue;

      // Fetch global schedule for this level if not already fetched
      const cacheKey = `${league.sportId}-${league.id}`;
      if (!levelSchedules.has(cacheKey)) {
        const startDate = `${CURRENT_YEAR}-01-01`;
        const endDate = `${CURRENT_YEAR}-12-31`;
        const scheduleUrl = `${MLB_API_BASE_URL}/schedule?sportId=${league.sportId}&season=${CURRENT_YEAR}&startDate=${startDate}&endDate=${endDate}`;
        console.log(`  Fetching level ${league.sportId} schedule for ${league.name} from MLB API...`);
        const scheduleData = await fetchJson(scheduleUrl);

        const games = [];
        if (scheduleData.dates) {
          for (const date of scheduleData.dates) {
            for (const game of date.games) {
              games.push({
                date: game.officialDate,
                time: game.gameDate.includes('T') ? game.gameDate.split('T')[1].replace('Z', '') : null,
                name: `${game.teams.home.team.name} vs ${game.teams.away.team.name}`,
                homeTeam: game.teams.home.team.name,
                awayTeam: game.teams.away.team.name,
                venue: game.venue?.name || null,
                league: league.name,
                id: game.gamePk
              });
            }
          }
        }
        levelSchedules.set(cacheKey, games);
        console.log(`  Found ${games.length} games in MLB API for ${league.name} (level ${league.sportId}).`);
      }

      const allGames = levelSchedules.get(cacheKey);

      for (const team of teams) {
        if (!team.idTeam || !/^[a-z0-9-]+$/i.test(team.idTeam)) {
          console.warn(`  Skipping team with invalid ID: ${team.strTeam} (${team.idTeam})`);
          continue;
        }

        console.log(`  Processing team: ${team.strTeam} (${team.idTeam})`);

        const teamGames = allGames.filter(g =>
          g.homeTeam.toLowerCase().trim() === team.strTeam.toLowerCase().trim() ||
          g.awayTeam.toLowerCase().trim() === team.strTeam.toLowerCase().trim()
        );

        if (teamGames.length > 0) {
          const normalizedEvents = teamGames.map(g => normalizeScrapedEvent(g, team.strTeam));

          const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${team.idTeam}.json`);
          await fs.writeFile(filePath, JSON.stringify({
            teamId: team.idTeam,
            teamName: team.strTeam,
            updatedAt: new Date().toISOString(),
            events: normalizedEvents
          }, null, 2));
          console.log(`    Saved ${normalizedEvents.length} events to ${filePath}`);
        } else {
          console.log(`    No games found for ${team.strTeam} in MLB API.`);
        }
      }
    } catch (err) {
      console.error(`  Error processing league ${league.name}:`, err.message);
    }
  }

  console.log('MiLB schedule fetch complete.');
}

main().catch(console.error);
