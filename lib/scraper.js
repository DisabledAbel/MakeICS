import { chromium } from 'playwright';

let browserPromise = null;

/**
 * Get or create a singleton browser instance.
 */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

/**
 * Close the singleton browser instance.
 */
export async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

/**
 * Fetch schedule from ESPN using Playwright.
 */
export async function fetchScheduleFromESPN(leagueSlug, teamSlug) {
  const url = `https://www.espn.com/${leagueSlug}/team/schedule/_/name/${teamSlug}`;
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // Wait for the main schedule container or table
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForSelector('.Table__TR, .Table__TD', { timeout: 10000 });
    } catch (e) {
      console.warn(`  Timeout waiting for Table__TR on ${teamSlug}, proceeding with content analysis.`);
    }

    const html = await page.content();
    const results = [];

    // 1. Attempt to find data in scripts (FITT data) - broad search
    const teamScheduleIdx = html.indexOf('"teamSchedule":');
    if (teamScheduleIdx !== -1) {
      try {
        let bracketCount = 0;
        let endIdx = -1;
        const startIdx = teamScheduleIdx + '"teamSchedule":'.length;
        for (let i = startIdx; i < html.length; i++) {
          if (html[i] === '[') bracketCount++;
          else if (html[i] === ']') bracketCount--;
          if (bracketCount === 0) {
            endIdx = i + 1;
            break;
          }
        }

        if (endIdx !== -1) {
          const teamScheduleStr = html.substring(startIdx, endIdx);
          const teamSchedule = JSON.parse(teamScheduleStr);
          if (Array.isArray(teamSchedule)) {
            teamSchedule.forEach(section => {
              const gameSections = [section.events?.post, section.events?.pre, section.events?.upcoming].filter(Boolean);
              gameSections.forEach(groups => {
                 groups.forEach(groupObj => {
                  (groupObj.group || []).forEach(event => {
                    results.push({
                      date: event.date?.date,
                      time: event.time?.time,
                      name: `${event.opponent?.homeAwaySymbol === '@' ? 'at' : 'vs'} ${event.opponent?.displayName}`,
                      homeTeam: event.opponent?.homeAwaySymbol === '@' ? event.opponent?.displayName : teamSlug,
                      awayTeam: event.opponent?.homeAwaySymbol === '@' ? teamSlug : event.opponent?.displayName,
                      venue: event.venue?.fullName || null,
                      league: null
                    });
                  });
                });
              });
            });
          }
        }
      } catch (e) {
        console.warn(`  JSON parse failed for teamSchedule on ${teamSlug}:`, e.message);
      }
    }

    if (results.length > 0) {
      await page.close();
      return results;
    }

    // 2. Fallback: DOM scraping via evaluate
    const domResults = await page.evaluate((teamSlug) => {
      const rows = Array.from(document.querySelectorAll('tr'));
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 3) return null;

        const dateText = cells[0]?.innerText.trim();
        if (!dateText || dateText.toLowerCase() === 'date' || !dateText.includes(',')) return null;

        const opponentText = cells[1]?.innerText.trim().replace(/\n/g, ' ');
        const timeOrResult = cells[2]?.innerText.trim();

        let time = null;
        if (timeOrResult.includes('AM') || timeOrResult.includes('PM') || /^\d{1,2}:\d{2}$/.test(timeOrResult)) {
          time = timeOrResult;
        }

        const isAway = opponentText.includes('@');
        const opponentName = opponentText.replace(/^vs\s+|@\s+/, '').trim();

        return {
          date: dateText,
          time: time,
          name: isAway ? `at ${opponentName}` : `vs ${opponentName}`,
          homeTeam: isAway ? opponentName : teamSlug,
          awayTeam: isAway ? teamSlug : opponentName,
          venue: null,
          league: null
        };
      }).filter(Boolean);
    }, teamSlug);

    await page.close();
    return domResults;
  } catch (error) {
    console.error(`Error scraping ESPN for ${teamSlug}:`, error.message);
    if (page) await page.close();
    return [];
  }
}

export async function fetchScheduleFromWebsite(websiteUrl) {
  const url = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    const games = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const text = table.innerText.toLowerCase();
        if (text.includes('schedule') || text.includes('opponent') || text.includes('game')) {
          const rows = Array.from(table.querySelectorAll('tr'));
          const data = rows.map(row => {
            const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.innerText.trim());
            if (cells.length >= 2) return cells;
            return null;
          }).filter(Boolean);

          if (data.length > 5) {
             return data.map(row => ({
               date: row[0],
               name: row[1],
               time: row.find(c => c && c.includes(':')),
               source: 'generic-table'
             }));
          }
        }
      }
      return [];
    });

    await page.close();
    return games;
  } catch (error) {
    console.error(`Error scraping website ${websiteUrl}:`, error.message);
    if (page) await page.close();
    return [];
  }
}
