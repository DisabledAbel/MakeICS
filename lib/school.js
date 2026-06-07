const OPENHOLIDAYS_BASE_URL = 'https://openholidaysapi.org';
const FEED_REFRESH_INTERVAL = 'PT24H';

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'MakeICS-School-Schedules/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

export async function getCountries({ fetchImpl = globalThis.fetch } = {}) {
  const url = `${OPENHOLIDAYS_BASE_URL}/Countries`;
  return fetchJson(url, fetchImpl);
}

export async function getSubdivisions({ countryCode, fetchImpl = globalThis.fetch } = {}) {
  if (!countryCode) {
    throw new Error('A country code is required.');
  }
  const url = `${OPENHOLIDAYS_BASE_URL}/Subdivisions?countryCode=${encodeURIComponent(countryCode)}`;
  return fetchJson(url, fetchImpl);
}

export async function getSchoolHolidays({ countryCode, subdivisionCode, fetchImpl = globalThis.fetch } = {}) {
  if (!countryCode) {
    throw new Error('A country code is required.');
  }

  const now = new Date();
  const validFrom = now.toISOString().slice(0, 10);
  const nextYear = new Date(now);
  nextYear.setFullYear(now.getFullYear() + 1);
  const validTo = nextYear.toISOString().slice(0, 10);

  let url = `${OPENHOLIDAYS_BASE_URL}/SchoolHolidays?countryCode=${encodeURIComponent(countryCode)}&validFrom=${validFrom}&validTo=${validTo}`;
  if (subdivisionCode) {
    url += `&subdivisionCode=${encodeURIComponent(subdivisionCode)}`;
  }

  const holidays = await fetchJson(url, fetchImpl);

  return {
    countryCode,
    subdivisionCode: subdivisionCode || null,
    holidays: holidays.map((h) => ({
      id: h.id,
      name: h.name[0]?.text || 'School Holiday',
      startDate: h.startDate,
      endDate: h.endDate,
      type: h.type
    })),
    generatedAt: now.toISOString()
  };
}

export function toIcs(result) {
  const escapeText = (value) => String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MakeICS//School Holidays//EN',
    'CALSCALE:GREGORIAN',
    `X-PUBLISHED-TTL:${FEED_REFRESH_INTERVAL}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${FEED_REFRESH_INTERVAL}`
  ];

  for (const holiday of result.holidays) {
    // OpenHolidays dates are YYYY-MM-DD
    const start = holiday.startDate.replace(/-/g, '');
    // End date in ICS is exclusive, OpenHolidays endDate seems inclusive.
    // Let's add one day to endDate.
    const endObj = new Date(holiday.endDate);
    endObj.setDate(endObj.getDate() + 1);
    const end = endObj.toISOString().slice(0, 10).replace(/-/g, '');

    lines.push(
      'BEGIN:VEVENT',
      `UID:openholidays-${holiday.id}@makeics.local`,
      `DTSTAMP:${result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${escapeText(holiday.name)}`,
      `DESCRIPTION:${escapeText(`${holiday.name} (${holiday.type || 'Holiday'})`)}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
