const SPORTSDB_BASE_URL = 'https://www.thesportsdb.com/api/v1/json/3';
const FEED_REFRESH_INTERVAL = 'PT12H';
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

  const eventPromises = [];

  // 1. Get explicitly "next" events for the team (includes friendlies, etc.)
  const nextEventsUrl = `${SPORTSDB_BASE_URL}/eventsnext.php?id=${encodeURIComponent(teamId)}`;
  eventPromises.push(fetchJson(nextEventsUrl, fetchImpl).then(data => data.events || []));

  // 2. Try to get the full season schedule from all associated leagues
  const leagueIds = [team.idLeague, team.idLeague2, team.idLeague3, team.idLeague4, team.idLeague5, team.idLeague6, team.idLeague7]
    .filter(id => id && id !== '0');

  for (const lId of leagueIds) {
    const leagueUrl = `${SPORTSDB_BASE_URL}/lookupleague.php?id=${encodeURIComponent(lId)}`;
    const leaguePromise = fetchJson(leagueUrl, fetchImpl).then(async (leagueData) => {
      const league = leagueData.leagues ? leagueData.leagues[0] : null;
      if (league && league.strCurrentSeason) {
        const seasonUrl = `${SPORTSDB_BASE_URL}/eventsseason.php?id=${encodeURIComponent(lId)}&s=${encodeURIComponent(league.strCurrentSeason)}`;
        const seasonData = await fetchJson(seasonUrl, fetchImpl);
        return (seasonData.events || []).filter(e => e.idHomeTeam === teamId || e.idAwayTeam === teamId);
      }
      return [];
    }).catch(() => []); // Ignore errors for league/season lookup to ensure we still return nextEvents
    eventPromises.push(leaguePromise);
  }

  const results = await Promise.all(eventPromises);
  const rawEvents = results.flat();

  // De-duplicate by idEvent
  const seenIds = new Set();
  const events = [];
  for (const e of rawEvents) {
    if (!seenIds.has(e.idEvent)) {
      seenIds.add(e.idEvent);
      events.push(normalizeEvent(e));
    }
  }

  // Sort by timestamp/date
  events.sort((a, b) => {
    const timeA = a.timestamp ? new Date(a.timestamp).getTime() : new Date(a.date).getTime();
    const timeB = b.timestamp ? new Date(b.timestamp).getTime() : new Date(b.date).getTime();
    return timeA - timeB;
  });

  return {
    team: normalizeTeamSuggestion(team),
    events,
    generatedAt: new Date().toISOString()
  };
}

export function toIcs(result, { timezone = 'UTC' } = {}) {
  const escapeText = (value) => String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');

  const parseAsUtc = (timestamp, date, time) => {
    if (timestamp) {
      // If it doesn't end with Z or have an offset, append Z for UTC
      const suffix = (timestamp.includes('Z') || /[-+]\d{2}:?\d{2}$/.test(timestamp)) ? '' : 'Z';
      return new Date(timestamp + suffix);
    }
    return new Date(`${date}T${time || '00:00:00'}Z`);
  };

  const formatIcsDateTime = (date) => {
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
    const startDate = parseAsUtc(event.timestamp, event.date, event.time);
    const start = formatIcsDateTime(startDate);
    // Sports events typically last 2-3 hours. Let's assume 2 hours (120 min).
    const durationMinutes = 120;
    const endDate = new Date(startDate.getTime() + durationMinutes * 60_000);
    const end = formatIcsDateTime(endDate);

    const timeOptions = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
    const userTime = new Intl.DateTimeFormat('en-US', { ...timeOptions, timeZone: timezone }).format(startDate);
    const et = new Intl.DateTimeFormat('en-US', { ...timeOptions, timeZone: 'America/New_York' }).format(startDate);
    const pt = new Intl.DateTimeFormat('en-US', { ...timeOptions, timeZone: 'America/Los_Angeles' }).format(startDate);

    let timesString = `${et} / ${pt}`;
    if (timezone !== 'America/New_York' && timezone !== 'America/Los_Angeles' && timezone !== 'UTC') {
      timesString = `${userTime} (${timesString})`;
    } else if (timezone === 'UTC') {
      timesString = `${startDate.toISOString().slice(11, 16)} UTC (${timesString})`;
    }

    lines.push(
      'BEGIN:VEVENT',
      `UID:sportsdb-${event.id}@makeics.local`,
      `DTSTAMP:${result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${escapeText(event.name)}`,
      `DESCRIPTION:${escapeText(`${event.name} - ${event.league}. Venue: ${event.venue || 'TBA'}. Time: ${timesString}`)}`,
      `LOCATION:${escapeText(event.venue || '')}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
