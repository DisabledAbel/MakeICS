import { getUpcomingEvents, toIcs } from '../lib/sports.js';

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const teamId = requestUrl.searchParams.get('teamId');
  const format = requestUrl.searchParams.get('format');
  const timezone = requestUrl.searchParams.get('tz') || 'UTC';

  if (!teamId) {
    return sendJson(res, 400, { error: 'teamId is required.' });
  }

  try {
    const result = await getUpcomingEvents({ teamId });

    if (format === 'ics') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
      return res.end(toIcs(result, { timezone }));
    }

    return sendJson(res, 200, result);
  } catch (error) {
    const statusCode = error.message?.includes('found') ? 404 : 500;
    return sendJson(res, statusCode, { error: error.message || 'Unable to fetch sports events.' });
  }
}
