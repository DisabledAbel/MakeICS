import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchRtShow, fetchRtEpisodes } from '../lib/rottenTomatoes.js';
import { closeBrowser } from '../lib/scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TV_DATA_DIR = path.join(__dirname, '../lib/data/tv');
const TRACKED_SHOWS_FILE = path.join(TV_DATA_DIR, 'tracked-shows.json');
const OUTPUT_FILE = path.join(TV_DATA_DIR, 'rotten-tomatoes.json');

async function main() {
  console.log('Starting Rotten Tomatoes schedule pre-cache fetcher...');
  try {
    await fs.mkdir(TV_DATA_DIR, { recursive: true });

    let trackedShows = ['Sofia the First: Royal Magic'];
    try {
      const content = await fs.readFile(TRACKED_SHOWS_FILE, 'utf8');
      trackedShows = JSON.parse(content);
      console.log(`Loaded ${trackedShows.length} tracked shows from ${TRACKED_SHOWS_FILE}.`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(`Tracked shows file not found. Creating default with Sofia the First: Royal Magic.`);
        await fs.writeFile(TRACKED_SHOWS_FILE, JSON.stringify(trackedShows, null, 2));
      } else {
        console.warn('Error reading tracked-shows.json:', err.message);
      }
    }

    let existingData = { generatedAt: '', shows: {} };
    try {
      const content = await fs.readFile(OUTPUT_FILE, 'utf8');
      existingData = JSON.parse(content);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('Error reading existing rotten-tomatoes.json:', err.message);
      }
    }

    const showsData = { ...existingData.shows };

    for (const query of trackedShows) {
      console.log(`Processing tracked show: "${query}"`);
      try {
        // Find show ID and episodes on TVMaze first to determine which seasons exist
        let seasonsToFetch = new Set([1]); // default to season 1
        try {
          const tvmazeUrl = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}`;
          const response = await fetch(tvmazeUrl);
          if (response.ok) {
            const show = await response.json();
            const episodesResponse = await fetch(`https://api.tvmaze.com/shows/${show.id}/episodes?specials=0`);
            if (episodesResponse.ok) {
              const episodes = await episodesResponse.json();
              episodes.forEach(ep => {
                if (ep.season) {
                  seasonsToFetch.add(ep.season);
                }
              });
            }
          }
        } catch (e) {
          console.warn(`  Failed to retrieve seasons from TVMaze for "${query}":`, e.message);
        }

        // Search Rotten Tomatoes
        const rtShow = await searchRtShow(query);
        if (!rtShow) {
          console.warn(`  Show "${query}" not found on Rotten Tomatoes search.`);
          continue;
        }

        console.log(`  Found RT show "${rtShow.title}" (slug: ${rtShow.slug})`);

        // Fetch episodes for each season
        const seasons = Array.from(seasonsToFetch).sort((a, b) => a - b);
        const rtEpisodesList = [];

        for (const seasonNumber of seasons) {
          console.log(`  Fetching episodes for RT show "${rtShow.slug}" season ${seasonNumber}...`);
          try {
            const eps = await fetchRtEpisodes(rtShow.slug, seasonNumber);
            if (Array.isArray(eps)) {
              rtEpisodesList.push(...eps);
              console.log(`    Successfully fetched ${eps.length} episodes for season ${seasonNumber}.`);
            }
          } catch (err) {
            console.error(`    Failed to fetch RT episodes for season ${seasonNumber}:`, err.message);
          }
        }

        showsData[rtShow.slug] = {
          slug: rtShow.slug,
          title: rtShow.title,
          url: rtShow.url,
          meterScore: rtShow.meterScore,
          meterClass: rtShow.meterClass,
          startYear: rtShow.startYear,
          episodes: rtEpisodesList
        };

      } catch (err) {
        console.error(`Error processing "${query}":`, err.message);
      }
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      shows: showsData
    };

    const tempFile = `${OUTPUT_FILE}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(payload, null, 2));
    await fs.rename(tempFile, OUTPUT_FILE);
    console.log(`Successfully saved Rotten Tomatoes pre-cached data to ${OUTPUT_FILE}`);

  } catch (error) {
    console.error('Fatal error in fetch-rt main:', error);
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
  console.error('Unhandled error in fetch-rt main:', err);
  process.exit(1);
});
