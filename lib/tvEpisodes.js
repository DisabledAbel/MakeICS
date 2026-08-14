import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTimeForTimezone } from './utils/date.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TVMAZE_BASE_URL = 'https://api.tvmaze.com';
const DEFAULT_IMDB_API_URL = 'https://imdb.iamidiotareyoutoo.com/search';
const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';
const FEED_REFRESH_INTERVAL = 'PT24H';
const MAX_SUGGESTIONS = 8;

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function compactText(value) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
}

async function fetchJson(url, fetchImpl) {
  // Validate URL to protect against SSRF and parse cleanly
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (err) {
    throw new Error(`Invalid request URL: ${url}`);
  }

  // Restrict fetch requests to trusted external API/data origins
  const trustedHosts = [
    'api.tvmaze.com',
    'imdb.iamidiotareyoutoo.com',
    'v3.sg.media-imdb.com',
    'api.firecrawl.dev'
  ];

  const host = parsedUrl.hostname.toLowerCase();
  const isAllowed = trustedHosts.includes(host) ||
                    host.endsWith('.imdb.com') ||
                    host.endsWith('.test') ||
                    host === 'localhost' ||
                    host === '127.0.0.1';

  if (!isAllowed) {
    throw new Error(`SSRF Prevention: Fetch request to untrusted host ${parsedUrl.hostname} is blocked.`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MakeICS-TV-Episodes/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) for ${url}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeShowSuggestion(result) {
  const show = result.show || result;
  return {
    id: show.id,
    name: show.name,
    status: show.status || null,
    premiered: show.premiered || null,
    ended: show.ended || null,
    network: show.network?.name || show.webChannel?.name || null,
    country: show.network?.country?.name || show.webChannel?.country?.name || null,
    image: show.image?.medium || show.image?.original || null,
    tvmazeUrl: show.url || null,
    summary: compactText(show.summary),
    score: result.score ?? null
  };
}

export async function searchShowSuggestions({ query, fetchImpl = globalThis.fetch } = {}) {
  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  if (trimmedQuery.length < 2) {
    return [];
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required. Use Node 18+ or provide fetchImpl.');
  }

  const url = `${TVMAZE_BASE_URL}/search/shows?q=${encodeURIComponent(trimmedQuery)}`;
  const results = await fetchJson(url, fetchImpl);
  return results.slice(0, MAX_SUGGESTIONS).map(normalizeShowSuggestion);
}

async function searchShow(query, fetchImpl) {
  const url = `${TVMAZE_BASE_URL}/singlesearch/shows?q=${encodeURIComponent(query)}&embed=nextepisode`;
  return fetchJson(url, fetchImpl);
}

async function fetchShowEpisodes(showId, fetchImpl) {
  const url = `${TVMAZE_BASE_URL}/shows/${encodeURIComponent(showId)}/episodes?specials=0`;
  return fetchJson(url, fetchImpl);
}

function getEpisodeTimestamp(episode) {
  const candidate = episode.airstamp || (episode.airdate ? `${episode.airdate}T${episode.airtime || '00:00'}:00Z` : '');
  const timestamp = Date.parse(candidate);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function normalizeEpisode(episode, show) {
  return {
    id: episode.id,
    name: episode.name || 'Untitled episode',
    season: episode.season || null,
    number: episode.number || null,
    type: episode.type || null,
    airdate: episode.airdate || null,
    airtime: episode.airtime || null,
    airstamp: episode.airstamp || null,
    runtime: episode.runtime || show.runtime || null,
    summary: compactText(episode.summary),
    url: episode.url || null,
    showName: show.name,
    showId: show.id,
    network: show.network?.name || show.webChannel?.name || null,
    country: show.network?.country?.name || show.webChannel?.country?.name || null
  };
}

function normalizeEpisodes(episodes, show) {
  return episodes
    .sort((left, right) => getEpisodeTimestamp(left) - getEpisodeTimestamp(right))
    .map((episode) => normalizeEpisode(episode, show));
}

function imdbEndpointFromEnv(env, imdbId) {
  if (!imdbId) {
    return null;
  }

  const endpoint = env.IMDB_API_URL || DEFAULT_IMDB_API_URL;
  const separator = endpoint.includes('?') ? '&' : '?';

  if (endpoint.includes('{imdbId}')) {
    return endpoint.replaceAll('{imdbId}', encodeURIComponent(imdbId));
  }

  return `${endpoint}${separator}tt=${encodeURIComponent(imdbId)}`;
}

function valueFromPaths(payload, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], payload);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function normalizeImdbApiPayload(payload, imdbId, source, fallbackWarning = null) {
  const record = Array.isArray(payload) ? payload[0] : payload?.short || payload?.top || payload?.data || payload;

  if (!record || typeof record !== 'object') {
    return {
      id: imdbId,
      url: `https://www.imdb.com/title/${imdbId}/`,
      source,
      sourceConfigured: true,
      warning: fallbackWarning || 'IMDb endpoint returned an unexpected response shape.'
    };
  }

  return {
    id: imdbId,
    title: valueFromPaths(record, ['title', 'Title', 'name', 'originalTitleText.text', 'titleText.text']) || null,
    year: valueFromPaths(record, ['year', 'Year', 'datePublished', 'releaseYear.year']) || null,
    rating: valueFromPaths(record, ['imDbRating', 'imdbRating', 'rating', 'aggregateRating.ratingValue', 'ratingsSummary.aggregateRating']) || null,
    plot: valueFromPaths(record, ['plot', 'Plot', 'description', 'summary.text']) || null,
    url: `https://www.imdb.com/title/${imdbId}/`,
    source,
    sourceConfigured: true,
    warning: fallbackWarning
  };
}

function firecrawlTitleFromMarkdown(markdown) {
  if (!markdown) {
    return null;
  }

  const heading = markdown.match(/^#\s+(.+)$/m)?.[1];
  if (heading) {
    return heading.replace(/\s*-\s*IMDb\s*$/i, '').trim();
  }

  return markdown.match(/Title:\s*(.+)$/im)?.[1]?.trim() || null;
}

function firecrawlRatingFromMarkdown(markdown) {
  if (!markdown) {
    return null;
  }

  return markdown.match(/(\d(?:\.\d)?)(?:\s*\/\s*10|\s+out of\s+10)/i)?.[1] || null;
}

function normalizeFirecrawlPayload(payload, imdbId) {
  const markdown = payload?.data?.markdown || payload?.markdown || '';
  const metadata = payload?.data?.metadata || payload?.metadata || {};

  return {
    id: imdbId,
    title: metadata.title?.replace(/\s*-\s*IMDb\s*$/i, '').trim() || firecrawlTitleFromMarkdown(markdown),
    year: metadata.publishedTime?.slice(0, 4) || markdown.match(/\b(19|20)\d{2}\b/)?.[0] || null,
    rating: firecrawlRatingFromMarkdown(markdown),
    plot: metadata.description || markdown.match(/(?:Plot|Storyline|Description):\s*(.+)$/im)?.[1]?.trim() || null,
    url: `https://www.imdb.com/title/${imdbId}/`,
    source: 'firecrawl',
    sourceConfigured: true
  };
}

async function fetchFirecrawlImdbDetails(imdbId, env, fetchImpl) {
  if (!env.FIRECRAWL_API_KEY || !imdbId) {
    return null;
  }

  // Validate that imdbId strictly matches IMDb title format
  if (!/^tt\d+$/.test(imdbId)) {
    throw new Error(`Invalid IMDb ID: ${imdbId}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetchImpl(env.FIRECRAWL_API_URL || FIRECRAWL_SCRAPE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'MakeICS-TV-Episodes/1.0'
      },
      body: JSON.stringify({
        url: `https://www.imdb.com/title/${encodeURIComponent(imdbId)}/`,
        formats: ['markdown'],
        onlyMainContent: true,
        maxAge: 86_400_000
      })
    });

    if (!response.ok) {
      throw new Error(`Firecrawl returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    return normalizeFirecrawlPayload(payload, imdbId);
  } finally {
    clearTimeout(timeoutId);
  }
}

function unavailablePublicImdbDetails(imdbId, warning) {
  return {
    id: imdbId,
    url: `https://www.imdb.com/title/${imdbId}/`,
    source: 'public-imdb',
    sourceConfigured: false,
    warning
  };
}

async function fetchPublicImdbDetails(imdbId, env, fetchImpl, fallbackWarning = null) {
  const url = imdbEndpointFromEnv(env, imdbId);
  if (!url) {
    return null;
  }

  // Validate url hostname to guard against SSRF
  try {
    const parsedUrl = new URL(url);
    const trustedHosts = [
      'api.tvmaze.com',
      'imdb.iamidiotareyoutoo.com',
      'v3.sg.media-imdb.com',
      'api.firecrawl.dev'
    ];
    const host = parsedUrl.hostname.toLowerCase();
    const isAllowed = trustedHosts.includes(host) ||
                      host.endsWith('.imdb.com') ||
                      host.endsWith('.test') ||
                      host === 'localhost' ||
                      host === '127.0.0.1';
    if (!isAllowed) {
      throw new Error(`SSRF Prevention: Fetch request to untrusted host ${parsedUrl.hostname} is blocked.`);
    }
  } catch (err) {
    return unavailablePublicImdbDetails(imdbId, fallbackWarning || err.message);
  }

  const hasCustomEndpoint = Boolean(env && env.IMDB_API_URL);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MakeICS-TV-Episodes/1.0'
      }
    });

    if (!response.ok) {
      const message = `IMDb endpoint returned HTTP ${response.status}`;
      if (!hasCustomEndpoint) {
        return unavailablePublicImdbDetails(imdbId, fallbackWarning || message);
      }

      return {
        id: imdbId,
        url: `https://www.imdb.com/title/${imdbId}/`,
        source: 'custom-imdb-endpoint',
        sourceConfigured: true,
        error: message,
        warning: fallbackWarning
      };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (jsonError) {
      if (!hasCustomEndpoint) {
        return unavailablePublicImdbDetails(imdbId, fallbackWarning || `IMDb endpoint returned invalid JSON: ${jsonError.message}`);
      }

      return {
        id: imdbId,
        url: `https://www.imdb.com/title/${imdbId}/`,
        source: 'custom-imdb-endpoint',
        sourceConfigured: true,
        error: `IMDb endpoint returned invalid JSON: ${jsonError.message}`,
        warning: fallbackWarning
      };
    }

    return normalizeImdbApiPayload(payload, imdbId, hasCustomEndpoint ? 'custom-imdb-endpoint' : 'public-imdb', fallbackWarning);

  } catch (error) {
    const message = `IMDb endpoint request failed: ${error.message}`;
    if (!hasCustomEndpoint) {
      return unavailablePublicImdbDetails(imdbId, fallbackWarning || message);
    }

    return {
      id: imdbId,
      url: `https://www.imdb.com/title/${imdbId}/`,
      source: 'custom-imdb-endpoint',
      sourceConfigured: true,
      error: message,
      warning: fallbackWarning
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchImdbDetails(imdbId, env, fetchImpl) {
  if (!imdbId) {
    return null;
  }

  try {
    const firecrawlDetails = await fetchFirecrawlImdbDetails(imdbId, env, fetchImpl);
    if (firecrawlDetails) {
      return firecrawlDetails;
    }
  } catch (error) {
    return fetchPublicImdbDetails(imdbId, env, fetchImpl, `Firecrawl failed: ${error.message}`);
  }

  try {
    return fetchPublicImdbDetails(imdbId, env, fetchImpl);
  } catch (error) {
    return { error: error.message, source: 'public-imdb', sourceConfigured: true };
  }
}

async function fetchImdbEpisodesForSeasons(imdbId, allEpisodes, fetchImpl, env) {
  if (!imdbId) return [];

  // Determine which seasons to fetch
  const seasonsToFetch = new Set();
  const todayStr = new Date().toISOString().slice(0, 10);
  for (const episode of allEpisodes) {
    if (episode.airdate && episode.airdate >= todayStr) {
      seasonsToFetch.add(episode.season);
    }
  }
  if (seasonsToFetch.size === 0 && allEpisodes.length > 0) {
    const maxSeason = Math.max(...allEpisodes.map((episode) => episode.season));
    seasonsToFetch.add(maxSeason);
  }

  const sortedSeasons = Array.from(seasonsToFetch).sort((a, b) => b - a).slice(0, 2);

  let fetchImdbEpisodesFn = null;
  try {
    const { fetchImdbEpisodes } = await import('./imdbEpisodes.js');
    fetchImdbEpisodesFn = fetchImdbEpisodes;
  } catch (err) {
    console.warn(`Failed to import fetchImdbEpisodes:`, err.message);
  }

  if (!fetchImdbEpisodesFn) return [];

  const fetchPromises = sortedSeasons.map(async (sNum) => {
    try {
      const eps = await fetchImdbEpisodesFn(imdbId, sNum);
      if (Array.isArray(eps)) {
        return eps;
      }
    } catch (err) {
      console.warn(`Failed to fetch IMDb episodes for season ${sNum}:`, err.message);
    }
    return [];
  });

  const results = await Promise.all(fetchPromises);
  const episodesList = [];
  for (const eps of results) {
    episodesList.push(...eps);
  }
  return episodesList;
}

function isChildrenShow(show) {
  if (!show) return false;
  const childrenGenres = ['children', 'family', 'kids', 'animation'];
  const genres = (show.genres || []).map(g => g.toLowerCase());
  const hasChildrenGenre = genres.some(g => childrenGenres.includes(g));

  const childrenNetworks = [
    'disney junior',
    'nickelodeon',
    'nick jr.',
    'cartoon network',
    'disney channel',
    'pbs kids',
    'disney+'
  ];
  const network = (show.network?.name || show.webChannel?.name || '').toLowerCase();
  const hasChildrenNetwork = childrenNetworks.some(net => network.includes(net));

  const type = (show.type || '').toLowerCase();
  const isAnimation = type === 'animation';

  return hasChildrenGenre || hasChildrenNetwork || isAnimation;
}

export async function getEpisodes({ query, now = new Date(), since = null, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  if (!trimmedQuery) {
    const error = new Error('A show name is required.');
    error.statusCode = 400;
    throw error;
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required. Use Node 18+ or provide fetchImpl.');
  }

  let show;
  let allEpisodes = [];
  let imdbDetails = null;

  try {
    show = await searchShow(trimmedQuery, fetchImpl);
    const episodes = await fetchShowEpisodes(show.id, fetchImpl);
    allEpisodes = normalizeEpisodes(episodes, show).filter((episode) => episode.airstamp || episode.airdate);
  } catch (tvmazeError) {
    console.warn(`TVmaze failed for "${trimmedQuery}":`, tvmazeError.message);

    // Fallback to IMDb
    // 1. Try to find the show in cached imdb-episodes.json first
    let cachedImdbData = null;
    try {
      const cachedPath = path.join(__dirname, 'data/tv/imdb-episodes.json');
      const cachedContent = await fs.readFile(cachedPath, 'utf8');
      cachedImdbData = JSON.parse(cachedContent);
    } catch (err) {
      // Ignore
    }

    let imdbId = null;
    let showTitle = null;

    if (cachedImdbData && cachedImdbData.shows) {
      for (const [id, s] of Object.entries(cachedImdbData.shows)) {
        if (s.title && s.title.toLowerCase() === trimmedQuery.toLowerCase()) {
          imdbId = id;
          showTitle = s.title;
          break;
        }
      }
    }

    // 2. If not in cache, search on IMDb suggestion API
    if (!imdbId) {
      try {
        const suggestUrl = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(trimmedQuery).toLowerCase()}.json`;
        const data = await fetchJson(suggestUrl, fetchImpl);
        const items = data.d || [];
        // Prioritize tvSeries and tvMiniSeries
        let matched = items.find(item => item.id?.startsWith('tt') && (item.qid === 'tvSeries' || item.qid === 'tvMiniSeries'));
        if (!matched) {
          // Fall back to tvSpecial or tvMovie if series/miniseries are not found, excluding video games or missing qid
          matched = items.find(item => item.id?.startsWith('tt') && (item.qid === 'tvSpecial' || item.qid === 'tvMovie'));
        }
        if (matched) {
          imdbId = matched.id;
          showTitle = matched.l;
        }
      } catch (e) {
        console.warn('IMDb suggestion search failed:', e.message);
      }
    }

    if (!imdbId) {
      // If we still don't have an IMDb ID, we can't fall back to IMDb. Throw original error.
      throw tvmazeError;
    }

    // 3. Fetch IMDb details
    imdbDetails = await fetchImdbDetails(imdbId, env, fetchImpl);

    show = {
      id: `imdb-${imdbId}`,
      name: showTitle || (imdbDetails && imdbDetails.title) || trimmedQuery,
      status: 'Running',
      premiered: (imdbDetails && imdbDetails.year) ? `${imdbDetails.year}-01-01` : null,
      ended: null,
      genres: [],
      language: 'English',
      officialSite: null,
      url: `https://www.imdb.com/title/${imdbId}/`,
      image: null,
      summary: (imdbDetails && imdbDetails.plot) || '',
      network: null,
      externals: { imdb: imdbId }
    };
  }

  const imdbId = show.externals?.imdb || null;
  let imdbEpisodesList = [];
  let imdbUpcoming = null;

  if (imdbId) {
    try {
      // 1. Try to load pre-cached IMDb episodes data if it exists
      let cachedImdbData = null;
      try {
        const cachedPath = path.join(__dirname, 'data/tv/imdb-episodes.json');
        const cachedContent = await fs.readFile(cachedPath, 'utf8');
        cachedImdbData = JSON.parse(cachedContent);
      } catch (err) {
        // Ignore missing or invalid pre-cached IMDb episodes data
      }

      if (cachedImdbData && cachedImdbData.shows && cachedImdbData.shows[imdbId]) {
        imdbEpisodesList = cachedImdbData.shows[imdbId].episodes || [];
        imdbUpcoming = {
          id: imdbId,
          source: 'imdb-episodes',
          sourceConfigured: true
        };
      } else {
        // Fallback to live search and scrape
        imdbEpisodesList = await fetchImdbEpisodesForSeasons(imdbId, allEpisodes, fetchImpl, env);
        if (imdbEpisodesList.length > 0) {
          imdbUpcoming = {
            id: imdbId,
            source: 'imdb-episodes',
            sourceConfigured: true
          };
        }
      }
    } catch (err) {
      console.warn('IMDb upcoming episodes pre-load failed gracefully:', err.message);
    }
  }

  // Correct TVmaze episodes' airdates using IMDb's correct dates before children's show merging
  if (imdbEpisodesList.length > 0 && allEpisodes.length > 0) {
    allEpisodes.forEach(tvEp => {
      const tvEpNameClean = tvEp.name?.toLowerCase().trim();
      if (tvEpNameClean) {
        const matchedImdbEp = imdbEpisodesList.find(imdbEp => {
          const imdbEpNameClean = imdbEp.name?.toLowerCase().trim();
          return imdbEpNameClean && (imdbEpNameClean.includes(tvEpNameClean) || tvEpNameClean.includes(imdbEpNameClean));
        });
        if (matchedImdbEp && matchedImdbEp.airdate) {
          tvEp.airdate = matchedImdbEp.airdate;
          tvEp.imdbEpisodeKey = `${matchedImdbEp.season}-${matchedImdbEp.number}`;
          if (tvEp.airstamp && typeof tvEp.airstamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(tvEp.airstamp)) {
            tvEp.airstamp = matchedImdbEp.airdate + tvEp.airstamp.substring(10);
          } else {
            const airtimeStr = tvEp.airtime || '00:00';
            const formattedTime = airtimeStr.split(':').length === 2 ? `${airtimeStr}:00` : airtimeStr;
            tvEp.airstamp = `${matchedImdbEp.airdate}T${formattedTime}Z`;
          }
        }
      }
    });

    // Re-sort episodes after date alignment to ensure consecutive children's show segments are sorted properly
    allEpisodes.sort((left, right) => {
      const leftTime = getEpisodeTimestamp(left);
      const rightTime = getEpisodeTimestamp(right);
      if (leftTime !== rightTime) return leftTime - rightTime;
      if (left.season !== right.season) return left.season - right.season;
      return left.number - right.number;
    });
  }

  if (isChildrenShow(show)) {
    const merged = [];
    for (let i = 0; i < allEpisodes.length; i++) {
      const current = allEpisodes[i];
      const currentEligible = current.airdate !== null && current.airdate !== undefined && (current.runtime === null || current.runtime < 20);

      if (currentEligible) {
        let j = i + 1;
        const accumulated = { ...current };
        let hasMerged = false;

        while (j < allEpisodes.length) {
          const next = allEpisodes[j];
          const nextEligible = next.airdate !== null && next.airdate !== undefined && (next.runtime === null || next.runtime < 20);

          let canMerge = false;
          if (nextEligible && next.season === current.season) {
            if (current.imdbEpisodeKey && next.imdbEpisodeKey) {
              canMerge = current.imdbEpisodeKey === next.imdbEpisodeKey;
            } else {
              canMerge = next.airdate === current.airdate;
            }
          }

          if (canMerge) {
            accumulated.name = `${accumulated.name}/${next.name}`;
            accumulated.runtime = (accumulated.runtime || 0) + (next.runtime || 0);
            accumulated.summary = [accumulated.summary, next.summary].filter(Boolean).join(' ');
            hasMerged = true;
            j++;
          } else {
            break;
          }
        }

        if (hasMerged) {
          merged.push(accumulated);
          i = j - 1;
        } else {
          merged.push(current);
        }
      } else {
        merged.push(current);
      }
    }

    // Now re-index the episode numbers per season
    const seasonCounters = {};
    for (const ep of merged) {
      const s = ep.season;
      if (s !== null && s !== undefined) {
        if (!seasonCounters[s]) {
          seasonCounters[s] = 1;
        } else {
          seasonCounters[s]++;
        }
        ep.number = seasonCounters[s];
      }
    }

    allEpisodes = merged;
  }

  const imdb = imdbDetails || (await fetchImdbDetails(imdbId, env, fetchImpl));

  // Load pre-cached Google Verified data
  let googleVerifiedData = null;
  try {
    const verifiedUrl = new URL('./data/tv/google-verified.json', import.meta.url);
    const verifiedContent = await fs.readFile(verifiedUrl, 'utf8');
    googleVerifiedData = JSON.parse(verifiedContent);
  } catch (err) {
    // Ignore if cache file does not exist or fails to parse
  }

  // IMDb upcoming episodes search and enrichment
  if (imdbId && imdbEpisodesList.length > 0) {
    try {
      // Merge and supplement episodes
      const tvmazeEpMap = new Map();
      allEpisodes.forEach(episode => {
        if (episode.season !== null && episode.season !== undefined && episode.number !== null && episode.number !== undefined) {
          tvmazeEpMap.set(`${episode.season}-${episode.number}`, episode);
        }
      });

      for (const imdbEp of imdbEpisodesList) {
        const key = `${imdbEp.season}-${imdbEp.number}`;
        if (tvmazeEpMap.has(key)) {
          // Enrich existing TVMaze episode
          const tvmazeEp = tvmazeEpMap.get(key);
          tvmazeEp.imdbUrl = imdbEp.url;
          if (imdbEp.name && imdbEp.name !== `Episode ${imdbEp.number}` && imdbEp.name !== tvmazeEp.name) {
            tvmazeEp.name = imdbEp.name;
          }
          if (!tvmazeEp.summary && imdbEp.summary) {
            tvmazeEp.summary = imdbEp.summary;
          }
          if (imdbEp.airdate && imdbEp.airdate !== tvmazeEp.airdate) {
            tvmazeEp.airdate = imdbEp.airdate;
            if (tvmazeEp.airstamp && typeof tvmazeEp.airstamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(tvmazeEp.airstamp)) {
              tvmazeEp.airstamp = imdbEp.airdate + tvmazeEp.airstamp.substring(10);
            } else {
              const airtimeStr = tvmazeEp.airtime || '00:00';
              const formattedTime = airtimeStr.split(':').length === 2 ? `${airtimeStr}:00` : airtimeStr;
              tvmazeEp.airstamp = `${imdbEp.airdate}T${formattedTime}Z`;
            }
          }
        } else if (imdbEp.airdate) {
          // Add as a new supplemental episode from IMDb!
          const newEp = {
            id: `imdb-${imdbId}-${imdbEp.season}-${imdbEp.number}`,
            name: imdbEp.name || 'Untitled episode',
            season: imdbEp.season,
            number: imdbEp.number,
            airdate: imdbEp.airdate,
            airtime: null,
            airstamp: `${imdbEp.airdate}T00:00:00Z`,
            runtime: 60,
            summary: imdbEp.summary || '',
            url: imdbEp.url || `https://www.imdb.com/title/${imdbId}/`,
            showName: show.name,
            showId: show.id || null,
            network: show.network?.name || show.webChannel?.name || null,
            country: show.network?.country?.name || show.webChannel?.country?.name || null,
            imdbUrl: imdbEp.url
          };
          allEpisodes.push(newEp);
          tvmazeEpMap.set(key, newEp);
        }
      }

      // Re-sort episodes by date/season/number
      allEpisodes.sort((left, right) => {
        const leftTime = getEpisodeTimestamp(left);
        const rightTime = getEpisodeTimestamp(right);
        if (leftTime !== rightTime) return leftTime - rightTime;
        if (left.season !== right.season) return left.season - right.season;
        return left.number - right.number;
      });
    } catch (err) {
      console.warn('IMDb upcoming episodes enrichment failed gracefully:', err.message);
    }
  }

  // Apply Google Verified overrides if present
  if (googleVerifiedData) {
    allEpisodes.forEach(episode => {
      const overrideKey = `${show.name}-${episode.season}-${episode.number}`;
      const override = googleVerifiedData[overrideKey];
      if (override) {
        if (override.airdate) {
          episode.airdate = override.airdate;
          if (episode.airstamp && typeof episode.airstamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(episode.airstamp)) {
            episode.airstamp = override.airdate + episode.airstamp.substring(10);
          } else {
            const airtimeStr = episode.airtime || '00:00';
            const formattedTime = airtimeStr.split(':').length === 2 ? `${airtimeStr}:00` : airtimeStr;
            episode.airstamp = `${override.airdate}T${formattedTime}Z`;
          }
        }
        if (override.name) {
          episode.name = override.name;
        }
      }
    });

    // Re-sort again to ensure correctness after overrides
    allEpisodes.sort((left, right) => {
      const leftTime = getEpisodeTimestamp(left);
      const rightTime = getEpisodeTimestamp(right);
      if (leftTime !== rightTime) return leftTime - rightTime;
      if (left.season !== right.season) return left.season - right.season;
      return left.number - right.number;
    });
  }

  if (since) {
    const sinceTime = Date.parse(since);
    if (!Number.isNaN(sinceTime)) {
      allEpisodes = allEpisodes.filter((episode) => getEpisodeTimestamp(episode) >= sinceTime);
    }
  }

  return {
    query: trimmedQuery,
    generatedAt: now.toISOString(),
    window: {
      from: toIsoDate(now),
      mode: 'all-time'
    },
    show: {
      id: show.id,
      name: show.name,
      status: show.status,
      premiered: show.premiered,
      ended: show.ended,
      genres: show.genres || [],
      language: show.language || null,
      officialSite: show.officialSite || null,
      tvmazeUrl: show.url,
      imdbId,
      image: show.image?.medium || show.image?.original || null,
      summary: compactText(show.summary),
      network: show.network?.name || show.webChannel?.name || null
    },
    imdb,
    imdbUpcoming,
    episodes: allEpisodes
  };
}

export function toIcs(result, { timezone = 'UTC' } = {}) {
  const escapeText = (value) => String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');

  const formatDescription = (episode, episodeTime) => {
    const details = [];

    if (episode.network) {
      details.push(`How to watch: Airs on ${episode.network}.`);
    }

    if (result.show.officialSite) {
      details.push(`Official site: ${result.show.officialSite}`);
    }

    if (episode.imdbUrl) {
      details.push(`IMDb Episode: ${episode.imdbUrl}`);
    }

    if (episodeTime) {
      details.push(`Time: ${episodeTime}.`);
    }

    const hasSeason = episode.season !== null && episode.season !== undefined;
    const hasEpisodeNum = episode.number !== null && episode.number !== undefined;
    const episodeCode = (hasSeason && hasEpisodeNum) ? `S${String(episode.season).padStart(2, '0')}E${String(episode.number).padStart(2, '0')}` : '';
    const googleSearchQuery = `${episode.showName} ${episodeCode} episode`.replace(/\s+/g, ' ').trim();
    details.push(`Verify schedule: https://www.google.com/search?q=${encodeURIComponent(googleSearchQuery)}`);

    details.push(episode.summary || `Episode of ${episode.showName}`);
    return details.join(' ');
  };

  const formatIcsDateTime = (date) => {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MakeICS//TV Episodes//EN',
    'CALSCALE:GREGORIAN',
    `X-PUBLISHED-TTL:${FEED_REFRESH_INTERVAL}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${FEED_REFRESH_INTERVAL}`
  ];

  for (const episode of result.episodes) {
    const startDate = new Date(episode.airstamp || `${episode.airdate}T${episode.airtime || '00:00'}:00Z`);
    const start = formatIcsDateTime(startDate);
    const durationMinutes = Number.isFinite(episode.runtime) ? episode.runtime : 60;
    const end = new Date(startDate.getTime() + durationMinutes * 60_000)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const hasEpSeason = episode.season !== null && episode.season !== undefined;
    const hasEpNum = episode.number !== null && episode.number !== undefined;
    const episodeCode = (hasEpSeason && hasEpNum) ? `S${String(episode.season).padStart(2, '0')}E${String(episode.number).padStart(2, '0')}` : '';

    const timesString = formatTimeForTimezone(startDate, timezone);

    lines.push(
      'BEGIN:VEVENT',
      `UID:tvmaze-${episode.id}@makeics.local`,
      `DTSTAMP:${result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${escapeText(`${episode.showName} ${episodeCode} ${episode.name}`.replace(/\s+/g, ' ').trim())}`,
      `DESCRIPTION:${escapeText(formatDescription(episode, timesString))}`,
      `URL:${episode.url || result.show.tvmazeUrl || ''}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
