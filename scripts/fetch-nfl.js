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

          const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
          const list = [];
          let match;

          while ((match = uuidRegex.exec(text)) !== null) {
            const gameId = match[0];
            const idx = match.index;
            const chunk = text.slice(idx, idx + 2500);

            if (chunk.includes('homeTeam') && chunk.includes('awayTeam')) {
              const homeIdx = chunk.indexOf('homeTeam');
              const awayIdx = chunk.indexOf('awayTeam');

              const extractKeyVal = (keyName, startPos) => {
                const kIdx = chunk.indexOf(keyName, startPos);
                if (kIdx === -1) return null;
                const sub = chunk.slice(kIdx + keyName.length);
                const quoteMatch = sub.match(/[:\\\"\s]+([^\\\"\{\}]+)/);
                return quoteMatch ? quoteMatch[1].trim() : null;
              };

              const homeName = extractKeyVal('fullName', homeIdx);
              const awayName = extractKeyVal('fullName', awayIdx);
              const dateVal = extractKeyVal('date', 0);
              const timeVal = extractKeyVal('time', 0);
              const venueName = extractKeyVal('name', chunk.indexOf('venue'));

              if (homeName && awayName && timeVal) {
                const game = {
                  id: gameId,
                  homeTeam: homeName,
                  awayTeam: awayName,
                  date: dateVal,
                  time: timeVal,
                  venue: venueName
                };
                if (!list.some(g => g.id === game.id)) {
                  list.push(game);
                }
              }
            }
          }
          return list;
        });

        console.log(`  Found ${weekGames.length} games for Week ${weekNum}.`);
        gamesList.push(...weekGames);

      } catch (err) {
        console.error(`  Failed to scrape Week ${weekNum}: ${err.message}`);
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

    const todayStr = new Date().toISOString().split('T')[0];
    const teamGamesMap = {};
    for (const teamId of Object.keys(NFL_TEAMS)) {
      teamGamesMap[teamId] = [];
    }

    for (const game of rawGames) {
      if (!game.time || !game.time.includes('T')) continue; // Safety guard check

      const homeId = findTeamIdByName(game.homeTeam);
      const awayId = findTeamIdByName(game.awayTeam);

      if (!homeId || !awayId) continue;

      const dateEvent = game.date || game.time.split('T')[0];
      if (dateEvent < todayStr) continue; // Keep only upcoming games

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

    // Static default timestamp to make sure generateAt never changes unnecessarily
    const defaultStaticTime = '2026-07-18T00:00:00.000Z';

    for (const [teamId, events] of Object.entries(teamGamesMap)) {
      const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${teamId}.json`);

      let existingData = null;
      try {
        const content = await fs.readFile(filePath, 'utf8');
        existingData = JSON.parse(content);
      } catch (e) {
        // File does not exist yet
      }

      // We ALWAYS preserve the existing timestamps if they exist, to ensure generateAt/updatedAt NEVER change.
      // If the file is new, we write the static default timestamp so it never changes in subsequent runs.
      const finalUpdatedAt = existingData?.updatedAt || defaultStaticTime;
      const finalGeneratedAt = existingData?.generatedAt || existingData?.generateAt || defaultStaticTime;
      const finalGenerateAt = existingData?.generateAt || existingData?.generatedAt || defaultStaticTime;

      await fs.writeFile(filePath, JSON.stringify({
        teamId,
        teamName: NFL_TEAMS[teamId].name,
        updatedAt: finalUpdatedAt,
        generatedAt: finalGeneratedAt,
        generateAt: finalGenerateAt,
        events: events.sort((a, b) => new Date(a.strTimestamp) - new Date(b.strTimestamp))
      }, null, 2));

      console.log(`  Saved ${events.length} upcoming games for ${NFL_TEAMS[teamId].name} (${teamId})`);
    }

    console.log('NFL Playwright schedules fetch complete.');

  } catch (error) {
    console.error('Error in NFL Playwright schedules fetch:', error);
    process.exitCode = 1;
  }
}

main();
