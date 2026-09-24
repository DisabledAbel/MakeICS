const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;

function validParts(parts, hasTime) {
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts.map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day && (!hasTime || (value.getUTCHours() === hour &&
      value.getUTCMinutes() === minute && value.getUTCSeconds() === second));
}

export function validateIcalendar(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('response body is empty');
  const physicalLines = input.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  while (physicalLines.at(-1) === '') physicalLines.pop();
  const lines = [];
  for (const line of physicalLines) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR') {
    throw new Error('body is not a complete VCALENDAR');
  }
  if (!lines.includes('VERSION:2.0')) throw new Error('VCALENDAR is missing VERSION:2.0');

  let inEvent = false;
  let eventNumber = 0;
  let eventStart = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      if (inEvent) throw new Error('nested VEVENT is invalid');
      inEvent = true;
      eventNumber += 1;
      eventStart = null;
    } else if (line === 'END:VEVENT') {
      if (!inEvent) throw new Error('END:VEVENT has no matching BEGIN:VEVENT');
      if (!eventStart) throw new Error(`event ${eventNumber} is missing DTSTART`);
      inEvent = false;
    } else if (inEvent && /^DT(?:START|END)(?:;[^:]*)?:/.test(line)) {
      const separator = line.indexOf(':');
      const parameters = line.slice(0, separator);
      const property = parameters.split(';', 1)[0];
      const raw = line.slice(separator + 1);
      const isDate = /(?:^|;)VALUE=DATE(?:;|$)/i.test(parameters);
      const match = raw.match(isDate ? DATE_PATTERN : DATE_TIME_PATTERN);
      if (!match || !validParts(match.slice(1, isDate ? 4 : 7), !isDate)) {
        throw new Error(`event ${eventNumber} has invalid ${property}: ${raw || '(empty)'}`);
      }
      if (!isDate && !match[7]) {
        const timezone = parameters.match(/(?:^|;)TZID=([^;:]+)/i)?.[1];
        if (!timezone) throw new Error(`event ${eventNumber} has a floating ${property} without TZID`);
        try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
        catch { throw new Error(`event ${eventNumber} has invalid ${property} timezone: ${timezone}`); }
      }
      if (property === 'DTSTART') eventStart = raw;
    }
  }
  if (inEvent) throw new Error('VEVENT is not closed');
  return { eventCount: eventNumber };
}

export async function checkFeed(feed, { baseUrl, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const url = new URL(feed.path, baseUrl).href;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'text/calendar', 'user-agent': 'MakeICS-feed-health/1.0' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    const body = await response.text();
    const parsed = validateIcalendar(body);
    return { name: feed.name, url, ok: true, ...parsed };
  } catch (error) {
    const reason = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? `request timed out after ${timeoutMs}ms`
      : error.message;
    return { name: feed.name, url, ok: false, reason };
  }
}

export async function checkFeeds(feeds, options) {
  return Promise.all(feeds.map(feed => checkFeed(feed, options)));
}
