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

    // Modification: Using resilient 'domcontentloaded' with a try-catch for better reliability
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (gotoError) {
      console.warn(`  Initial navigation failed for ${teamSlug}, attempting fallback:`, gotoError.message);
      // Fallback navigation if needed
    }

    // Wait for content to render
    await page.waitForTimeout(5000);

    const html = await page.content();
    const results = [];

    // 1. Attempt to find data in scripts (FITT data)
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

          // Fix: Extract team display name from JSON context if possible
          let teamDisplayName = teamSlug;
          const teamNameIdx = html.indexOf('"team":{');
          if (teamNameIdx !== -1) {
            try {
              let tBracketCount = 0;
              let tEndIdx = -1;
              const tStartIdx = teamNameIdx + '"team":'.length;
              for (let i = tStartIdx; i < html.length; i++) {
                if (html[i] === '{') tBracketCount++;
                else if (html[i] === '}') tBracketCount--;
                if (tBracketCount === 0) {
                  tEndIdx = i + 1;
                  break;
                }
              }
              if (tEndIdx !== -1) {
                const teamData = JSON.parse(html.substring(tStartIdx, tEndIdx));
                teamDisplayName = teamData.displayName || teamDisplayName;
              }
            } catch (e) {}
          }

          if (Array.isArray(teamSchedule)) {
            teamSchedule.forEach(section => {
              const gameSections = [section.events?.post, section.events?.pre, section.events?.upcoming].filter(Boolean);
              gameSections.forEach(groups => {
                 groups.forEach(groupObj => {
                  (groupObj.group || []).forEach(event => {
                    const isAway = event.opponent?.homeAwaySymbol === '@';
                    const homeTeam = isAway ? event.opponent?.displayName : teamDisplayName;
                    const awayTeam = isAway ? teamDisplayName : event.opponent?.displayName;
                    results.push({
                      date: event.date?.date,
                      time: event.time?.time,
                      name: `${homeTeam} vs ${awayTeam}`,
                      homeTeam,
                      awayTeam,
                      venue: event.venue?.fullName || null,
                      broadcast: event.broadcasts?.[0]?.name || null,
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
      // Fix: Extract team display name from headline
      const headline = document.querySelector('.headline')?.innerText || '';
      const teamDisplayName = headline.replace(/\s+Schedule\s+\d{4}-\d{2}$/i, '').trim() || teamSlug;

      const rows = Array.from(document.querySelectorAll('tr'));
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 3) return null;

        const dateText = cells[0]?.innerText.trim();
        if (!dateText || dateText.toLowerCase() === 'date' || !dateText.includes(',')) return null;

        const opponentText = cells[1]?.innerText.trim().replace(/\n/g, ' ');
        const timeOrResult = cells[2]?.innerText.trim();

        // Fix: Use more specific regex for time formats (HH:MM or HH:MM AM/PM)
        const timeRegex = /^(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:AM|PM)?$/i;
        let time = null;
        if (timeRegex.test(timeOrResult)) {
          time = timeOrResult;
        }

        const isAway = opponentText.includes('@');
        // Fix: Pattern grouping so anchor applies to both
        const opponentName = opponentText.replace(/^(?:vs\s+|@\s+)/i, '').trim();

        const homeTeam = isAway ? opponentName : teamDisplayName;
        const awayTeam = isAway ? teamDisplayName : opponentName;
        const broadcast = cells[3]?.innerText.trim() || null;

        return {
          date: dateText,
          time: time,
          name: `${homeTeam} vs ${awayTeam}`,
          homeTeam,
          awayTeam,
          venue: null,
          broadcast: broadcast,
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

/**
 * Fetch IMDb release calendar using Playwright.
 */
export async function fetchIMDbReleaseCalendar() {
  const url = 'https://www.imdb.com/calendar/?region=US';
  let context, page;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#__NEXT_DATA__', { state: 'attached', timeout: 10000 });

    const data = await page.evaluate(() => {
      const script = document.querySelector('script[type="application/json"][id="__NEXT_DATA__"]');
      if (!script) return null;
      try {
        const parsed = JSON.parse(script.textContent);
        const groups = parsed.props?.pageProps?.groups || [];
        return groups.flatMap(group => {
          const date = group.group;
          return (group.entries || []).map(entry => ({
            id: entry.id,
            title: entry.titleText,
            image: entry.imageModel?.url,
            releaseDate: entry.releaseDate,
            genres: entry.genres || [],
            people: (entry.principalCredits || []).flatMap(pc => {
              if (Array.isArray(pc.credits)) {
                return pc.credits.map(c => c.text);
              }
              return [pc.text];
            }).filter(Boolean),
            label: date
          })).filter(e => e.title && e.id);
        });
      } catch (e) {
        return null;
      }
    });

    await page.close();
    await context.close();
    return data || [];
  } catch (error) {
    console.error('Error scraping IMDb calendar:', error.message);
    if (page) await page.close();
    if (context) await context.close();
    return [];
  }
}

/**
 * Fetch schedule from WNBA.com using Playwright.
 */
export async function fetchWNBASchedule(url) {
  let page;
  try {
    const browser = await getBrowser();
    // Using a fresh context with specific settings to avoid protocol errors if possible
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 }
    });
    page = await context.newPage();

    console.log(`  Navigating to WNBA: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      console.warn(`  WNBA navigation warning: ${e.message}. Attempting to proceed.`);
    }

    // Give it time to load dynamic content
    await page.waitForTimeout(8000);

    const games = await page.evaluate(() => {
      const results = [];

      // 1. Try to find __NEXT_DATA__
      const nextDataElem = document.getElementById('__NEXT_DATA__');
      if (nextDataElem) {
        try {
          const data = JSON.parse(nextDataElem.textContent);
          // Potential paths in WNBA's Next.js data
          const scheduleData = data.props?.pageProps?.scheduleData || data.props?.pageProps?.data?.schedule;
          if (scheduleData && Array.isArray(scheduleData.games)) {
            scheduleData.games.forEach(g => {
              results.push({
                date: g.gameDateEST || g.date,
                time: g.gameTimeEST || g.time,
                name: `${g.homeTeamName} vs ${g.awayTeamName}`,
                homeTeam: g.homeTeamName,
                awayTeam: g.awayTeamName,
                venue: g.arenaName || null,
                broadcast: g.broadcaster?.broadcasterDisplay || null,
                league: 'WNBA'
              });
            });
          }
        } catch (e) {}
      }

      if (results.length > 0) return results;

      // 2. Fallback: Scrape DOM for common WNBA schedule patterns
      // These classes often change, so we look for generic structures too
      const gameElements = document.querySelectorAll('[class*="ScheduleGame"]');
      gameElements.forEach(el => {
        try {
          const date = el.querySelector('[class*="GameDate"]')?.innerText || '';
          const time = el.querySelector('[class*="GameTime"]')?.innerText || '';
          const broadcast = el.querySelector('[class*="Broadcaster"]')?.innerText || null;
          const teams = Array.from(el.querySelectorAll('[class*="TeamName"]')).map(t => t.innerText);
          if (teams.length >= 2) {
            results.push({
              date,
              time,
              name: `${teams[0]} vs ${teams[1]}`,
              homeTeam: teams[1],
              awayTeam: teams[0],
              venue: null,
              broadcast,
              league: 'WNBA'
            });
          }
        } catch (e) {}
      });

      return results;
    });

    await page.close();
    await context.close();
    return games;
  } catch (error) {
    console.error(`Error scraping WNBA ${url}:`, error.message);
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
    // Modification: More resilient navigation
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    } catch (e) {
      console.warn(`  Navigation to generic site ${websiteUrl} timed out, trying to extract anyway.`);
    }

    const games = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const text = table.innerText.toLowerCase();
        if (text.includes('schedule') || text.includes('opponent') || text.includes('game')) {
          const rows = Array.from(table.querySelectorAll('tr'));
          const data = rows.map(row => {
            // Fix: Skip purely header rows (rows with only th elements)
            if (row.querySelectorAll('td').length === 0) return null;

            const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.innerText.trim());
            if (cells.length >= 2) return cells;
            return null;
          }).filter(Boolean);

          if (data.length > 5) {
             const timeRegex = /^(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:AM|PM)?$/i;
             return data.map(row => {
               const date = row[0];
               const name = row[1];
               const time = row.find(c => c && timeRegex.test(c));
               // Look for typical broadcast indicators in other cells
               const broadcast = row.find((c, i) => i > 1 && (
                 c.toLowerCase().includes('tv') ||
                 c.toLowerCase().includes('espn') ||
                 c.toLowerCase().includes('abc') ||
                 c.toLowerCase().includes('fox') ||
                 c.toLowerCase().includes('cbs') ||
                 c.toLowerCase().includes('nbc') ||
                 c.toLowerCase().includes('prime') ||
                 c.toLowerCase().includes('apple')
               ));

               return {
                 date,
                 name,
                 time,
                 broadcast,
                 source: 'generic-table'
               };
             });
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
