import { getCountries, getSubdivisions } from '../lib/school.js';

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
  const countryCode = requestUrl.searchParams.get('countryCode');

  try {
    if (countryCode) {
      const subdivisions = await getSubdivisions({ countryCode });
      return sendJson(res, 200, { subdivisions });
    } else {
      const countries = await getCountries();
      return sendJson(res, 200, { countries });
    }
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to fetch school regions.' });
  }
}
