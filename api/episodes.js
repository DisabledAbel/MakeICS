import { getEpisodes, toIcs } from '../lib/tvEpisodes.js';

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
  const query = requestUrl.searchParams.get('show') || requestUrl.searchParams.get('q');
  const format = requestUrl.searchParams.get('format');
  const timezone = requestUrl.searchParams.get('tz') || 'UTC';

  try {
    const result = await getEpisodes({ query });

    if (format === 'ics') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
      return res.end(toIcs(result, { timezone }));
    }

    return sendJson(res, 200, result);
  } catch (error) {
    const statusCode = error.statusCode || (error.message?.includes('404') ? 404 : 500);
    return sendJson(res, statusCode, {
      error: statusCode === 404 ? 'Show not found.' : error.message || 'Unable to fetch episodes.'
    });
  }
}
