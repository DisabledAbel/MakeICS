import { getSchoolHolidays, toIcs } from '../lib/school.js';

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
  const subdivisionCode = requestUrl.searchParams.get('subdivisionCode');
  const format = requestUrl.searchParams.get('format');

  if (!countryCode) {
    return sendJson(res, 400, { error: 'countryCode is required.' });
  }

  try {
    const result = await getSchoolHolidays({ countryCode, subdivisionCode });

    if (format === 'ics') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
      return res.end(toIcs(result));
    }

    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to fetch school holidays.' });
  }
}
