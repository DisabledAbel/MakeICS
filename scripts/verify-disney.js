import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowser, closeBrowser } from '../lib/scraper.js';
import { fetchImdbEpisodes } from '../lib/imdbEpisodes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TV_DATA_DIR = path.join(__dirname, '../lib/data/tv');
const IMDB_DATA_FILE = path.join(TV_DATA_DIR, 'imdb-episodes.json');
const OUTPUT_FILE = path.join(TV_DATA_DIR, 'google-verified.json');

// Helper to fetch with timeout
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

// Sleep helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatDateVariants(dateStr) {
  if (!dateStr) return [];
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return [{ text: dateStr.toLowerCase(), hasYear: true }];

  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const shortMonths = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  const year = d.getUTCFullYear();
  const monthIdx = d.getUTCMonth();
  const day = d.getUTCDate();

  const mName = months[monthIdx];
  const sName = shortMonths[monthIdx];

  return [
    { text: dateStr.toLowerCase(), hasYear: true }, // YYYY-MM-DD
    { text: `${mName} ${day}, ${year}`.toLowerCase(), hasYear: true }, // June 11, 2026
    { text: `${sName} ${day}, ${year}`.toLowerCase(), hasYear: true }, // Jun 11, 2026
    { text: `${mName} ${day}`.toLowerCase(), hasYear: false }, // June 11
    { text: `${sName} ${day}`.toLowerCase(), hasYear: false } // Jun 11
  ];
}

function matchVariant(bodyText, variant) {
  if (variant.hasYear) {
    return bodyText.includes(variant.text);
  } else {
    const escaped = escapeRegExp(variant.text);
    const regex = new RegExp(escaped + '(?!\\d)');
    return regex.test(bodyText);
  }
}

async function verifyEpisodeOnGoogle(page, showName, season, number, tvmazeDate, imdbDate) {
  const query = `${showName} S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')} episode release date`;
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

  console.log(`  Searching Google for query: "${query}"`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const bodyText = (await page.innerText('body')).toLowerCase();

    const isBlocked = bodyText.includes('unusual traffic') ||
                      bodyText.includes('recaptcha') ||
                      bodyText.includes('captcha') ||
                      bodyText.includes('robot') ||
                      bodyText.includes('our systems have detected unusual traffic');

    if (isBlocked) {
      console.warn(`    [WARNING] Google search query blocked/CAPTCHA detected for: "${query}".`);
      return tvmazeDate; // fallback
    }

    const tvmazeVariants = formatDateVariants(tvmazeDate);
    const imdbVariants = formatDateVariants(imdbDate);

    let tvmazeMatched = false;
    for (const v of tvmazeVariants) {
      if (matchVariant(bodyText, v)) {
        tvmazeMatched = true;
        break;
      }
    }

    let imdbMatched = false;
    for (const v of imdbVariants) {
      if (matchVariant(bodyText, v)) {
        imdbMatched = true;
        break;
      }
    }

    if (tvmazeMatched && !imdbMatched) {
      console.log(`    Google matches TVMaze date: ${tvmazeDate}`);
      return tvmazeDate;
    } else if (imdbMatched && !tvmazeMatched) {
      console.log(`    Google matches IMDb date: ${imdbDate}`);
      return imdbDate;
    } else if (tvmazeMatched && imdbMatched) {
      console.log(`    Google matches both. Defaulting to IMDb: ${imdbDate}`);
      return imdbDate;
    } else {
      console.log(`    Google matches neither. Defaulting to TVMaze: ${tvmazeDate}`);
      return tvmazeDate;
    }
  } catch (err) {
    console.warn(`    Google search failed for "${query}":`, err.message);
    return tvmazeDate; // fallback
  }
}

async function main() {
  const startTime = Date.now();
  const MAX_DURATION = 6 * 60 * 60 * 1000; // 6 hours max

  console.log('Starting Disney Channel and Disney Junior TV schedule verification...');
  try {
    await fs.mkdir(TV_DATA_DIR, { recursive: true });

    const showSet = new Set();

    // 1. Static candidate list of known Disney shows
    const STATIC_DISNEY_SHOWS = [
      "Sofia the First: Royal Magic",
      "Wizards Beyond Waverly Place",
      "SuperKitties",
      "Ariel",
      "Mickey Mouse Clubhouse+",
      "Bluey",
      "Pupstruction",
      "Mickey Mouse Funhouse",
      "Kiff",
      "Big City Greens",
      "ZOMBIES: The Re-Animated Series",
      "Hailey's on It!",
      "Primos",
      "Hamster & Gretel"
    ];
    STATIC_DISNEY_SHOWS.forEach(s => showSet.add(s));

    // 2. Discover dynamically from TVMaze US schedule (today and next 14 days)
    console.log('Discovering Disney shows from TVMaze US schedule (next 14 days)...');
    for (let i = 0; i <= 14; i++) {
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
              const net = item.show?.network?.name || item.show?.webChannel?.name || '';
              if (typeof name === 'string' && name.trim()) {
                if (net.toLowerCase().includes('disney channel') || net.toLowerCase().includes('disney junior')) {
                  showSet.add(name.trim());
                }
              }
            }
          }
        }
      } catch (fetchErr) {
        console.warn(`  Error fetching US schedule for ${dateStr}:`, fetchErr.message);
      }
      await sleep(100);
    }

    const uniqueCandidates = Array.from(showSet);
    console.log(`Discovered ${uniqueCandidates.length} candidate shows. Verifying network origins...`);

    const disneyShowsToVerify = [];

    // Verify network origins for each show via TVMaze single search
    for (const query of uniqueCandidates) {
      try {
        const tvmazeUrl = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}`;
        const response = await fetchWithTimeout(tvmazeUrl);
        if (response.ok) {
          const show = await response.json();
          const networkName = show.network?.name || show.webChannel?.name || '';
          const isDisney = networkName.toLowerCase().includes('disney channel') ||
                            networkName.toLowerCase().includes('disney junior') ||
                            STATIC_DISNEY_SHOWS.includes(show.name); // Keep if statically known

          if (isDisney) {
            disneyShowsToVerify.push(show);
            console.log(`  [CONFIRMED] "${show.name}" - Network: ${networkName}`);
          }
        }
      } catch (err) {
        console.warn(`  Failed to search TVMaze for "${query}":`, err.message);
      }
      await sleep(100);
    }

    console.log(`Confirmed ${disneyShowsToVerify.length} Disney Channel / Disney Junior shows to verify.`);

    // Load existing overrides
    let existingVerified = {};
    try {
      const content = await fs.readFile(OUTPUT_FILE, 'utf8');
      existingVerified = JSON.parse(content);
    } catch (err) {
      // Ignored
    }

    // Load IMDb cached episodes
    let imdbData = { shows: {} };
    try {
      const content = await fs.readFile(IMDB_DATA_FILE, 'utf8');
      imdbData = JSON.parse(content);
    } catch (err) {
      // Ignored
    }

    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const todayStr = new Date().toISOString().slice(0, 10);

    // Global prune of past verified overrides
    const activeVerified = {};
    for (const [key, value] of Object.entries(existingVerified)) {
      if (value && value.airdate && value.airdate >= todayStr) {
        activeVerified[key] = value;
      } else {
        console.log(`Pruning past verified episode override: ${key} (airdate: ${value?.airdate})`);
      }
    }

    const updatedVerified = { ...activeVerified };

    // Process Disney shows
    for (const show of disneyShowsToVerify) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= (MAX_DURATION - 2 * 60 * 1000)) {
        console.warn(`Reached time limit. Stopping further searches.`);
        break;
      }

      console.log(`[Processing] "${show.name}"`);

      // Get TVMaze episodes
      let tvmazeEps = [];
      try {
        const epResponse = await fetchWithTimeout(`https://api.tvmaze.com/shows/${show.id}/episodes?specials=0`);
        if (epResponse.ok) {
          tvmazeEps = await epResponse.json();
        }
      } catch (err) {
        console.warn(`  Failed to retrieve TVMaze episodes for "${show.name}":`, err.message);
        continue;
      }

      const imdbId = show.externals?.imdb || null;
      if (!imdbId) {
        console.log(`  No IMDb ID for "${show.name}". Skipping IMDb alignment.`);
        continue;
      }

      // Find or fetch IMDb episodes
      let imdbEpsList = [];
      const cachedShow = imdbData.shows?.[imdbId];
      if (cachedShow && Array.isArray(cachedShow.episodes)) {
        imdbEpsList = cachedShow.episodes;
        console.log(`  Found cached IMDb episodes for "${show.name}" (Count: ${imdbEpsList.length})`);
      } else {
        // If not cached, we look at the upcoming seasons and fetch live from IMDb
        const seasonsToFetch = new Set();
        tvmazeEps.forEach(ep => {
          if (ep.airdate && ep.airdate >= todayStr && ep.season) {
            seasonsToFetch.add(ep.season);
          }
        });
        if (seasonsToFetch.size === 0 && tvmazeEps.length > 0) {
          const maxSeason = Math.max(...tvmazeEps.map(e => e.season));
          seasonsToFetch.add(maxSeason);
        }

        const sortedSeasons = Array.from(seasonsToFetch).sort((a, b) => b - a).slice(0, 2);
        console.log(`  No cache for "${show.name}". Fetching IMDb live for seasons:`, sortedSeasons);

        for (const sNum of sortedSeasons) {
          try {
            const eps = await fetchImdbEpisodes(imdbId, sNum);
            if (Array.isArray(eps)) {
              imdbEpsList.push(...eps);
            }
          } catch (err) {
            console.warn(`  Failed to fetch IMDb episodes for season ${sNum}:`, err.message);
          }
          await sleep(500);
        }
      }

      const imdbEpsMap = new Map();
      imdbEpsList.forEach(ep => {
        imdbEpsMap.set(`${ep.season}-${ep.number}`, ep);
      });

      // Find mismatches in upcoming episodes
      for (const tvEp of tvmazeEps) {
        if (!tvEp.airdate || tvEp.airdate < todayStr) {
          continue; // only upcoming
        }

        const key = `${tvEp.season}-${tvEp.number}`;
        const imdbEp = imdbEpsMap.get(key);

        if (imdbEp && imdbEp.airdate && imdbEp.airdate !== tvEp.airdate) {
          console.log(`  Mismatch found for S${tvEp.season}E${tvEp.number}: TVMaze=${tvEp.airdate}, IMDb=${imdbEp.airdate}`);

          const verifiedDate = await verifyEpisodeOnGoogle(
            page,
            show.name,
            tvEp.season,
            tvEp.number,
            tvEp.airdate,
            imdbEp.airdate
          );

          const overrideKey = `${show.name}-${tvEp.season}-${tvEp.number}`;
          const existingOverride = existingVerified[overrideKey];
          updatedVerified[overrideKey] = {
            airdate: verifiedDate,
            name: imdbEp.name || tvEp.name,
            verifiedAt: (existingOverride && existingOverride.verifiedAt) ? existingOverride.verifiedAt : new Date().toISOString()
          };
        }
      }
    }

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(updatedVerified, null, 2));
    console.log(`Successfully saved Google-verified data to ${OUTPUT_FILE}`);

  } catch (error) {
    console.error('Fatal error in verify-disney main:', error);
    process.exitCode = 1;
  } finally {
    try {
      await closeBrowser();
    } catch (err) {
      console.error('Error closing browser:', err);
    }
  }
}

// Allow test execution to export internal functions or run main directly
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('verify-disney.js')
);

if (isMain && process.env.NODE_ENV !== 'test') {
  main().catch(err => {
    console.error('Unhandled error in verify-disney main:', err);
    process.exit(1);
  });
}

// Export for testing
export {
  formatDateVariants,
  matchVariant,
  verifyEpisodeOnGoogle,
  fetchWithTimeout
};
