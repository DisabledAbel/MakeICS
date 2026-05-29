const TVMAZE_BASE_URL = 'https://api.tvmaze.com';
const DEFAULT_LOOKAHEAD_DAYS = 120;
const MAX_LOOKAHEAD_DAYS = 365;
const MAX_EPISODES = 25;

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function sanitizeLookahead(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_LOOKAHEAD_DAYS;
  }
  return Math.min(Math.max(parsed, 1), MAX_LOOKAHEAD_DAYS);
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

function filterUpcomingEpisodes(episodes, show, now, lookaheadDays) {
  const from = now.getTime();
  const to = addDays(now, lookaheadDays).getTime();

  return episodes
    .filter((episode) => {
      const timestamp = getEpisodeTimestamp(episode);
      return timestamp >= from && timestamp <= to;
    })
    .sort((left, right) => getEpisodeTimestamp(left) - getEpisodeTimestamp(right))
    .slice(0, MAX_EPISODES)
    .map((episode) => normalizeEpisode(episode, show));
}

function imdbEndpointFromEnv(env, imdbId) {
  if (!env.IMDB_API_URL || !imdbId) {
    return null;
  }

  const separator = env.IMDB_API_URL.includes('?') ? '&' : '?';
  const templateUrl = env.IMDB_API_URL.includes('{imdbId}')
    ? env.IMDB_API_URL.replaceAll('{imdbId}', encodeURIComponent(imdbId))
    : `${env.IMDB_API_URL}${separator}i=${encodeURIComponent(imdbId)}`;

  return templateUrl;
}

async function fetchImdbDetails(imdbId, env, fetchImpl) {
  const url = imdbEndpointFromEnv(env, imdbId);
  if (!url) {
    return null;
  }

  const headers = {
    Accept: 'application/json',
    'User-Agent': 'MakeICS-TV-Episodes/1.0'
  };

  if (env.IMDB_API_KEY) {
    headers.Authorization = `Bearer ${env.IMDB_API_KEY}`;
  }

  if (env.IMDB_RAPIDAPI_KEY) {
    headers['X-RapidAPI-Key'] = env.IMDB_RAPIDAPI_KEY;
  }

  if (env.IMDB_RAPIDAPI_HOST) {
    headers['X-RapidAPI-Host'] = env.IMDB_RAPIDAPI_HOST;
  }

  try {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      return { error: `IMDb endpoint returned HTTP ${response.status}` };
    }
    const payload = await response.json();
    return {
      id: imdbId,
      title: payload.title || payload.Title || payload.name || null,
      year: payload.year || payload.Year || null,
      rating: payload.imDbRating || payload.imdbRating || payload.rating || null,
      plot: payload.plot || payload.Plot || payload.description || null,
      url: `https://www.imdb.com/title/${imdbId}/`,
      sourceConfigured: true
    };
  } catch (error) {
    return { error: error.message, sourceConfigured: true };
  }
}

export async function getUpcomingEpisodes({ query, days, now = new Date(), fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  if (!trimmedQuery) {
    const error = new Error('A show name is required.');
    error.statusCode = 400;
    throw error;
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required. Use Node 18+ or provide fetchImpl.');
  }

  const lookaheadDays = sanitizeLookahead(days);
  const show = await searchShow(trimmedQuery, fetchImpl);
  const episodes = await fetchShowEpisodes(show.id, fetchImpl);
  const upcomingEpisodes = filterUpcomingEpisodes(episodes, show, now, lookaheadDays);
  const imdbId = show.externals?.imdb || null;
  const imdb = await fetchImdbDetails(imdbId, env, fetchImpl);

  return {
    query: trimmedQuery,
    generatedAt: now.toISOString(),
    window: {
      from: toIsoDate(now),
      to: toIsoDate(addDays(now, lookaheadDays)),
      days: lookaheadDays
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
    episodes: upcomingEpisodes
  };
}

export function toIcs(result) {
  const escapeText = (value) => String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');

  const formatDateTime = (episode) => {
    const date = new Date(episode.airstamp || `${episode.airdate}T${episode.airtime || '00:00'}:00Z`);
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MakeICS//TV Upcoming Episodes//EN',
    'CALSCALE:GREGORIAN'
  ];

  for (const episode of result.episodes) {
    const start = formatDateTime(episode);
    const durationMinutes = Number.isFinite(episode.runtime) ? episode.runtime : 60;
    const end = new Date(new Date(episode.airstamp || `${episode.airdate}T${episode.airtime || '00:00'}:00Z`).getTime() + durationMinutes * 60_000)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const episodeCode = episode.season && episode.number ? `S${String(episode.season).padStart(2, '0')}E${String(episode.number).padStart(2, '0')}` : '';

    lines.push(
      'BEGIN:VEVENT',
      `UID:tvmaze-${episode.id}@makeics.local`,
      `DTSTAMP:${result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${escapeText(`${episode.showName} ${episodeCode} ${episode.name}`.replace(/\s+/g, ' ').trim())}`,
      `DESCRIPTION:${escapeText(episode.summary || `Upcoming episode of ${episode.showName}`)}`,
      `URL:${episode.url || result.show.tvmazeUrl || ''}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
