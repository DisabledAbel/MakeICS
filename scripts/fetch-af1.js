import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPLEMENTAL_DATA_DIR = path.join(__dirname, '../lib/data/sports/supplemental');

const TEAM_NAME_TO_ID = {
  'Albany Firebirds': '148343',
  'Beaumont Renegades': 'af1-beaumont',
  'Kentucky Barrels': 'af1-kentucky',
  'Michigan Arsenal': 'af1-michigan',
  'Minnesota Monsters': 'af1-minnesota',
  'Nashville Kats': '148348',
  'Oceanside Bombers': 'af1-oceanside',
  'Washington Wolfpack': '148353'
};

async function scrapeSchedule() {
  const browser = await chromium.launch();
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

      if (!awayTeam || !homeTeam || !dateStr) return null;

      return {
        awayTeam,
        homeTeam,
        dateStr,
        timeStr,
        venue
      };
    }).filter(Boolean);
  });

  await browser.close();
  return games;
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

async function main() {
  await fs.mkdir(SUPPLEMENTAL_DATA_DIR, { recursive: true });

  try {
    const rawGames = await scrapeSchedule();
    console.log(`Found ${rawGames.length} raw games.`);

    const teamEvents = {}; // teamId -> events[]

    for (const game of rawGames) {
      const homeId = TEAM_NAME_TO_ID[game.homeTeam];
      const awayId = TEAM_NAME_TO_ID[game.awayTeam];

      if (!homeId || !awayId) {
        console.warn(`Could not resolve IDs for ${game.homeTeam} vs ${game.awayTeam}`);
        continue;
      }

      const gameDate = parseDate(game.dateStr, game.timeStr);
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

      const teamName = Object.keys(TEAM_NAME_TO_ID).find(name => TEAM_NAME_TO_ID[name] === teamId);

      await fs.writeFile(filePath, JSON.stringify({
        teamId,
        teamName,
        updatedAt: new Date().toISOString(),
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
