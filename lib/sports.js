const SPORTSDB_BASE_URL = 'https://www.thesportsdb.com/api/v1/json/3';
const FEED_REFRESH_INTERVAL = 'PT24H';
const MAX_SUGGESTIONS = 8;

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'MakeICS-Sports-Schedules/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

function normalizeTeamSuggestion(team) {
  return {
    id: team.idTeam,
    name: team.strTeam,
    sport: team.strSport,
    league: team.strLeague,
    country: team.strCountry,
    image: team.strBadge,
    website: team.strWebsite,
    summary: team.strDescriptionEN ? team.strDescriptionEN.slice(0, 200) + '...' : null
  };
}

export async function searchTeamSuggestions({ query, fetchImpl = globalThis.fetch } = {}) {
  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  if (trimmedQuery.length < 2) {
    return [];
  }

  const url = `${SPORTSDB_BASE_URL}/searchteams.php?t=${encodeURIComponent(trimmedQuery)}`;
  const data = await fetchJson(url, fetchImpl);
  return (data.teams || []).slice(0, MAX_SUGGESTIONS).map(normalizeTeamSuggestion);
}

function normalizeEvent(event) {
  return {
    id: event.idEvent,
    name: event.strEvent,
    homeTeam: event.strHomeTeam,
    awayTeam: event.strAwayTeam,
    date: event.dateEvent,
    time: event.strTime,
    timestamp: event.strTimestamp, // Usually ISO-like e.g. "2026-08-05T18:30:00"
    league: event.strLeague,
    venue: event.strVenue,
    status: event.strStatus
  };
}

export async function getUpcomingEvents({ teamId, fetchImpl = globalThis.fetch } = {}) {
  if (!teamId) {
    throw new Error('A team ID is required.');
  }

  const teamUrl = `${SPORTSDB_BASE_URL}/lookupteam.php?id=${encodeURIComponent(teamId)}`;
  const teamData = await fetchJson(teamUrl, fetchImpl);
  const team = teamData.teams ? teamData.teams[0] : null;

  if (!team) {
    throw new Error('Team not found.');
  }

  const eventsUrl = `${SPORTSDB_BASE_URL}/eventsnext.php?id=${encodeURIComponent(teamId)}`;
  const eventsData = await fetchJson(eventsUrl, fetchImpl);
  const events = (eventsData.events || []).map(normalizeEvent);

  return {
    team: normalizeTeamSuggestion(team),
    events,
    generatedAt: new Date().toISOString()
  };
}

export function toIcs(result) {
  const escapeText = (value) => String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');

  const formatDateTime = (event) => {
    // strTimestamp might be "2026-08-05T18:30:00"
    // We should assume UTC or local depending on API, but for ICS we usually want UTC if possible.
    // TheSportsDB often provides UTC or localized time. Let's try to parse it.
    const date = new Date(event.timestamp || `${event.date}T${event.time || '00:00:00'}Z`);
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MakeICS//Sports Upcoming Events//EN',
    'CALSCALE:GREGORIAN',
    `X-PUBLISHED-TTL:${FEED_REFRESH_INTERVAL}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${FEED_REFRESH_INTERVAL}`
  ];

  for (const event of result.events) {
    const start = formatDateTime(event);
    // Sports events typically last 2-3 hours. Let's assume 2 hours (120 min).
    const durationMinutes = 120;
    const startDate = new Date(event.timestamp || `${event.date}T${event.time || '00:00:00'}Z`);
    const end = new Date(startDate.getTime() + durationMinutes * 60_000)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');

    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(startDate);
    const pt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(startDate);

    lines.push(
      'BEGIN:VEVENT',
      `UID:sportsdb-${event.id}@makeics.local`,
      `DTSTAMP:${result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${escapeText(event.name)}`,
      `DESCRIPTION:${escapeText(`${event.name} - ${event.league}. Venue: ${event.venue || 'TBA'}. Times: ${et} / ${pt}`)}`,
      `LOCATION:${escapeText(event.venue || '')}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
