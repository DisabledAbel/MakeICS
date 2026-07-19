import { getBrowser } from './scraper.js';

function getRolledYear(month, day) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const tentative = new Date(currentYear, month - 1, day);
  const diffTime = now.getTime() - tentative.getTime();
  const diffDays = diffTime / (1000 * 60 * 60 * 24);
  if (diffDays > 30) {
    return currentYear + 1;
  }
  return currentYear;
}

export function parseRtDate(dateStr) {
  if (!dateStr) return null;
  const trimmed = dateStr.trim().replace(/^(Airs|Aired|Airing)\s+/i, '');
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
    const day = Number(localizedMatch[2]);
    const year = Number(localizedMatch[3]);
    const month = months[monthName];
    if (month && day >= 1 && day <= 31 && year >= 1000) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Match: Day Month Year (e.g., "22 Jan 2024")
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

  // Match: Month Day (e.g., "July 20" or "Jul 20") - assume current year with rollover
  const localizedMonthDay = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (localizedMonthDay) {
    const monthName = localizedMonthDay[1].toLowerCase();
    const day = Number(localizedMonthDay[2]);
    const month = months[monthName];
    if (month && day >= 1 && day <= 31) {
      const year = getRolledYear(month, day);
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Match: Day Month (e.g., "20 Jul") - assume current year with rollover
  const localizedDayMonth = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)$/);
  if (localizedDayMonth) {
    const day = Number(localizedDayMonth[1]);
    const monthName = localizedDayMonth[2].toLowerCase();
    const month = months[monthName];
    if (month && day >= 1 && day <= 31) {
      const year = getRolledYear(month, day);
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 3. Fallback to general Date.parse if none of the above matched
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const hasZone = /Z|GMT|UTC|[-+]\d{2}/i.test(trimmed);
    const parsedDate = new Date(parsed);
    if (hasZone) {
      const year = parsedDate.getUTCFullYear();
      const month = parsedDate.getUTCMonth() + 1;
      const day = parsedDate.getUTCDate();
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    } else {
      const year = parsedDate.getFullYear();
      const month = parsedDate.getMonth() + 1;
      const day = parsedDate.getDate();
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

function deduplicateEpisodes(episodes) {
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
      const meterScore = scoreVal ? Number(scoreVal) : null;
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
        startYear: startYear ? Number(startYear) : null
      });
    }

    if (!shows.length) return null;

    // Helper for normalized comparison
    const canonicalize = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const canonicalQuery = canonicalize(trimmed);

    // 1. Try exact match first
    let bestMatch = shows.find(show => canonicalize(show.title) === canonicalQuery);

    // 2. If no exact match, look for a qualified fuzzy match
    if (!bestMatch) {
      // Find matches where one title contains the other (canonicalized substring containment)
      const substringMatches = shows.filter(show => {
        const canonicalShowTitle = canonicalize(show.title);
        return canonicalShowTitle.includes(canonicalQuery) || canonicalQuery.includes(canonicalShowTitle);
      });

      if (substringMatches.length > 0) {
        // If there is a year present in the query, check for agreement with startYear
        const queryYearMatch = trimmed.match(/\b(19|20)\d{2}\b/);
        const queryYear = queryYearMatch ? Number(queryYearMatch[0]) : null;

        if (queryYear) {
          const matchingYearShow = substringMatches.find(show => show.startYear === queryYear);
          if (matchingYearShow) {
            bestMatch = matchingYearShow;
          }
        }

        // Default to first substring match if no year agreement match (or query has no year)
        if (!bestMatch) {
          bestMatch = substringMatches[0];
        }
      }
    }

    return bestMatch || null;
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

      for (const episode of foundEpisodes) {
        const parsedNum = parseInt(episode.episodeNumber, 10);
        const num = Number.isNaN(parsedNum) ? null : parsedNum;
        const name = episode.name || null;
        const airdate = parseRtDate(episode.datePublished || episode.startDate);
        const summary = episode.description || null;
        const url = episode.url ? (episode.url.startsWith('http') ? episode.url : `https://www.rottentomatoes.com${episode.url}`) : null;

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

export async function fetchRtEpisodes(slug, seasonNumber, fetchImpl = globalThis.fetch, env = process.env) {
  if (!slug) return [];

  // Implement short rate-limiting delay before scraping live page
  await sleep(300);

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

    // Fill missing URLs with the canonical URL pattern
    episodes.forEach(episode => {
      if (!episode.url && slug) {
        episode.url = `https://www.rottentomatoes.com/tv/${slug}/s${String(seasonNumber).padStart(2, '0')}/e${String(episode.number).padStart(2, '0')}`;
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
          '[data-qa="episode-item"], .episode-list__item, [class*="episode-list__item"], [class*="EpisodeList"] li, .episode-row, tile-episode, [data-qa="episode-tile"]'
        ));

        items.forEach(item => {
          const titleEl = item.querySelector('[data-qa="episode-title"], [slot="title"], [class*="episode-title"], .episode-title');
          const name = titleEl ? titleEl.innerText.trim() : null;

          const numEl = item.querySelector('[data-qa="episode-number"], [data-qa="episode-label"], [slot="episode"], [class*="episode-number"], .episode-number');
          let number = null;
          if (numEl) {
            const numMatch = numEl.innerText.match(/\d+/);
            if (numMatch) number = Number(numMatch[0]);
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

          const airEl = item.querySelector('[data-qa="episode-air-date"], [slot="air-date"], [class*="episode-air-date"], .episode-air-date, .air-date, [class*="air-date"]');
          const airdateStr = airEl ? airEl.innerText.trim() : null;

          const synopsisEl = item.querySelector('[data-qa="episode-description"], [data-qa="episode-synopsis"], [slot="description"], [class*="episode-synopsis"], .synopsis');
          const summary = synopsisEl ? synopsisEl.innerText.trim() : null;

          let href = item.getAttribute('href');
          if (!href) {
            const linkEl = item.querySelector('a[href*="/tv/"]');
            href = linkEl ? linkEl.getAttribute('href') : null;
          }
          const url = href ? (href.startsWith('http') ? href : 'https://www.rottentomatoes.com' + href) : null;

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
          airdate: parseRtDate(episode.airdateStr),
          summary: episode.summary,
          url: episode.url
        };
      });

      episodes = mergeAndDeduplicate([...episodes, ...parsedDomEpisodes]);
    } catch (evalError) {
      console.warn('  DOM evaluation failed for RT season:', evalError.message);
    }

    return episodes;
  } catch (error) {
    console.error(`Error fetching Rotten Tomatoes episodes for ${slug}:`, error.message);
    return [];
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (err) {}
    }
  }
}

function mergeAndDeduplicate(episodes) {
  return deduplicateEpisodes(episodes);
}
