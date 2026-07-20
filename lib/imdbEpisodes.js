import { getBrowser } from './scraper.js';

export function parseImdbDate(dateStr) {
  if (!dateStr) return null;
  // Clean up prefix text and remove trailing dots or punctuation
  const trimmed = dateStr.trim().replace(/^(Airs|Aired|Airing)\s+/i, '').replace(/\./g, '');
  if (!trimmed) return null;

  // 1. Handle ISO or YYYY-MM-DD prefix directly (extremely safe & timezone-independent)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // 2. Handle English localized dates (e.g. "January 22, 2024" or "Jan 22, 2024" or "22 Jan 2024")
  const months = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sep: 9, sept: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12
  };

  // Match: Day Month Year (e.g., "22 Jan 2024" or "22 January 2024")
  const localizedMatchAlt = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (localizedMatchAlt) {
    const day = Number(localizedMatchAlt[1]);
    const monthName = localizedMatchAlt[2].toLowerCase();
    const year = Number(localizedMatchAlt[3]);
    const month = months[monthName];
    if (month && day >= 1 && day <= 31 && year >= 1000) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Match: Month Day, Year (e.g., "January 22, 2024" or "Jan 22, 2024")
  const localizedMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (localizedMatch) {
    const monthName = localizedMatch[1].toLowerCase();
    const day = Number(localizedMatch[2]);
    const year = Number(localizedMatch[3]);
    const month = months[monthName];
    if (month && day >= 1 && day <= 31 && year >= 1000) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 3. Fallback to general Date.parse if none of the above matched
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const parsedDate = new Date(parsed);
    const year = parsedDate.getUTCFullYear();
    const month = parsedDate.getUTCMonth() + 1;
    const day = parsedDate.getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  return null;
}

export function deduplicateEpisodes(episodes) {
  const map = new Map();
  for (const episode of episodes) {
    const key = `${episode.season}-${episode.number}`;
    if (!map.has(key)) {
      map.set(key, episode);
    } else {
      const existing = map.get(key);
      map.set(key, {
        season: episode.season,
        number: episode.number,
        name: existing.name || episode.name,
        airdate: existing.airdate || episode.airdate,
        summary: existing.summary || episode.summary,
        url: existing.url || episode.url
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.number - b.number);
}

export function parseImdbEpisodesFromHtml(html, seasonNumber) {
  const episodes = [];

  // 1. Try to find JSON-LD
  const jsonLdRegex = /<script\b[^>]*\btype=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const foundEpisodes = [];

      function traverse(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          obj.forEach(traverse);
          return;
        }
        if (obj['@type'] === 'TVEpisode' || obj.type === 'TVEpisode') {
          foundEpisodes.push(obj);
        }
        for (const key in obj) {
          traverse(obj[key]);
        }
      }

      traverse(data);

      for (const episode of foundEpisodes) {
        const parsedNum = parseInt(episode.episodeNumber, 10);
        const num = Number.isNaN(parsedNum) ? null : parsedNum;
        const name = episode.name || null;
        const airdate = parseImdbDate(episode.datePublished || episode.startDate);
        const summary = episode.description || null;
        const url = episode.url ? (episode.url.startsWith('http') ? episode.url : `https://www.imdb.com${episode.url}`) : null;

        if (num !== null) {
          episodes.push({
            season: Number(seasonNumber),
            number: num,
            name: name || `Episode ${num}`,
            airdate,
            summary,
            url
          });
        }
      }
    } catch (error) {
      // ignore JSON parse errors
    }
  }

  return deduplicateEpisodes(episodes);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchImdbEpisodes(imdbId, seasonNumber) {
  if (!imdbId) return [];

  // Implement short rate-limiting delay
  await sleep(300);

  const url = `https://www.imdb.com/title/${imdbId}/episodes/?season=${seasonNumber}`;
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (gotoError) {
      console.warn(`  IMDb season navigation warning for ${imdbId}:`, gotoError.message);
    }

    // Wait for content to render via a concrete selector or short fallback
    try {
      await page.waitForSelector('[data-testid="episode-item-wrapper"], .episode-item-wrapper, .list_item, .info, script[type="application/ld+json"]', { timeout: 3000 });
    } catch (waitError) {
      try {
        await page.waitForTimeout(1000);
      } catch (timeoutErr) {}
    }

    const html = await page.content();

    // 1. Parse JSON-LD first
    let episodes = parseImdbEpisodesFromHtml(html, seasonNumber);

    // Fill missing URLs with the canonical URL pattern
    episodes.forEach(episode => {
      if (!episode.url && imdbId) {
        episode.url = `https://www.imdb.com/title/${imdbId}/episodes/?season=${seasonNumber}`;
      }
    });

    if (episodes.length > 0 && episodes.every((episode) => episode.airdate)) {
      return episodes;
    }

    // 2. DOM Evaluation fallback
    try {
      const domEpisodes = await page.evaluate((sNum) => {
        const results = [];
        const items = Array.from(document.querySelectorAll(
          '[data-testid="episode-item-wrapper"], .episode-item-wrapper, .list_item, .info, article'
        ));

        items.forEach(item => {
          const titleEl = item.querySelector('[data-testid="episode-item-title"], h4, h3, strong a, a[href*="/title/tt"]');
          const name = titleEl ? titleEl.innerText.trim() : null;

          const numEl = item.querySelector('[data-testid="episode-item-number"], .image div, span');
          let number = null;
          if (numEl) {
            const numMatch = numEl.innerText.match(/Ep\s*(\d+)/i) || numEl.innerText.match(/Episode\s*(\d+)/i) || numEl.innerText.match(/S\d+,\s*Ep\s*(\d+)/i);
            if (numMatch) number = Number(numMatch[1]);
          }

          if (number === null && name) {
            const epMatch = name.match(/(?:Episode|Ep\.|Ep)\s*(\d+)/i);
            if (epMatch) number = Number(epMatch[1]);
          }
          if (number === null) {
            const text = item.innerText || '';
            const epMatch = text.match(/(?:Episode|Ep\.|Ep)\s*(\d+)/i);
            if (epMatch) number = Number(epMatch[1]);
          }

          const airEl = item.querySelector('[data-testid="episode-item-air-date"], .airdate, [class*="air-date"]');
          const airdateStr = airEl ? airEl.innerText.trim() : null;

          const synopsisEl = item.querySelector('[data-testid="episode-item-description"], .item_description, p');
          const summary = synopsisEl ? synopsisEl.innerText.trim() : null;

          let href = null;
          if (titleEl) {
            href = titleEl.getAttribute('href');
          }
          if (!href) {
            const linkEl = item.querySelector('a[href*="/title/tt"]');
            href = linkEl ? linkEl.getAttribute('href') : null;
          }
          const url = href ? (href.startsWith('http') ? href : 'https://www.imdb.com' + href) : null;

          if (number !== null) {
            results.push({
              season: Number(sNum),
              number,
              name: name || `Episode ${number}`,
              airdateStr,
              summary,
              url
            });
          }
        });

        return results;
      }, seasonNumber);

      const parsedDomEpisodes = domEpisodes.map(episode => {
        return {
          season: episode.season,
          number: episode.number,
          name: episode.name,
          airdate: parseImdbDate(episode.airdateStr),
          summary: episode.summary,
          url: episode.url
        };
      });

      episodes = deduplicateEpisodes([...episodes, ...parsedDomEpisodes]);
    } catch (evalError) {
      console.warn('  DOM evaluation failed for IMDb season:', evalError.message);
    }

    return episodes;
  } catch (error) {
    console.error(`Error fetching IMDb episodes for ${imdbId}:`, error.message);
    return [];
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (err) {}
    }
  }
}
