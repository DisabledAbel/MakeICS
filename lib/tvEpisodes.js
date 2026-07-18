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
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'MakeICS-TV-Episodes/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json();
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

  const response = await fetchImpl(env.FIRECRAWL_API_URL || FIRECRAWL_SCRAPE_URL, {
    method: 'POST',
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

  const hasCustomEndpoint = Boolean(env.IMDB_API_URL);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MakeICS-TV-Episodes/1.0'
      }
    });
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
  }

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

  try {
    const payload = await response.json();
    return normalizeImdbApiPayload(payload, imdbId, hasCustomEndpoint ? 'custom-imdb-endpoint' : 'public-imdb', fallbackWarning);
  } catch (error) {
    if (!hasCustomEndpoint) {
      return unavailablePublicImdbDetails(imdbId, fallbackWarning || `IMDb endpoint returned invalid JSON: ${error.message}`);
    }

    return {
      id: imdbId,
      url: `https://www.imdb.com/title/${imdbId}/`,
      source: 'custom-imdb-endpoint',
      sourceConfigured: true,
      error: `IMDb endpoint returned invalid JSON: ${error.message}`,
      warning: fallbackWarning
    };
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

async function fetchRtEpisodesForSeasons(rtShow, allEpisodes, now, fetchImpl, env) {
  // Determine which seasons to fetch
  const seasonsToFetch = new Set();
  const todayStr = now.toISOString().slice(0, 10);
  for (const episode of allEpisodes) {
    if (episode.airdate && episode.airdate >= todayStr) {
      seasonsToFetch.add(episode.season);
    }
  }
  if (seasonsToFetch.size === 0 && allEpisodes.length > 0) {
    const maxSeason = Math.max(...allEpisodes.map((episode) => episode.season));
    seasonsToFetch.add(maxSeason);
  }

  // Fetch RT episodes for unique seasons concurrently (limit to latest 2 seasons to avoid excessive crawls)
  const sortedSeasons = Array.from(seasonsToFetch).sort((a, b) => b - a).slice(0, 2);

  let fetchRtEpisodesFn = null;
  try {
    const { fetchRtEpisodes } = await import('./rottenTomatoes.js');
    fetchRtEpisodesFn = fetchRtEpisodes;
  } catch (err) {
    console.warn(`Failed to import fetchRtEpisodes:`, err.message);
  }

  const fetchPromises = sortedSeasons.map(async (sNum) => {
    try {
      if (!fetchRtEpisodesFn) return [];
      const eps = await fetchRtEpisodesFn(rtShow.slug, sNum, fetchImpl, env);
      if (Array.isArray(eps)) {
        return eps;
      }
    } catch (err) {
      console.warn(`Failed to fetch RT episodes for season ${sNum}:`, err.message);
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

  const show = await searchShow(trimmedQuery, fetchImpl);
  const episodes = await fetchShowEpisodes(show.id, fetchImpl);
  let allEpisodes = normalizeEpisodes(episodes, show).filter((episode) => episode.airstamp || episode.airdate);

  const imdbId = show.externals?.imdb || null;
  const imdb = await fetchImdbDetails(imdbId, env, fetchImpl);

    // Load pre-cached Google Verified data
    let googleVerifiedData = null;
    try {
      const verifiedUrl = new URL('./data/tv/google-verified.json', import.meta.url);
      const verifiedContent = await fs.readFile(verifiedUrl, 'utf8');
      googleVerifiedData = JSON.parse(verifiedContent);
    } catch (err) {
      // Ignore if cache file does not exist or fails to parse
    }

  // Rotten Tomatoes search and enrichment
  let rt = null;
  try {
    const { searchRtShow, fetchRtEpisodes } = await import('./rottenTomatoes.js');

    // 1. Try to load pre-cached Rotten Tomatoes data
    let cachedRtData = null;
    try {
      const cachedPath = path.join(__dirname, 'data/tv/rotten-tomatoes.json');
      const cachedContent = await fs.readFile(cachedPath, 'utf8');
      cachedRtData = JSON.parse(cachedContent);
    } catch (err) {
      // Ignore missing or invalid pre-cached Rotten Tomatoes data
    }

    const canonicalize = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const canonicalQuery = canonicalize(trimmedQuery);
    const canonicalShowName = canonicalize(show?.name);

    let cachedShow = null;
    if (cachedRtData && cachedRtData.shows) {
      // Try exact canonical title match first (against query or TVMaze show name)
      cachedShow = Object.values(cachedRtData.shows).find(cachedShowItem => {
        const canonicalTitle = canonicalize(cachedShowItem.title);
        return canonicalTitle === canonicalQuery || (canonicalShowName && canonicalTitle === canonicalShowName);
      });
      // Try substring match if no exact match
      if (!cachedShow) {
        cachedShow = Object.values(cachedRtData.shows).find(cachedShowItem => {
          const canonicalTitle = canonicalize(cachedShowItem.title);
          return canonicalTitle.includes(canonicalQuery) || canonicalQuery.includes(canonicalTitle) ||
                 (canonicalShowName && (canonicalTitle.includes(canonicalShowName) || canonicalShowName.includes(canonicalTitle)));
        });
      }
    }

    let rtShow = null;
    let rtEpisodesList = [];

    if (cachedShow) {
      rtShow = cachedShow;
      rtEpisodesList = cachedShow.episodes || [];
    } else {
      // Fallback to live search and scrape if not found in pre-cache
      rtShow = await searchRtShow(trimmedQuery, fetchImpl);
      if (!rtShow && show?.name && show.name !== trimmedQuery) {
        rtShow = await searchRtShow(show.name, fetchImpl);
      }
      if (rtShow) {
        rtEpisodesList = await fetchRtEpisodesForSeasons(rtShow, allEpisodes, now, fetchImpl, env);
      }
    }

    if (rtShow) {
      rt = {
        title: rtShow.title,
        slug: rtShow.slug,
        url: rtShow.url,
        meterScore: rtShow.meterScore,
        meterClass: rtShow.meterClass,
        image: rtShow.image,
        startYear: rtShow.startYear,
        source: 'rottentomatoes',
        sourceConfigured: true
      };

      // Merge and supplement episodes
      const tvmazeEpMap = new Map();
      allEpisodes.forEach(episode => {
        if (episode.season !== null && episode.season !== undefined && episode.number !== null && episode.number !== undefined) {
          tvmazeEpMap.set(`${episode.season}-${episode.number}`, episode);
        }
      });

      for (const rtEp of rtEpisodesList) {
        const key = `${rtEp.season}-${rtEp.number}`;
        if (tvmazeEpMap.has(key)) {
          // Enrich existing TVMaze episode
          const tvmazeEp = tvmazeEpMap.get(key);
          tvmazeEp.rtUrl = rtEp.url;
          if (rtEp.name && rtEp.name !== `Episode ${rtEp.number}` && rtEp.name !== tvmazeEp.name) {
            tvmazeEp.name = rtEp.name;
          }
          if (!tvmazeEp.summary && rtEp.summary) {
            tvmazeEp.summary = rtEp.summary;
          }
          if (rtEp.airdate && rtEp.airdate !== tvmazeEp.airdate) {
            tvmazeEp.airdate = rtEp.airdate;
            if (tvmazeEp.airstamp && typeof tvmazeEp.airstamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(tvmazeEp.airstamp)) {
              tvmazeEp.airstamp = rtEp.airdate + tvmazeEp.airstamp.substring(10);
            } else {
              const airtimeStr = tvmazeEp.airtime || '00:00';
              const formattedTime = airtimeStr.split(':').length === 2 ? `${airtimeStr}:00` : airtimeStr;
              tvmazeEp.airstamp = `${rtEp.airdate}T${formattedTime}Z`;
            }
          }
        } else if (rtEp.airdate) {
          // Add as a new supplemental episode from Rotten Tomatoes!
          const newEp = {
            id: `rt-${rtShow.slug}-${rtEp.season}-${rtEp.number}`,
            name: rtEp.name || 'Untitled episode',
            season: rtEp.season,
            number: rtEp.number,
            airdate: rtEp.airdate,
            airtime: null,
            airstamp: `${rtEp.airdate}T00:00:00Z`,
            runtime: 60,
            summary: rtEp.summary || '',
            url: rtEp.url || rtShow.url,
            showName: show.name || rtShow.title,
            showId: show.id || null,
            network: show.network?.name || show.webChannel?.name || null,
            country: show.network?.country?.name || show.webChannel?.country?.name || null,
            rtUrl: rtEp.url
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
    }
  } catch (err) {
    console.warn('Rotten Tomatoes integration failed gracefully:', err.message);
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
    rt,
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

    if (result.rt?.url) {
      const scoreStr = result.rt.meterScore ? `(RT Tomatometer: ${result.rt.meterScore}%)` : '';
      details.push(`Rotten Tomatoes: ${result.rt.url} ${scoreStr}`.trim());
    }

    if (episode.rtUrl) {
      details.push(`Rotten Tomatoes Episode: ${episode.rtUrl}`);
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
