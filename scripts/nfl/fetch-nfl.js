import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPLEMENTAL_DATA_DIR = path.join(__dirname, '../lib/data/sports/supplemental');

const NFL_TEAMS = {
  '134918': { name: 'Buffalo Bills', abbr: 'BUF' },
  '134919': { name: 'Miami Dolphins', abbr: 'MIA' },
  '134920': { name: 'New England Patriots', abbr: 'NE' },
  '134921': { name: 'New York Jets', abbr: 'NYJ' },
  '134922': { name: 'Baltimore Ravens', abbr: 'BAL' },
  '134923': { name: 'Cincinnati Bengals', abbr: 'CIN' },
  '134924': { name: 'Cleveland Browns', abbr: 'CLE' },
  '134925': { name: 'Pittsburgh Steelers', abbr: 'PIT' },
  '134926': { name: 'Houston Texans', abbr: 'HOU' },
  '134927': { name: 'Indianapolis Colts', abbr: 'IND' },
  '134928': { name: 'Jacksonville Jaguars', abbr: 'JAX' },
  '134929': { name: 'Tennessee Titans', abbr: 'TEN' },
  '134930': { name: 'Denver Broncos', abbr: 'DEN' },
  '134931': { name: 'Kansas City Chiefs', abbr: 'KC' },
  '134932': { name: 'Las Vegas Raiders', abbr: 'LV' },
  '134934': { name: 'Dallas Cowboys', abbr: 'DAL' },
  '134935': { name: 'New York Giants', abbr: 'NYG' },
  '134936': { name: 'Philadelphia Eagles', abbr: 'PHI' },
  '134937': { name: 'Washington Commanders', abbr: 'WAS' },
  '134938': { name: 'Chicago Bears', abbr: 'CHI' },
  '134939': { name: 'Detroit Lions', abbr: 'DET' },
  '134940': { name: 'Green Bay Packers', abbr: 'GB' },
  '134941': { name: 'Minnesota Vikings', abbr: 'MIN' },
  '134942': { name: 'Atlanta Falcons', abbr: 'ATL' },
  '134943': { name: 'Carolina Panthers', abbr: 'CAR' },
  '134944': { name: 'New Orleans Saints', abbr: 'NO' },
  '134945': { name: 'Tampa Bay Buccaneers', abbr: 'TB' },
  '134946': { name: 'Arizona Cardinals', abbr: 'ARI' },
  '134948': { name: 'San Francisco 49ers', abbr: 'SF' },
  '134949': { name: 'Seattle Seahawks', abbr: 'SEA' },
  '135907': { name: 'Los Angeles Rams', abbr: 'LA' },
  '135908': { name: 'Los Angeles Chargers', abbr: 'LAC' }
};

const findTeamIdByName = (fullName) => {
  const trimmed = fullName.toLowerCase().trim();
  const entry = Object.entries(NFL_TEAMS).find(([id, config]) => config.name.toLowerCase().trim() === trimmed);
  return entry ? entry[0] : null;
};

function decodeUnicodeEscapes(str) {
  if (!str) return str;
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, grp) => {
    return String.fromCharCode(parseInt(grp, 16));
  }).replace(/&amp;/g, '&');
}

async function scrapeNFLSchedules() {
  const browser = await chromium.launch({ headless: true });
  const gamesList = [];

  try {
    const page = await browser.newPage();
    const currentYear = 2026; // Match current schedule year

    for (let weekNum = 1; weekNum <= 18; weekNum++) {
      const url = `https://www.nfl.com/schedules/${currentYear}/by-week/week-${weekNum}`;
      console.log(`Scraping ${url}...`);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000); // Allow react server components to load and inject state

        const weekGames = await page.evaluate(() => {
          const scripts = Array.from(document.querySelectorAll('script'));
          const text = scripts.map(s => s.innerText).join('\n');

          const clean = text
            .replace(/\\\\\\\\\\\\"/g, '"')
            .replace(/\\\\\\\\"/g, '"')
            .replace(/\\\\"/g, '"')
            .replace(/\\"/g, '"')
            .replace(/\\\\u0022/g, '"')
            .replace(/\\\\u002f/g, '/')
            .replace(/\\\\/g, '');

          const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
          const list = [];
          let match;

          while ((match = uuidRegex.exec(clean)) !== null) {
            const gameId = match[0];
            if (gameId.startsWith('1040')) continue; // Skip team/venue profiles!

            const idx = match.index;
            const chunk = clean.slice(idx, idx + 1500);

            if (chunk.includes('homeTeam') && chunk.includes('awayTeam')) {
              const extractProp = (subChunk, key) => {
                const keyIdx = subChunk.indexOf('"' + key + '"');
                if (keyIdx === -1) return null;
                const sub = subChunk.slice(keyIdx + key.length + 2);
                const m = sub.match(/[:"\s]+([^"{}]+)/);
                return m ? m[1].trim() : null;
              };

              const homeIdx = chunk.indexOf('homeTeam');
              const awayIdx = chunk.indexOf('awayTeam');

              const homeSub = chunk.slice(homeIdx, homeIdx + 300);
              const homeNameMatch = homeSub.match(/"fullName"\s*:\s*"([^"]+)"/) || homeSub.match(/"nickName"\s*:\s*"([^"]+)"/);
              const homeName = homeNameMatch ? homeNameMatch[1].trim() : null;

              const awaySub = chunk.slice(awayIdx, awayIdx + 300);
              const awayNameMatch = awaySub.match(/"fullName"\s*:\s*"([^"]+)"/) || awaySub.match(/"nickName"\s*:\s*"([^"]+)"/);
              const awayName = awayNameMatch ? awayNameMatch[1].trim() : null;

              const timeVal = extractProp(chunk, 'gameTime') || extractProp(chunk, 'time');
              const dateVal = extractProp(chunk, 'date');

              const venueIdx = chunk.indexOf('venue');
              let venueName = null;
              if (venueIdx !== -1) {
                const venueSub = chunk.slice(venueIdx, venueIdx + 300);
                const venueMatch = venueSub.match(/"name"\s*:\s*"([^"]+)"/);
                venueName = venueMatch ? venueMatch[1].trim() : null;
              }

              if (homeName && awayName) {
                if (!list.some(g => g.id === gameId)) {
                  list.push({
                    id: gameId,
                    homeTeam: homeName,
                    awayTeam: awayName,
                    date: dateVal,
                    time: timeVal,
                    venue: venueName
                  });
                }
              }
            }
          }
          return list;
        });

        // Treat 0 games parsed as a failure and abort immediately to protect files
        if (weekGames.length === 0) {
          throw new Error(`Parsed 0 games for Week ${weekNum}. Scheduled job aborted to prevent file corruption.`);
        }

        console.log(`  Found ${weekGames.length} games for Week ${weekNum}.`);
        gamesList.push(...weekGames);

      } catch (err) {
        console.error(`  Failed to scrape Week ${weekNum}: ${err.message}`);
        throw err; // Propagate any failed week to abort the job
      }
    }

  } finally {
    await browser.close();
  }

  return gamesList;
}

async function main() {
  console.log('Starting NFL schedule fetch via Playwright...');
  await fs.mkdir(SUPPLEMENTAL_DATA_DIR, { recursive: true });

  try {
    const rawGames = await scrapeNFLSchedules();
    console.log(`Scraped ${rawGames.length} total raw games.`);

    const nowInstant = new Date();
    const teamGamesMap = {};
    for (const teamId of Object.keys(NFL_TEAMS)) {
      teamGamesMap[teamId] = [];
    }

    // Deduplicate games using matchup + scheduled timing as unique identity
    const seenMatchups = new Set();
    const uniqueGames = [];

    for (const game of rawGames) {
      if (!game.time || !game.time.includes('T')) continue;

      const decodedHome = decodeUnicodeEscapes(game.homeTeam);
      const decodedAway = decodeUnicodeEscapes(game.awayTeam);
      const decodedVenue = decodeUnicodeEscapes(game.venue);

      // Unique matchup key
      const matchupKey = `${decodedHome}|${decodedAway}|${game.time}`;
      if (seenMatchups.has(matchupKey)) continue;
      seenMatchups.add(matchupKey);

      uniqueGames.push({
        id: game.id,
        homeTeam: decodedHome,
        awayTeam: decodedAway,
        date: game.date,
        time: game.time,
        venue: decodedVenue
      });
    }

    for (const game of uniqueGames) {
      const homeId = findTeamIdByName(game.homeTeam);
      const awayId = findTeamIdByName(game.awayTeam);

      if (!homeId || !awayId) continue;

      const gameTimeInstant = new Date(game.time);
      if (gameTimeInstant <= nowInstant) continue; // Keep only upcoming games (strictly future games)

      const dateEvent = game.date || game.time.split('T')[0];
      const strTime = game.time.split('T')[1].split('.')[0];
      const event = {
        idEvent: `sdv-nfl-${game.id}`.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        strEvent: `${game.homeTeam} vs ${game.awayTeam}`,
        strHomeTeam: game.homeTeam,
        strAwayTeam: game.awayTeam,
        dateEvent: dateEvent,
        strTime: strTime,
        strTimestamp: game.time,
        strLeague: 'NFL',
        strVenue: game.venue || null,
        strTVStation: null,
        strStatus: 'NS',
        source: 'sportsdataverse'
      };

      teamGamesMap[homeId].push(event);
      teamGamesMap[awayId].push(event);
    }

    const defaultStaticTime = '2026-07-18T00:00:00.000Z';

    for (const [teamId, events] of Object.entries(teamGamesMap)) {
      const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${teamId}.json`);

      let existingData = null;
      try {
        const content = await fs.readFile(filePath, 'utf8');
        existingData = JSON.parse(content);
      } catch (e) {
        // Suppress ONLY ENOENT errors; propagate malformed JSON and all other errors
        if (e.code !== 'ENOENT') {
          console.error(`Failed to read supplemental file for team ${teamId}: ${e.message}`);
          throw e;
        }
      }

      const sortedNewEvents = events.sort((a, b) => new Date(a.strTimestamp) - new Date(b.strTimestamp));

      let finalUpdatedAt = defaultStaticTime;
      let finalGeneratedAt = defaultStaticTime;
      let finalGenerateAt = defaultStaticTime;

      if (existingData) {
        // Compare the events payloads (excluding timestamps of course)
        const newEventsStr = JSON.stringify(sortedNewEvents);
        const existingEventsStr = JSON.stringify(existingData.events || []);

        if (newEventsStr === existingEventsStr) {
          // If unchanged, preserve all timestamps exactly
          finalUpdatedAt = existingData.updatedAt || defaultStaticTime;
          finalGeneratedAt = existingData.generatedAt || existingData.generateAt || defaultStaticTime;
          finalGenerateAt = existingData.generateAt || existingData.generatedAt || defaultStaticTime;
          console.log(`  No changes for ${NFL_TEAMS[teamId].name} (${teamId}). Preserving timestamps.`);
        } else {
          // If they differ, update updatedAt to current time, but retain original generation timestamps
          finalUpdatedAt = new Date().toISOString();
          finalGeneratedAt = existingData.generatedAt || existingData.generateAt || defaultStaticTime;
          finalGenerateAt = existingData.generateAt || existingData.generatedAt || defaultStaticTime;
          console.log(`  Schedules updated for ${NFL_TEAMS[teamId].name} (${teamId}). Updating updatedAt.`);
        }
      } else {
        console.log(`  Creating new file for ${NFL_TEAMS[teamId].name} (${teamId}).`);
      }

      await fs.writeFile(filePath, JSON.stringify({
        teamId,
        teamName: NFL_TEAMS[teamId].name,
        updatedAt: finalUpdatedAt,
        generatedAt: finalGeneratedAt,
        generateAt: finalGenerateAt,
        events: sortedNewEvents
      }, null, 2));

      console.log(`  Saved ${sortedNewEvents.length} upcoming games for ${NFL_TEAMS[teamId].name} (${teamId})`);
    }

    console.log('NFL Playwright schedules fetch complete.');

  } catch (error) {
    console.error('Error in NFL Playwright schedules fetch:', error);
    process.exitCode = 1;
  }
}

main();
