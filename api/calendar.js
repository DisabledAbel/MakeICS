import { buildCalendar, toIcs } from '../lib/calendar.js';

const CACHE = 's-maxage=86400, stale-while-revalidate=3600';
const TYPES = new Set(['all', 'studio', 'genre', 'character']);

function sendJson(res, statusCode, payload, cache = false) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cache) res.setHeader('Cache-Control', CACHE);
  res.end(JSON.stringify(payload));
}

function list(params, key) {
  const values = params.getAll(key).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  return [...new Map(values.map(value => [value.toLocaleLowerCase(), value])).values()];
}

export function parseCalendarRequest(requestUrl) {
  if (requestUrl.search.length > 4096) throw new Error('Query string exceeds the 4096 character limit.');
  const shows = list(requestUrl.searchParams, 'shows');
  const teamIds = list(requestUrl.searchParams, 'teamIds');
  const movies = list(requestUrl.searchParams, 'movies');
  const movieType = requestUrl.searchParams.get('movieType') || 'all';
  const timezone = requestUrl.searchParams.get('tz') || 'UTC';
  const since = requestUrl.searchParams.get('since');
  if (!shows.length && !teamIds.length && !movies.length) throw new Error('At least one TV show, sports team, or movie source is required.');
  if (shows.length > 10) throw new Error('A maximum of 10 TV shows is allowed.');
  if (teamIds.length > 10) throw new Error('A maximum of 10 sports teams is allowed.');
  if (movies.length > 5) throw new Error('A maximum of 5 movie searches is allowed.');
  if (shows.length + teamIds.length + movies.length > 20) throw new Error('A maximum of 20 total sources is allowed.');
  if ([...shows, ...teamIds, ...movies].some(value => value.length > 200)) throw new Error('Source values must be 200 characters or fewer.');
  if (!teamIds.every(id => /^[a-zA-Z0-9-]{1,50}$/.test(id))) throw new Error('One or more team IDs are invalid.');
  if (!TYPES.has(movieType)) throw new Error('movieType must be all, studio, genre, or character.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { throw new Error('Unsupported timezone. Use a valid IANA timezone.'); }
  if (since && Number.isNaN(Date.parse(since))) throw new Error('since must be a valid date.');
  return { shows, teamIds, movies, movieType, timezone, since };
}

export function createCalendarHandler(loaders) {
  return async function handler(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  let options;
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    options = parseCalendarRequest(requestUrl);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const result = await buildCalendar({ ...options, loaders });
  if (!result.successfulSources) return sendJson(res, 502, { error: 'Unable to load any requested calendar source.', failures: result.failures });
  if (requestUrl.searchParams.get('format') === 'ics') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', CACHE);
    return res.end(req.method === 'HEAD' ? '' : toIcs(result));
  }
  if (req.method === 'HEAD') {
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', CACHE); return res.end();
  }
  return sendJson(res, 200, { calendar: result.calendar, sources: result.sources, failures: result.failures, events: result.events }, true);
  };
}

export default createCalendarHandler();
