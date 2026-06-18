import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchScheduleFromESPN, closeBrowser } from '../lib/scraper.js';
import { normalizeScrapedEvent } from '../lib/sports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPLEMENTAL_DATA_DIR = path.join(__dirname, '../lib/data/sports/supplemental');
const PORTLAND_FIRE_ID = '152565';
const TEAM_NAME = 'Portland Fire';

async function main() {
  console.log(`Starting fetch for ${TEAM_NAME}...`);
  await fs.mkdir(SUPPLEMENTAL_DATA_DIR, { recursive: true });

  try {
    console.log(`  Scraping ESPN for ${TEAM_NAME} (wnba/por)...`);
    const games = await fetchScheduleFromESPN('wnba', 'por');

    if (games.length === 0) {
      console.warn(`  No games found for ${TEAM_NAME} on ESPN.`);
      return;
    }

    console.log(`  Found ${games.length} games. Normalizing...`);
    const normalizedEvents = games.map(g => normalizeScrapedEvent(g, TEAM_NAME));

    // Deduplicate by generated ID
    const seenIds = new Set();
    const uniqueEvents = [];
    for (const event of normalizedEvents) {
      if (!seenIds.has(event.idEvent)) {
        seenIds.add(event.idEvent);
        uniqueEvents.push(event);
      }
    }

    const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${PORTLAND_FIRE_ID}.json`);
    await fs.writeFile(filePath, JSON.stringify({
      teamId: PORTLAND_FIRE_ID,
      teamName: TEAM_NAME,
      updatedAt: new Date().toISOString(),
      events: uniqueEvents
    }, null, 2));

    console.log(`  Successfully saved ${uniqueEvents.length} events to ${filePath}`);

  } catch (error) {
    console.error(`Error fetching ${TEAM_NAME}:`, error);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}

main().catch(console.error);
