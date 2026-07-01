import { getMovies, toIcs } from '../lib/movies.js';

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
  const query = requestUrl.searchParams.get('q') || '';
  const type = requestUrl.searchParams.get('type') || 'all';
  const format = requestUrl.searchParams.get('format');
  const since = requestUrl.searchParams.get('since');

  try {
    const result = await getMovies({ type, query, since });

    if (format === 'ics') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
      return res.end(toIcs(result));
    }

    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to fetch movies.' });
  }
}
