import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowser, closeBrowser } from '../lib/scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TV_DATA_DIR = path.join(__dirname, '../lib/data/tv');
const TRACKED_SHOWS_FILE = path.join(TV_DATA_DIR, 'tracked-shows.json');
const RT_DATA_FILE = path.join(TV_DATA_DIR, 'rotten-tomatoes.json');
const OUTPUT_FILE = path.join(TV_DATA_DIR, 'google-verified.json');

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

async function verifyEpisodeOnGoogle(page, showName, season, number, tvmazeDate, rtDate) {
  const query = `${showName} S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')} episode release date`;
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

  console.log(`  Searching Google for query: "${query}"`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait a brief moment for any dynamic content/snippets
    await page.waitForTimeout(2000);

    const bodyText = (await page.innerText('body')).toLowerCase();

    // Check for CAPTCHA/blocking signatures
    const isBlocked = bodyText.includes('unusual traffic') ||
                      bodyText.includes('recaptcha') ||
                      bodyText.includes('captcha') ||
                      bodyText.includes('robot') ||
                      bodyText.includes('our systems have detected unusual traffic');

    if (isBlocked) {
      console.warn(`    [WARNING] Google search query blocked/CAPTCHA detected for: "${query}".`);
      return rtDate || tvmazeDate; // default fallback, bypass "matches neither" determination
    }

    const tvmazeVariants = formatDateVariants(tvmazeDate);
    const rtVariants = formatDateVariants(rtDate);

    let tvmazeMatched = false;
    for (const v of tvmazeVariants) {
      if (matchVariant(bodyText, v)) {
        tvmazeMatched = true;
        break;
      }
    }

    let rtMatched = false;
    for (const v of rtVariants) {
      if (matchVariant(bodyText, v)) {
        rtMatched = true;
        break;
      }
    }

    if (tvmazeMatched && !rtMatched) {
      console.log(`    Google matches TVMaze date: ${tvmazeDate}`);
      return tvmazeDate;
    } else if (rtMatched && !tvmazeMatched) {
      console.log(`    Google matches Rotten Tomatoes date: ${rtDate}`);
      return rtDate;
    } else if (tvmazeMatched && rtMatched) {
      console.log(`    Google matches both. Defaulting to Rotten Tomatoes: ${rtDate}`);
      return rtDate;
    } else {
      console.log(`    Google matches neither. Defaulting to Rotten Tomatoes: ${rtDate}`);
      return rtDate;
    }
  } catch (err) {
    console.warn(`    Google search failed for "${query}":`, err.message);
    return rtDate || tvmazeDate; // default fallback
  }
}

async function main() {
  const startTime = Date.now();
  const MAX_DURATION = 6 * 60 * 60 * 1000; // 6 hours in ms
  const MIN_DURATION = 10 * 60 * 1000; // 10 minutes in ms

  console.log('Starting Google verification schedule matcher...');
  try {
    await fs.mkdir(TV_DATA_DIR, { recursive: true });

    // Discover every TV show name/title we can find across TV data files on MakeICS
    const showSet = new Set();

    // 1. Add standard default/fallback show
    showSet.add('Sofia the First: Royal Magic');

    // 2. Add show names from tracked-shows.json
    let trackedShows = [];
    try {
      const content = await fs.readFile(TRACKED_SHOWS_FILE, 'utf8');
      trackedShows = JSON.parse(content);
    } catch (err) {
      console.warn('Tracked shows file not found or couldn\'t be read.');
    }
    if (Array.isArray(trackedShows)) {
      for (const show of trackedShows) {
        if (typeof show === 'string' && show.trim()) {
          showSet.add(show.trim());
        }
      }
    }

    // 3. Add show names from existing cached rotten-tomatoes.json
    let rtData = { shows: {} };
    try {
      const content = await fs.readFile(RT_DATA_FILE, 'utf8');
      rtData = JSON.parse(content);
    } catch (err) {
      console.warn('Rotten Tomatoes data file not found.');
    }
    if (rtData && rtData.shows) {
      for (const show of Object.values(rtData.shows)) {
        if (show && typeof show.title === 'string' && show.title.trim()) {
          showSet.add(show.title.trim());
        }
      }
    }

    // 4. Scan the TV data folder for any other potential .json files containing shows
    try {
      const files = await fs.readdir(TV_DATA_DIR);
      for (const file of files) {
        if (file.endsWith('.json') && file !== 'rotten-tomatoes.json' && file !== 'tracked-shows.json' && file !== 'google-verified.json') {
          try {
            const filePath = path.join(TV_DATA_DIR, file);
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            if (Array.isArray(data)) {
              for (const item of data) {
                if (typeof item === 'string' && item.trim()) {
                  showSet.add(item.trim());
                }
              }
            } else if (data && typeof data === 'object') {
              const candidate = data.title || data.name || data.showName;
              if (typeof candidate === 'string' && candidate.trim()) {
                showSet.add(candidate.trim());
              }
            }
          } catch (fileErr) {
            console.warn(`Could not parse auxiliary TV show file ${file}:`, fileErr.message);
          }
        }
      }
    } catch (dirErr) {
      console.warn('Could not read TV data directory for extra show files:', dirErr.message);
    }

    const showsToFetch = Array.from(showSet);
    console.log(`Discovered ${showsToFetch.length} unique TV shows to process on MakeICS:`);
    showsToFetch.forEach(s => console.log(` - Fetching Google verification for: "${s}"`));

    let existingVerified = {};
    try {
      const content = await fs.readFile(OUTPUT_FILE, 'utf8');
      existingVerified = JSON.parse(content);
    } catch (err) {
      // Ignored
    }

    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const todayStr = new Date().toISOString().slice(0, 10);

    // Prune entries from existingVerified that have already aired (airdate < todayStr)
    const activeVerified = {};
    for (const [key, value] of Object.entries(existingVerified)) {
      if (value && value.airdate && value.airdate >= todayStr) {
        activeVerified[key] = value;
      } else {
        console.log(`Pruning past verified episode override: ${key} (airdate: ${value?.airdate})`);
      }
    }

    const updatedVerified = { ...activeVerified };

    for (const query of showsToFetch) {
      // Check if we are running out of time (buffer of 2 minutes to cleanly exit under 6 hours)
      const elapsed = Date.now() - startTime;
      if (elapsed >= (MAX_DURATION - 2 * 60 * 1000)) {
        console.warn(`Reached maximum 6-hour time limit. Stopping further searches.`);
        break;
      }

      console.log(`[Fetching] TV show: "${query}"`);

      // 1. Fetch TVMaze episodes to find mismatches
      let tvmazeShow = null;
      let tvmazeEps = [];
      try {
        const tvmazeUrl = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}`;
        const response = await fetch(tvmazeUrl);
        if (response.ok) {
          tvmazeShow = await response.json();
          const epResponse = await fetch(`https://api.tvmaze.com/shows/${tvmazeShow.id}/episodes?specials=0`);
          if (epResponse.ok) {
            tvmazeEps = await epResponse.json();
          }
        }
      } catch (err) {
        console.warn(`  Failed to retrieve data from TVMaze for "${query}":`, err.message);
        continue;
      }

      // 2. Find corresponding pre-cached RT show and episodes
      const canonicalize = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const canonicalQuery = canonicalize(query);
      const canonicalShowName = tvmazeShow ? canonicalize(tvmazeShow.name) : '';

      let rtShow = Object.values(rtData.shows || {}).find(s => {
        const canonicalTitle = canonicalize(s.title);
        return canonicalTitle === canonicalQuery || (canonicalShowName && canonicalTitle === canonicalShowName);
      });

      if (!rtShow) {
        rtShow = Object.values(rtData.shows || {}).find(s => {
          const canonicalTitle = canonicalize(s.title);
          return canonicalTitle.includes(canonicalQuery) || canonicalQuery.includes(canonicalTitle) ||
                 (canonicalShowName && (canonicalTitle.includes(canonicalShowName) || canonicalShowName.includes(canonicalTitle)));
        });
      }

      if (!rtShow) {
        console.log(`  No Rotten Tomatoes cached data found for "${query}"`);
        continue;
      }

      const rtEpsMap = new Map();
      (rtShow.episodes || []).forEach(ep => {
        rtEpsMap.set(`${ep.season}-${ep.number}`, ep);
      });

      // 3. Look for mismatches in upcoming episodes
      for (const tvEp of tvmazeEps) {
        if (!tvEp.airdate || tvEp.airdate < todayStr) {
          continue; // only upcoming episodes
        }

        const key = `${tvEp.season}-${tvEp.number}`;
        const rtEp = rtEpsMap.get(key);

        if (rtEp && rtEp.airdate && rtEp.airdate !== tvEp.airdate) {
          console.log(`  Mismatch found for S${tvEp.season}E${tvEp.number}: TVMaze=${tvEp.airdate}, RT=${rtEp.airdate}`);

          const verifiedDate = await verifyEpisodeOnGoogle(
            page,
            tvmazeShow.name,
            tvEp.season,
            tvEp.number,
            tvEp.airdate,
            rtEp.airdate
          );

          const overrideKey = `${tvmazeShow.name}-${tvEp.season}-${tvEp.number}`;
          updatedVerified[overrideKey] = {
            airdate: verifiedDate,
            name: rtEp.name || tvEp.name,
            verifiedAt: new Date().toISOString()
          };
        }
      }
    }

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(updatedVerified, null, 2));
    console.log(`Successfully saved Google-verified data to ${OUTPUT_FILE}`);

    const totalElapsed = Date.now() - startTime;
    if (totalElapsed < MIN_DURATION) {
      const remaining = MIN_DURATION - totalElapsed;
      console.log(`Script finished early in ${Math.round(totalElapsed / 1000)}s. Sleeping for ${Math.round(remaining / 1000)}s to meet minimum 10-minute duration...`);
      await new Promise(resolve => setTimeout(resolve, remaining));
    }

  } catch (error) {
    console.error('Fatal error in google-verify main:', error);
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
  console.error('Unhandled error in google-verify main:', err);
  process.exit(1);
});
