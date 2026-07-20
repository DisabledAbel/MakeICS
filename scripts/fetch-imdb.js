import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchImdbEpisodes } from '../lib/imdbEpisodes.js';
import { closeBrowser } from '../lib/scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TV_DATA_DIR = path.join(__dirname, '../lib/data/tv');
const TRACKED_SHOWS_FILE = path.join(TV_DATA_DIR, 'tracked-shows.json');
const OUTPUT_FILE = path.join(TV_DATA_DIR, 'imdb-episodes.json');

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function main() {
  console.log('Starting IMDb TV schedule pre-cache fetcher...');
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
        console.warn('Error reading existing imdb-episodes.json:', err.message);
      }
    }

    const showSet = new Set();
    showSet.add('Sofia the First: Royal Magic');

    if (Array.isArray(trackedShows)) {
      for (const show of trackedShows) {
        if (typeof show === 'string' && show.trim()) {
          showSet.add(show.trim());
        }
      }
    }

    // Discover US TV show names dynamically from TVMaze schedule (next 7 days)
    console.log('Discovering TV shows from TVMaze US schedule...');
    try {
      for (let i = 0; i <= 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().slice(0, 10);
        const scheduleUrl = `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`;
        try {
          const response = await fetchWithTimeout(scheduleUrl);
          if (response.ok) {
            const scheduleData = await response.json();
            if (Array.isArray(scheduleData)) {
              for (const item of scheduleData) {
                const name = item.show?.name;
                if (typeof name === 'string' && name.trim()) {
                  showSet.add(name.trim());
                }
              }
            }
          }
        } catch (fetchErr) {
          console.warn(`  Error fetching US schedule for ${dateStr}:`, fetchErr.message);
        }
      }
    } catch (scheduleErr) {
      console.warn('Could not discover shows from TVMaze US schedule:', scheduleErr.message);
    }

    const showsToFetch = Array.from(showSet);
    console.log(`Discovered ${showsToFetch.length} unique TV shows to process:`, showsToFetch);

    const showsData = { ...existingData.shows };

    for (const query of showsToFetch) {
      console.log(`Processing TV show: "${query}"`);
      try {
        let imdbId = null;
        let seasonsToFetch = new Set([1]);
        try {
          const tvmazeUrl = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}`;
          const response = await fetchWithTimeout(tvmazeUrl);
          if (response.ok) {
            const show = await response.json();
            imdbId = show.externals?.imdb || null;
            const episodesResponse = await fetchWithTimeout(`https://api.tvmaze.com/shows/${show.id}/episodes?specials=0`);
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

        if (!imdbId) {
          console.warn(`  Show "${query}" has no IMDb ID on TVMaze.`);
          continue;
        }

        const seasons = Array.from(seasonsToFetch).sort((a, b) => b - a).slice(0, 2); // Fetch latest 2 seasons to avoid excessive crawls
        const imdbEpisodesList = [];

        for (const seasonNumber of seasons) {
          console.log(`  Fetching episodes for IMDb ID "${imdbId}" season ${seasonNumber}...`);
          try {
            const eps = await fetchImdbEpisodes(imdbId, seasonNumber);
            if (Array.isArray(eps)) {
              imdbEpisodesList.push(...eps);
              console.log(`    Successfully fetched ${eps.length} episodes for season ${seasonNumber}.`);
            }
          } catch (err) {
            console.error(`    Failed to fetch IMDb episodes for season ${seasonNumber}:`, err.message);
          }
        }

        if (imdbEpisodesList.length > 0 || !showsData[imdbId]) {
          showsData[imdbId] = {
            imdbId,
            title: query,
            episodes: imdbEpisodesList
          };
        } else {
          console.log(`  IMDb fetch returned no episodes. Preserving existing cached entry for ${imdbId}.`);
        }

      } catch (err) {
        console.error(`Error processing "${query}":`, err.message);
      }
    }

    const payload = {
      generatedAt: existingData.generatedAt || new Date().toISOString(),
      shows: showsData
    };

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2));
    console.log(`Successfully saved IMDb pre-cached data to ${OUTPUT_FILE}`);

  } catch (error) {
    console.error('Fatal error in fetch-imdb main:', error);
    process.exitCode = 1;
  } finally {
    try {
      await closeBrowser();
    } catch (err) {}
  }
}

main().catch(err => {
  console.error('Unhandled error in fetch-imdb main:', err);
  process.exit(1);
});
