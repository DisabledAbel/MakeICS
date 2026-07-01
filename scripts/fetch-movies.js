import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchIMDbReleaseCalendar, closeBrowser } from '../lib/scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOVIES_DATA_DIR = path.join(__dirname, '../lib/data/movies');
const OUTPUT_FILE = path.join(MOVIES_DATA_DIR, 'upcoming.json');

async function main() {
  console.log('Fetching IMDb release calendar...');
  try {
    const movies = await fetchIMDbReleaseCalendar();

    if (movies.length === 0) {
      console.error('No movies found. Scraping might have failed or page structure changed.');
      process.exitCode = 1;
      return;
    }

    console.log(`Found ${movies.length} upcoming movies.`);

    const payload = {
      generatedAt: new Date().toISOString(),
      movies
    };

    await fs.mkdir(MOVIES_DATA_DIR, { recursive: true });
    const tempFile = `${OUTPUT_FILE}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(payload, null, 2));
    await fs.rename(tempFile, OUTPUT_FILE);
    console.log(`Saved movie data to ${OUTPUT_FILE}`);

  } catch (error) {
    console.error('Error fetching movies:', error);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}

main();
