import { getEvents, toIcs } from '../lib/sports.js';

/** Return a shared-cache policy: six hours with NHL events, otherwise 24, plus one stale hour. */
function cacheFor(payload) {
  return payload?.events?.some(event => event.league === 'NHL') ? 's-maxage=21600, stale-while-revalidate=3600' : 's-maxage=86400, stale-while-revalidate=3600';
}
/** End the response with JSON, the supplied status, and the payload's sports cache policy. */
function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheFor(payload));
  res.end(JSON.stringify(payload));
}

/**
 * Serve teamId events as JSON or format=ics for GET/HEAD, forwarding since and tz.
 * Writes a body for either method. Missing teamId returns 400; other methods get 405.
 * Load/serialization errors become 404 when their message contains "found", otherwise
 * 500; URL construction errors propagate. NHL event results use a six-hour shared
 * cache, while other results and error JSON use 24 hours.
 */
export default async function handler(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const teamId = requestUrl.searchParams.get('teamId');
  const format = requestUrl.searchParams.get('format');
  const timezone = requestUrl.searchParams.get('tz') || 'UTC';
  const since = requestUrl.searchParams.get('since');

  if (!teamId) {
    return sendJson(res, 400, { error: 'teamId is required.' });
  }

  try {
    const result = await getEvents({ teamId, since });

    if (format === 'ics') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', cacheFor(result));
      return res.end(toIcs(result, { timezone }));
    }

    return sendJson(res, 200, result);
  } catch (error) {
    const statusCode = error.message?.includes('found') ? 404 : 500;
    return sendJson(res, statusCode, { error: error.message || 'Unable to fetch sports events.' });
  }
}
