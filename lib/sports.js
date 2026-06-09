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

  const leagueIds = [
    team.idLeague,
    team.idLeague2,
    team.idLeague3,
    team.idLeague4,
    team.idLeague5,
    team.idLeague6,
    team.idLeague7
  ].filter(Boolean);

  const leagueSeasonPromises = leagueIds.map(async (leagueId) => {
    try {
      const leagueUrl = `${SPORTSDB_BASE_URL}/lookupleague.php?id=${encodeURIComponent(leagueId)}`;
      const leagueData = await fetchJson(leagueUrl, fetchImpl);
      const league = leagueData.leagues ? leagueData.leagues[0] : null;
      if (league && league.strCurrentSeason) {
        const seasonUrl = `${SPORTSDB_BASE_URL}/eventsseason.php?id=${encodeURIComponent(leagueId)}&s=${encodeURIComponent(league.strCurrentSeason)}`;
        const seasonData = await fetchJson(seasonUrl, fetchImpl);
        return (seasonData.events || []).filter((e) => e.idHomeTeam === teamId || e.idAwayTeam === teamId);
      }
    } catch (error) {
      console.error(`Failed to fetch season events for league ${leagueId}:`, error);
    }
    return [];
  });

  const nextEventsUrl = `${SPORTSDB_BASE_URL}/eventsnext.php?id=${encodeURIComponent(teamId)}`;
  const nextEventsPromise = fetchJson(nextEventsUrl, fetchImpl).then((data) => data.events || []);

  const allEventsResults = await Promise.all([...leagueSeasonPromises, nextEventsPromise]);
  const flatEvents = allEventsResults.flat();

  // Deduplicate by idEvent
  const seenIds = new Set();
  const uniqueEvents = [];
  for (const event of flatEvents) {
    if (!seenIds.has(event.idEvent)) {
      seenIds.add(event.idEvent);
      uniqueEvents.push(normalizeEvent(event));
    }
  }

  // Filter for upcoming events (same logic as before: today or later)
  const now = new Date();
  const upcomingEvents = uniqueEvents
    .filter((event) => {
      const eventDate = event.timestamp ? new Date(event.timestamp + (event.timestamp.includes('Z') || /[-+]\d{2}:?\d{2}$/.test(event.timestamp) ? '' : 'Z')) : new Date(`${event.date}T${event.time || '00:00:00'}Z`);
      return eventDate >= now;
    })
    .sort((a, b) => {
      const dateA = a.timestamp ? new Date(a.timestamp) : new Date(a.date);
      const dateB = b.timestamp ? new Date(b.timestamp) : new Date(b.date);
      return dateA - dateB;
    });

  return {
    team: normalizeTeamSuggestion(team),
    events: upcomingEvents,
    generatedAt: now.toISOString()
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
