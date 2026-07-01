import { searchMovieSuggestions } from '../lib/movies.js';

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
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

  try {
    const suggestions = await searchMovieSuggestions({ query, type });
    return sendJson(res, 200, { query: query.trim(), suggestions });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to fetch movie suggestions.' });
  }
}
