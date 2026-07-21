import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { decodeUnicodeEscapes } from '../lib/utils/unicode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPLEMENTAL_DATA_DIR = path.join(__dirname, '../lib/data/sports/supplemental');

const TEAM_NAME_TO_ID = {
  'albany firebirds': '148343',
  'beaumont renegades': 'af1-beaumont',
  'kentucky barrels': 'af1-kentucky',
  'michigan arsenal': 'af1-michigan',
  'minnesota monsters': 'af1-minnesota',
  'nashville kats': '148348',
  'oceanside bombers': 'af1-oceanside',
  'oregon lightning': 'af1-oregon',
  'washington wolfpack': '148353'
};

const AF1_TEAM_CANONICAL_NAMES = {
  '148343': 'Albany Firebirds',
  'af1-beaumont': 'Beaumont Renegades',
  'af1-kentucky': 'Kentucky Barrels',
  'af1-michigan': 'Michigan Arsenal',
  'af1-minnesota': 'Minnesota Monsters',
  '148348': 'Nashville Kats',
  'af1-oceanside': 'Oceanside Bombers',
  'af1-oregon': 'Oregon Lightning',
  '148353': 'Washington Wolfpack'
};

function normalizeTeamName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

async function scrapeSchedule() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    console.log('Navigating to AF1 schedule...');

    // Use a long timeout and wait for network idle as the page is SPA-ish
    await page.goto('https://www.theaf1.com/stats#/1999/schedule?season_id=9418', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    // Extra wait for dynamic data to populate the table
    await page.waitForTimeout(5000);

    const games = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr'));
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 8) return null;

        // The away/home team names might be inside complex elements,
        // but based on previous test run, we can extract them.
        // cells[1] is Away, cells[3] is Home
        const awayTeam = cells[1]?.innerText.trim().split('\n').pop();
        const homeTeam = cells[3]?.innerText.trim().split('\n').pop();
        const dateStr = cells[6]?.innerText.trim(); // e.g. "Sat Jun 20"
        const timeStr = cells[7]?.innerText.trim(); // e.g. "4:00PM EDT"
        const venue = cells[9]?.innerText.trim();
        const broadcast = cells[11]?.innerText.trim();

        if (!awayTeam || !homeTeam || !dateStr) return null;

        return {
          awayTeam,
          homeTeam,
          dateStr,
          timeStr,
          venue,
          broadcast
        };
      }).filter(Boolean);
    });

    return games;
  } finally {
    await browser.close();
  }
}

function parseDate(dateStr, timeStr) {
  // dateStr is "Sat Jun 20"
  // timeStr is "4:00PM EDT"
  const year = 2026;

  // timeStr might be "4:00PM EDT", needs to be "4:00 PM GMT-0400"
  const normalizedTime = timeStr
    .replace(/(AM|PM)/i, ' $1')
    .replace('EDT', 'GMT-0400')
    .replace('EST', 'GMT-0500')
    .replace('CDT', 'GMT-0500')
    .replace('CST', 'GMT-0600')
    .replace('MDT', 'GMT-0600')
    .replace('MST', 'GMT-0700')
    .replace('PDT', 'GMT-0700')
    .replace('PST', 'GMT-0800');

  const fullStr = `${dateStr} ${year} ${normalizedTime}`;
  const date = new Date(fullStr);

  if (isNaN(date.getTime())) {
    console.warn(`Failed to parse date: "${fullStr}"`);
  }
  return date;
}

/**
 * Fetches AF1 schedule data and saves team event files.
 *
 * Invalid games and unresolved teams are skipped. Existing update timestamps are preserved when available.
 */
async function main() {
  await fs.mkdir(SUPPLEMENTAL_DATA_DIR, { recursive: true });

  try {
    const rawGames = await scrapeSchedule();
    console.log(`Found ${rawGames.length} raw games.`);

    const teamEvents = {}; // teamId -> events[]

    for (const game of rawGames) {
      const homeId = TEAM_NAME_TO_ID[normalizeTeamName(game.homeTeam)];
      const awayId = TEAM_NAME_TO_ID[normalizeTeamName(game.awayTeam)];

      if (!homeId || !awayId) {
        console.warn(`Could not resolve IDs for ${game.homeTeam} vs ${game.awayTeam}`);
        continue;
      }

      const gameDate = parseDate(game.dateStr, game.timeStr);
      if (isNaN(gameDate.getTime())) {
        continue;
      }
      const isoTimestamp = gameDate.toISOString();
      const dateEvent = isoTimestamp.split('T')[0];
      const strTime = isoTimestamp.split('T')[1].split('.')[0];

      const event = {
        idEvent: `af1-${dateEvent}-${game.homeTeam}-${game.awayTeam}`.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        strEvent: `${game.homeTeam} vs ${game.awayTeam}`,
        strHomeTeam: game.homeTeam,
        strAwayTeam: game.awayTeam,
        dateEvent: dateEvent,
        strTime: strTime,
        strTimestamp: isoTimestamp,
        strLeague: 'Arena Football One',
        strVenue: game.venue || null,
        strTVStation: game.broadcast || null,
        strStatus: 'NS',
        source: 'af1-scrape'
      };

      if (!teamEvents[homeId]) teamEvents[homeId] = [];
      if (!teamEvents[awayId]) teamEvents[awayId] = [];

      teamEvents[homeId].push(event);
      teamEvents[awayId].push(event);
    }

    for (const [teamId, events] of Object.entries(teamEvents)) {
      const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${teamId}.json`);

      // Load existing if any to potentially merge or just overwrite (since this is the source of truth for AF1)
      // For now, we overwrite to ensure freshness

      const teamName = AF1_TEAM_CANONICAL_NAMES[teamId] || teamId;

      let existingUpdatedAt = null;
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const existingData = JSON.parse(content);
        existingUpdatedAt = existingData.updatedAt;
      } catch (e) {}

      await fs.writeFile(filePath, JSON.stringify({
        teamId,
        teamName,
        updatedAt: existingUpdatedAt || new Date().toISOString(),
        events: events.sort((a, b) => new Date(a.strTimestamp) - new Date(b.strTimestamp))
      }, null, 2));

      console.log(`Saved ${events.length} events for ${teamName} (${teamId})`);
    }

  } catch (error) {
    console.error('Error in AF1 fetch script:', error);
    process.exit(1);
  }
}

main();
