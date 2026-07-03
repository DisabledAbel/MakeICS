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

    let existingMovies = [];
    try {
      const content = await fs.readFile(OUTPUT_FILE, 'utf8');
      const existingData = JSON.parse(content);
      existingMovies = existingData.movies || [];
      console.log(`Loaded ${existingMovies.length} existing movies.`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('Error reading existing movie data:', err.message);
      }
    }

    // Merge logic: use Map for unique IDs, new data overwrites old data
    const movieMap = new Map();
    existingMovies.forEach(m => movieMap.set(m.id, m));
    movies.forEach(m => movieMap.set(m.id, m));

    const mergedMovies = Array.from(movieMap.values()).sort((a, b) => {
      const dateA = new Date(a.releaseDate);
      const dateB = new Date(b.releaseDate);
      const isInvalidA = isNaN(dateA.getTime());
      const isInvalidB = isNaN(dateB.getTime());
      if (isInvalidA && isInvalidB) return 0;
      if (isInvalidA) return 1;
      if (isInvalidB) return -1;
      return dateA - dateB;
    });

    const payload = {
      generatedAt: new Date().toISOString(),
      movies: mergedMovies
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
    try {
      await closeBrowser();
    } catch (err) {
      console.error('Error closing browser:', err);
    }
  }
}

main().catch(err => {
  console.error('Unhandled error in main:', err);
  process.exit(1);
});
