/**
 * Validates if a string is a valid IANA timezone identifier.
 * @param {string} timezone
 * @returns {boolean}
 */
export function isValidTimezone(timezone) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Parses an API timestamp or date/time combination into a UTC Date object.
 * Appends 'Z' if the timestamp lacks a timezone offset.
 * @param {string} timestamp
 * @param {string} [date]
 * @param {string} [time]
 * @returns {Date}
 */
export function parseApiTimestamp(timestamp, date, time) {
  if (timestamp) {
    const needsZ = !timestamp.includes('Z') && !/[-+]\d{2}:?\d{2}$/.test(timestamp);
    return new Date(timestamp + (needsZ ? 'Z' : ''));
  }
  return new Date(`${date}T${time || '00:00:00'}Z`);
}

/**
 * Formats a date for a specific timezone with ET/PT fallbacks for descriptions.
 * @param {Date} date
 * @param {string} timezone
 * @returns {string}
 */
export function formatTimeForTimezone(date, timezone = 'UTC') {
  const safeTimezone = isValidTimezone(timezone) ? timezone : 'UTC';
  const timeOptions = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };

  const userTime = new Intl.DateTimeFormat('en-US', { ...timeOptions, timeZone: safeTimezone }).format(date);
  const et = new Intl.DateTimeFormat('en-US', { ...timeOptions, timeZone: 'America/New_York' }).format(date);
  const pt = new Intl.DateTimeFormat('en-US', { ...timeOptions, timeZone: 'America/Los_Angeles' }).format(date);

  let timesString = `${et} / ${pt}`;
  if (safeTimezone !== 'America/New_York' && safeTimezone !== 'America/Los_Angeles' && safeTimezone !== 'UTC') {
    timesString = `${userTime} (${timesString})`;
  } else if (safeTimezone === 'UTC') {
    timesString = `${date.toISOString().slice(11, 16)} UTC (${timesString})`;
  }

  return timesString;
}
