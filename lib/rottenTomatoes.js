import { getBrowser } from './scraper.js';

export function parseRtDate(dateStr) {
  if (!dateStr) return null;
  let trimmed = dateStr.trim().replace(/^(Airs|Aired|Airing)\s+/i, '');
  if (!trimmed) return null;

  // 1. Handle ISO or YYYY-MM-DD prefix directly (extremely safe & timezone-independent)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // 2. Handle English localized dates explicitly (e.g. "January 22, 2024" or "Jan 22, 2024")
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

  // Match: Month Day, Year (e.g., "January 22, 2024" or "Jan 22 2024")
  const localizedMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (localizedMatch) {
    const monthName = localizedMatch[1].toLowerCase();
    const day = parseInt(localizedMatch[2], 10);
    const year = parseInt(localizedMatch[3], 10);
    const month = months[monthName];
    if (month && day >= 1 && day <= 31 && year >= 1000) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Match: Day Month Year (e.g., "22 Jan 2024")
  const localizedMatchAlt = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (localizedMatchAlt) {
    const day = parseInt(localizedMatchAlt[1], 10);
    const monthName = localizedMatchAlt[2].toLowerCase();
    const year = parseInt(localizedMatchAlt[3], 10);
    const month = months[monthName];
    if (month && day >= 1 && day <= 31 && year >= 1000) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Match: Month Day (e.g., "July 20" or "Jul 20") - assume current year
  const localizedMonthDay = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (localizedMonthDay) {
    const monthName = localizedMonthDay[1].toLowerCase();
    const day = parseInt(localizedMonthDay[2], 10);
    const month = months[monthName];
    if (month && day >= 1 && day <= 31) {
      const year = new Date().getFullYear();
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Match: Day Month (e.g., "20 Jul") - assume current year
  const localizedDayMonth = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)$/);
  if (localizedDayMonth) {
    const day = parseInt(localizedDayMonth[1], 10);
    const monthName = localizedDayMonth[2].toLowerCase();
    const month = months[monthName];
    if (month && day >= 1 && day <= 31) {
      const year = new Date().getFullYear();
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 3. Fallback to general Date.parse if none of the above matched
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const hasZone = /Z|GMT|UTC|[-+]\d{2}/i.test(trimmed);
    const d = new Date(parsed);
    if (hasZone) {
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    } else {
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

function deduplicateEpisodes(episodes) {
  const map = new Map();
  for (const ep of episodes) {
    const key = `${ep.season}-${ep.number}`;
    if (!map.has(key)) {
      map.set(key, ep);
    } else {
      const existing = map.get(key);
      map.set(key, {
        season: ep.season,
        number: ep.number,
        name: ep.name || existing.name,
        airdate: ep.airdate || existing.airdate,
        summary: ep.summary || existing.summary,
        url: ep.url || existing.url
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.number - b.number);
}

export async function searchRtShow(query, fetchImpl = globalThis.fetch) {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) return null;

  const searchUrl = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(trimmed)}`;
  try {
    const response = await fetchImpl(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) return null;

    const text = await response.text();
    const regex = /<search-page-media-row\b([^>]*)>([\s\S]*?)<\/search-page-media-row>/gi;
    let match;
    const shows = [];

    while ((match = regex.exec(text)) !== null) {
      const attrStr = match[1];
      const innerHtml = match[2];

      // Parse attributes of the element
      const attrs = {};
      const attrRegex = /(\b[a-zA-Z0-9_-]+)\s*=\s*\"([^\"]*)\"/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
        attrs[attrMatch[1].toLowerCase()] = attrMatch[2];
      }

      // Parse first href inside the element
      const hrefMatch = innerHtml.match(/href=\"([^\"]*)\"/i);
      const href = hrefMatch ? hrefMatch[1] : null;

      // Only interested in TV shows
      if (!href || !href.includes('/tv/')) {
        continue;
      }

      // Get title from slot="title" link or fallback to alt
      let title = null;
      const titleSlotMatch = innerHtml.match(/slot=\"title\"[^>]*>\s*([\s\S]*?)\s*<\/a>/i);
      if (titleSlotMatch) {
        title = titleSlotMatch[1].replace(/<[^>]*>/g, '').trim();
      }
      if (!title) {
        const altMatch = innerHtml.match(/alt=\"([^\"]*)\"/i);
        title = altMatch ? altMatch[1].trim() : null;
      }

      if (title) {
        title = title
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"');
      }

      const startYear = attrs['start-year'] || attrs['startyear'] || null;
      const scoreVal = attrs['tomatometer-score'] || attrs['tomatometerscore'] || '';
      const meterScore = scoreVal ? parseInt(scoreVal, 10) : null;
      const isCertified = attrs['tomatometer-is-certified'] === 'true' || attrs['tomatometeriscertified'] === 'true';

      let meterClass = null;
      if (meterScore !== null) {
        if (isCertified) meterClass = 'certified_fresh';
        else if (meterScore >= 60) meterClass = 'fresh';
        else meterClass = 'rotten';
      }

      let slug = href;
      if (slug.startsWith('https://www.rottentomatoes.com/tv/')) {
        slug = slug.substring('https://www.rottentomatoes.com/tv/'.length);
      } else if (slug.startsWith('/tv/')) {
        slug = slug.substring('/tv/'.length);
      }

      shows.push({
        title,
        slug,
        url: href.startsWith('http') ? href : `https://www.rottentomatoes.com${href}`,
        meterScore,
        meterClass,
        startYear: startYear ? parseInt(startYear, 10) : null
      });
    }

    if (!shows.length) return null;

    // Helper for normalized comparison
    const canonicalize = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const canonicalQuery = canonicalize(trimmed);

    // Find best match (exact or fuzzy), fallback to first TV show result
    const bestMatch = shows.find(s => canonicalize(s.title) === canonicalQuery) || shows[0];
    return bestMatch;
  } catch (error) {
    console.warn('Rotten Tomatoes search failed:', error.message);
    return null;
  }
}

export function parseRtEpisodesFromHtml(html, seasonNumber) {
  const episodes = [];

  // 1. Try to find JSON-LD
  const jsonLdRegex = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
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

      for (const ep of foundEpisodes) {
        const num = parseInt(ep.episodeNumber, 10) || null;
        const name = ep.name || null;
        const airdate = parseRtDate(ep.datePublished || ep.startDate);
        const summary = ep.description || null;
        const url = ep.url ? (ep.url.startsWith('http') ? ep.url : `https://www.rottentomatoes.com${ep.url}`) : null;

        if (num !== null) {
          episodes.push({
            season: parseInt(seasonNumber, 10),
            number: num,
            name: name || `Episode ${num}`,
            airdate,
            summary,
            url
          });
        }
      }
    } catch (e) {
      // ignore JSON parse errors
    }
  }

  return deduplicateEpisodes(episodes);
}

export async function fetchRtEpisodes(slug, seasonNumber, fetchImpl = globalThis.fetch, env = process.env) {
  if (!slug) return [];

  const url = `https://www.rottentomatoes.com/tv/${slug}/s${String(seasonNumber).padStart(2, '0')}`;
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (gotoError) {
      console.warn(`  RT season navigation warning for ${slug}:`, gotoError.message);
    }

    // Wait for content to render via a concrete selector or short fallback
    try {
      await page.waitForSelector('[data-qa="episode-item"], .episode-list__item, .episode-row, script[type="application/ld+json"]', { timeout: 3000 });
    } catch (waitError) {
      try {
        await page.waitForTimeout(1000);
      } catch (timeoutErr) {}
    }

    const html = await page.content();

    // 1. Parse JSON-LD first
    let episodes = parseRtEpisodesFromHtml(html, seasonNumber);

    // 2. DOM Evaluation fallback
    try {
      const domEpisodes = await page.evaluate((sNum) => {
        const results = [];
        const items = Array.from(document.querySelectorAll(
          '[data-qa="episode-item"], .episode-list__item, [class*="episode-list__item"], [class*="EpisodeList"] li, .episode-row, tile-episode, [data-qa="episode-tile"]'
        ));

        items.forEach(item => {
          const titleEl = item.querySelector('[data-qa="episode-title"], [slot="title"], [class*="episode-title"], .episode-title, h4, h3');
          const name = titleEl ? titleEl.innerText.trim() : null;

          const numEl = item.querySelector('[data-qa="episode-number"], [data-qa="episode-label"], [slot="episode"], [class*="episode-number"], .episode-number');
          let number = null;
          if (numEl) {
            const numMatch = numEl.innerText.match(/\d+/);
            if (numMatch) number = parseInt(numMatch[0], 10);
          }

          if (number === null && name) {
            const epMatch = name.match(/(?:Episode|Ep\.|Ep)\s*(\d+)/i);
            if (epMatch) number = parseInt(epMatch[1], 10);
          }
          if (number === null) {
            const text = item.innerText || '';
            const epMatch = text.match(/(?:Episode|Ep\.|Ep)\s*(\d+)/i);
            if (epMatch) number = parseInt(epMatch[1], 10);
          }

          const airEl = item.querySelector('[data-qa="episode-air-date"], [slot="air-date"], [class*="episode-air-date"], .episode-air-date, .air-date, [class*="air-date"]');
          const airdateStr = airEl ? airEl.innerText.trim() : null;

          const synopsisEl = item.querySelector('[data-qa="episode-description"], [data-qa="episode-synopsis"], [slot="description"], [class*="episode-synopsis"], .synopsis, p');
          const summary = synopsisEl ? synopsisEl.innerText.trim() : null;

          let href = item.getAttribute('href');
          if (!href) {
            const linkEl = item.querySelector('a[href*="/tv/"]');
            href = linkEl ? linkEl.getAttribute('href') : null;
          }
          const url = href ? (href.startsWith('http') ? href : 'https://www.rottentomatoes.com' + href) : null;

          if (number !== null) {
            results.push({
              season: parseInt(sNum, 10),
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

      const parsedDomEpisodes = domEpisodes.map(ep => {
        return {
          season: ep.season,
          number: ep.number,
          name: ep.name,
          airdate: parseRtDate(ep.airdateStr),
          summary: ep.summary,
          url: ep.url
        };
      });

      episodes = mergeAndDeduplicate([...episodes, ...parsedDomEpisodes]);
    } catch (evalError) {
      console.warn('  DOM evaluation failed for RT season:', evalError.message);
    }

    await page.close();
    return episodes;
  } catch (error) {
    console.error(`Error fetching Rotten Tomatoes episodes for ${slug}:`, error.message);
    if (page) await page.close();
    return [];
  }
}

function mergeAndDeduplicate(episodes) {
  return deduplicateEpisodes(episodes);
}
