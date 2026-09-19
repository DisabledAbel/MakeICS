import { createHash } from 'node:crypto';
import { getEpisodes } from './tvEpisodes.js';
import { getEvents } from './sports.js';
import { getMovies } from './movies.js';
import { parseApiTimestamp } from './utils/date.js';

const REFRESH_INTERVAL = 'PT24H';

function stablePart(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function fallbackId(parts) {
  return createHash('sha256').update(parts.map(value => String(value ?? '')).join('\u001f')).digest('hex').slice(0, 24);
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeTv(result) {
  return result.episodes.map(episode => {
    const start = validDate(episode.airstamp || `${episode.airdate}T${episode.airtime || '00:00'}:00Z`);
    if (!start) return null;
    const id = episode.id ?? fallbackId([result.show.id, episode.season, episode.number, episode.airdate, episode.name]);
    const duration = Number.isFinite(episode.runtime) ? episode.runtime : 60;
    return {
      uid: `makeics-tv-${stablePart(result.show.id)}-${stablePart(id)}@makeics`,
      type: 'tv', title: episode.name, description: episode.summary || `Episode of ${result.show.name}`,
      start: start.toISOString(), end: new Date(start.getTime() + duration * 60000).toISOString(), allDay: false,
      location: '', url: episode.url || result.show.tvmazeUrl || '', source: result.show.name,
      sourceId: String(result.show.id), metadata: { episodeId: String(id), season: episode.season, number: episode.number, network: episode.network }
    };
  }).filter(Boolean);
}

function sportsDuration(sport) {
  const durations = { 'american football': 180, baseball: 180, basketball: 150, 'ice hockey': 150, soccer: 110 };
  return durations[String(sport || '').toLowerCase()] || 120;
}

function normalizeSports(result, requestedTeamId) {
  return result.events.map(event => {
    const start = parseApiTimestamp(event.timestamp, event.date, event.time);
    if (Number.isNaN(start.getTime())) return null;
    const id = event.id ?? fallbackId([requestedTeamId, event.date, event.time, event.homeTeam, event.awayTeam]);
    return {
      uid: `makeics-sports-${stablePart(requestedTeamId)}-${stablePart(id)}@makeics`,
      type: 'sports', title: event.name, description: [event.league, event.tvStation ? `Watch on ${event.tvStation}` : ''].filter(Boolean).join('. '),
      start: start.toISOString(), end: new Date(start.getTime() + sportsDuration(result.team.sport) * 60000).toISOString(), allDay: false,
      location: event.venue || '', url: '', source: result.team.name, sourceId: String(requestedTeamId),
      metadata: { eventId: String(id), league: event.league, homeTeam: event.homeTeam, awayTeam: event.awayTeam }
    };
  }).filter(Boolean);
}

function normalizeMovies(result) {
  return result.movies.map(movie => {
    const date = movie.date || (typeof movie.releaseDate === 'string' ? movie.releaseDate.slice(0, 10) : '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const releaseDate = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(releaseDate.getTime()) || releaseDate.toISOString().slice(0, 10) !== date) return null;
    const id = movie.id || fallbackId([movie.title, date]);
    return {
      uid: `makeics-movie-${stablePart(id)}-${date.replaceAll('-', '')}@makeics`,
      type: 'movie', title: `${movie.title} (Movie Release)`,
      description: [movie.genres?.length ? `Genres: ${movie.genres.join(', ')}` : '', movie.people?.length ? `Cast/Crew: ${movie.people.join(', ')}` : ''].filter(Boolean).join('\n'),
      start: date, end: nextDate(date), allDay: true, location: '', url: movie.id ? `https://www.imdb.com/title/${encodeURIComponent(movie.id)}/` : '',
      source: result.query || 'All movies', sourceId: String(id), metadata: { movieId: movie.id || null, genres: movie.genres || [] }
    };
  }).filter(Boolean);
}

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function safeError(type) {
  if (type === 'tv') return 'Unable to fetch TV schedule.';
  if (type === 'sports') return 'Unable to fetch sports schedule.';
  return 'Unable to fetch movie schedule.';
}

export async function buildCalendar({ shows = [], teamIds = [], movies = [], movieType = 'all', timezone = 'UTC', since = null, loaders = {} } = {}) {
  const loadEpisodes = loaders.getEpisodes || getEpisodes;
  const loadEvents = loaders.getEvents || getEvents;
  const loadMovies = loaders.getMovies || getMovies;
  const requests = [
    ...shows.map(query => ({ type: 'tv', query, run: () => loadEpisodes({ query, since }) })),
    ...teamIds.map(teamId => ({ type: 'sports', teamId, run: () => loadEvents({ teamId, since }) })),
    ...movies.map(query => ({ type: 'movies', query, movieType, run: () => loadMovies({ query, type: movieType, since }) }))
  ];
  const settled = await Promise.allSettled(requests.map(request => request.run()));
  const sources = { tv: [], sports: [], movies: [] };
  const failures = [];
  const events = [];

  settled.forEach((outcome, index) => {
    const request = requests[index];
    const key = request.type;
    const requested = request.query || request.teamId;
    if (outcome.status === 'rejected') {
      const failure = { type: key, ...(key === 'sports' ? { teamId: requested } : { query: requested }), error: safeError(key) };
      sources[key].push({ requested, status: 'failed' });
      failures.push(failure);
      return;
    }
    let normalized;
    if (key === 'tv') normalized = normalizeTv(outcome.value);
    else if (key === 'sports') normalized = normalizeSports(outcome.value, request.teamId);
    else normalized = normalizeMovies(outcome.value);
    sources[key].push({ requested, status: 'success', eventCount: normalized.length });
    events.push(...normalized);
  });

  const unique = [...new Map(events.map(event => [event.uid, event])).values()]
    .sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.uid.localeCompare(b.uid));
  return { calendar: { timezone, eventCount: unique.length }, sources, failures, events: unique, successfulSources: settled.filter(item => item.status === 'fulfilled').length };
}

export function escapeIcsText(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function formatUtc(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function formatDate(value) { return String(value).replaceAll('-', ''); }

function foldLine(line) {
  const chunks = [];
  let remaining = line;
  while (Buffer.byteLength(remaining, 'utf8') > 75) {
    let end = Math.min(75, remaining.length);
    while (Buffer.byteLength(remaining.slice(0, end), 'utf8') > 75) end--;
    chunks.push(remaining.slice(0, end));
    remaining = ` ${remaining.slice(end)}`;
  }
  chunks.push(remaining);
  return chunks.join('\r\n');
}

export function toIcs(result, { now = new Date() } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MakeICS//Combined Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-TIMEZONE:${escapeIcsText(result.calendar.timezone)}`, `X-PUBLISHED-TTL:${REFRESH_INTERVAL}`, `REFRESH-INTERVAL;VALUE=DURATION:${REFRESH_INTERVAL}`];
  const stamp = formatUtc(now);
  for (const event of result.events) {
    lines.push('BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${stamp}`);
    if (event.allDay) lines.push(`DTSTART;VALUE=DATE:${formatDate(event.start)}`, `DTEND;VALUE=DATE:${formatDate(event.end)}`);
    else lines.push(`DTSTART:${formatUtc(event.start)}`, `DTEND:${formatUtc(event.end)}`);
    lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    if (event.url) lines.push(`URL:${event.url}`);
    lines.push(`CATEGORIES:${event.type.toUpperCase()}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
