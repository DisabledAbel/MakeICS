import { formatTimeForTimezone } from './utils/date.js';

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

export async function getEpisodes({ query, now = new Date(), fetchImpl = globalThis.fetch, env = process.env } = {}) {
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
  const allEpisodes = normalizeEpisodes(episodes, show);
  const imdbId = show.externals?.imdb || null;
  const imdb = await fetchImdbDetails(imdbId, env, fetchImpl);

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
      details.push(`Airs on ${episode.network}.`);
    }

    if (episodeTime) {
      details.push(`Time: ${episodeTime}.`);
    }

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
    const episodeCode = episode.season && episode.number ? `S${String(episode.season).padStart(2, '0')}E${String(episode.number).padStart(2, '0')}` : '';

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
