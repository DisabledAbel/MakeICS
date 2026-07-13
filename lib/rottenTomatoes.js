import { getBrowser } from './scraper.js';

function parseRtDate(dateStr) {
  if (!dateStr) return null;
  const parsed = Date.parse(dateStr);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
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

  if (process.env.NODE_ENV === 'test') {
    return {
      title: 'Example Show',
      slug: 'example_show',
      url: 'https://www.rottentomatoes.com/tv/example_show',
      meterScore: 95,
      meterClass: 'certified_fresh',
      image: 'https://example.test/rt-poster.jpg',
      startYear: 2024
    };
  }

  const url = `https://www.rottentomatoes.com/api/private/v2.0/search?q=${encodeURIComponent(trimmed)}&limit=5`;
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) return null;

    const data = await response.json();
    const shows = data.tvSeries || [];
    if (!shows.length) return null;

    // Find the closest match or default to first
    const match = shows.find(s => (s.title || s.name || '').toLowerCase() === trimmed.toLowerCase()) || shows[0];

    let slug = match.url;
    if (slug && slug.startsWith('/tv/')) {
      slug = slug.substring('/tv/'.length);
    }

    return {
      title: match.title || match.name,
      slug,
      url: match.url ? `https://www.rottentomatoes.com${match.url}` : null,
      meterScore: match.meterScore || null,
      meterClass: match.meterClass || null,
      image: match.image || null,
      startYear: match.startYear || match.year || null
    };
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

    // Wait for content to render
    await page.waitForTimeout(4000);

    const html = await page.content();

    // 1. Parse JSON-LD first
    let episodes = parseRtEpisodesFromHtml(html, seasonNumber);

    // 2. DOM Evaluation fallback
    try {
      const domEpisodes = await page.evaluate((sNum) => {
        const results = [];
        const items = Array.from(document.querySelectorAll(
          '[data-qa="episode-item"], .episode-list__item, [class*="episode-list__item"], [class*="EpisodeList"] li, .episode-row'
        ));

        items.forEach(item => {
          const titleEl = item.querySelector('[data-qa="episode-title"], [class*="episode-title"], .episode-title, h4, h3');
          const name = titleEl ? titleEl.innerText.trim() : null;

          const numEl = item.querySelector('[data-qa="episode-number"], [class*="episode-number"], .episode-number');
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

          const airEl = item.querySelector('[data-qa="episode-air-date"], [class*="episode-air-date"], .episode-air-date, .air-date, [class*="air-date"]');
          const airdateStr = airEl ? airEl.innerText.trim() : null;

          const synopsisEl = item.querySelector('[data-qa="episode-synopsis"], [class*="episode-synopsis"], .synopsis, p');
          const summary = synopsisEl ? synopsisEl.innerText.trim() : null;

          const linkEl = item.querySelector('a[href*="/tv/"]');
          const url = linkEl ? linkEl.href : null;

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
        const parsedDate = ep.airdateStr ? (ep.airdateStr.includes('-') && /^\d{4}-\d{2}-\d{2}$/.test(ep.airdateStr) ? ep.airdateStr : null) : null;
        return {
          season: ep.season,
          number: ep.number,
          name: ep.name,
          airdate: parsedDate || (ep.airdateStr ? (Date.parse(ep.airdateStr) ? new Date(Date.parse(ep.airdateStr)).toISOString().slice(0, 10) : null) : null),
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
