import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseApiTimestamp, formatTimeForTimezone } from './utils/date.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data/sports');
const SUPPLEMENTAL_DATA_DIR = path.join(DATA_DIR, 'supplemental');
const SPORTSDB_BASE_URL = 'https://www.thesportsdb.com/api/v1/json/3';
const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';
const FEED_REFRESH_INTERVAL = 'PT24H';
const MAX_SUGGESTIONS = 8;

const SPORTS_EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    games: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'The date of the game, preferably in YYYY-MM-DD format' },
          time: { type: 'string', description: 'The time of the game, preferably in HH:mm format' },
          name: { type: 'string', description: 'The full name of the event (e.g. Team A vs Team B)' },
          homeTeam: { type: 'string', description: 'The name of the home team' },
          awayTeam: { type: 'string', description: 'The name of the away team' },
          venue: { type: 'string', description: 'The name of the stadium or venue' },
          league: { type: 'string', description: 'The name of the league or competition' }
        },
        required: ['date', 'name']
      }
    }
  },
  required: ['games']
};

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

export function normalizeScrapedEvent(game, teamName) {
  // Generate a stable ID based on date and name if missing
  const id = `scraped-${game.date}-${game.name}`.toLowerCase().replace(/[^a-z0-9]/g, '-');

  // Normalize time to HH:mm:ss
  let normalizedTime = '00:00:00';
  if (game.time) {
    if (/^\d{2}:\d{2}:\d{2}$/.test(game.time)) {
      normalizedTime = game.time;
    } else if (/^\d{2}:\d{2}$/.test(game.time)) {
      normalizedTime = `${game.time}:00`;
    }
  }

  // Attempt to construct a timestamp if date and time are present
  let timestamp = null;
  if (game.date && /^\d{4}-\d{2}-\d{2}$/.test(game.date)) {
    timestamp = `${game.date}T${normalizedTime}Z`;
  }

  return {
    idEvent: id,
    strEvent: game.name,
    strHomeTeam: game.homeTeam || (game.name.toLowerCase().startsWith(teamName.toLowerCase()) ? teamName : null),
    strAwayTeam: game.awayTeam || (game.name.toLowerCase().endsWith(teamName.toLowerCase()) ? teamName : null),
    dateEvent: game.date,
    strTime: normalizedTime,
    strTimestamp: timestamp,
    strLeague: game.league || null,
    strVenue: game.venue || null,
    strStatus: 'NS',
    source: 'scraped'
  };
}

export async function fetchScheduleFromWebsite(websiteUrl, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!env.FIRECRAWL_API_KEY) {
    throw new Error('FIRECRAWL_API_KEY is required for scraping.');
  }

  const url = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
  const controller = new AbortController();
  const timeoutMs = parseInt(env.FIRECRAWL_TIMEOUT_MS, 10) || 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(env.FIRECRAWL_API_URL || FIRECRAWL_SCRAPE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'MakeICS-Sports-Schedules/1.0'
      },
      body: JSON.stringify({
        url,
        formats: ['extract'],
        extract: {
          schema: SPORTS_EXTRACT_SCHEMA,
          prompt: 'Extract the upcoming games schedule. Include up to 200 games if available. Focus on game date, time, opponent, and venue.'
        },
        onlyMainContent: true,
        maxAge: 86_400_000
      })
    });

    if (!response.ok) {
      throw new Error(`Firecrawl returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    const games = payload?.data?.extract?.games || payload?.extract?.games || [];

    return games;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Firecrawl request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchScheduleFromESPN(leagueSlug, teamSlug, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!env.FIRECRAWL_API_KEY) {
    throw new Error('FIRECRAWL_API_KEY is required for ESPN scraping.');
  }

  const url = `https://www.espn.com/${leagueSlug}/team/schedule/_/name/${teamSlug}`;
  const controller = new AbortController();
  const timeoutMs = parseInt(env.FIRECRAWL_TIMEOUT_MS, 10) || 15000; // ESPN pages might be heavier
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(env.FIRECRAWL_API_URL || FIRECRAWL_SCRAPE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'MakeICS-Sports-Schedules/1.0'
      },
      body: JSON.stringify({
        url,
        formats: ['extract'],
        extract: {
          schema: SPORTS_EXTRACT_SCHEMA,
          prompt: 'Extract the full upcoming season schedule for this team. Include every game up to 200. Focus on date, time, opponent, and venue.'
        },
        onlyMainContent: true,
        maxAge: 21600000 // 6 hours in ms
      })
    });

    if (!response.ok) {
      throw new Error(`Firecrawl returned HTTP ${response.status} for ESPN scrape`);
    }

    const payload = await response.json();
    const games = payload?.data?.extract?.games || payload?.extract?.games || [];

    return games;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`ESPN scrape request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}


async function loadCachedLeagueEvents(leagueId) {
  try {
    const filePath = path.join(DATA_DIR, `${leagueId}.json`);
    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    return data.events || [];
  } catch (error) {
    // Cache miss or error reading file
    return null;
  }
}

async function loadSupplementalTeamEvents(teamId) {
  try {
    const filePath = path.join(SUPPLEMENTAL_DATA_DIR, `${teamId}.json`);
    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    return data.events || [];
  } catch (error) {
    return [];
  }
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
    // 1. Try local cache first
    const cachedEvents = await loadCachedLeagueEvents(leagueId);
    if (cachedEvents) {
      return cachedEvents.filter((e) => e.idHomeTeam === teamId || e.idAwayTeam === teamId);
    }

    // 2. Fallback to live API
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
  const nextEventsPromise = fetchJson(nextEventsUrl, fetchImpl)
    .then((data) => data.events || [])
    .catch((error) => {
      console.error(`Failed to fetch next events for team ${teamId}:`, error);
      return [];
    });

  const supplementalEventsPromise = loadSupplementalTeamEvents(teamId);

  const allEventsResults = await Promise.all([
    ...leagueSeasonPromises,
    nextEventsPromise,
    supplementalEventsPromise
  ]);
  const flatEvents = allEventsResults.flat();

  // Deduplicate by idEvent
  const seenIds = new Set();
  const uniqueEvents = [];
  for (const event of flatEvents) {
    if (event && event.idEvent && !seenIds.has(event.idEvent)) {
      seenIds.add(event.idEvent);
      uniqueEvents.push(normalizeEvent(event));
    }
  }

  // Filter for upcoming events (include ongoing events started in the last 3 hours)
  const now = new Date();
  const threeHoursAgo = new Date(now.getTime() - 180 * 60 * 1000);
  const upcomingEvents = uniqueEvents
    .filter((event) => {
      const eventDate = parseApiTimestamp(event.timestamp, event.date, event.time);
      return eventDate >= threeHoursAgo;
    })
    .sort((a, b) => {
      const dateA = parseApiTimestamp(a.timestamp, a.date, a.time);
      const dateB = parseApiTimestamp(b.timestamp, b.date, b.time);
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

  const getDuration = (sport) => {
    switch (sport?.toLowerCase()) {
      case 'american football':
      case 'baseball':
        return 180;
      case 'basketball':
      case 'ice hockey':
        return 150;
      case 'soccer':
        return 110;
      default:
        return 120;
    }
  };

  for (const event of result.events) {
    const startDate = parseApiTimestamp(event.timestamp, event.date, event.time);
    const start = formatIcsDateTime(startDate);
    const durationMinutes = getDuration(result.team.sport);
    const endDate = new Date(startDate.getTime() + durationMinutes * 60_000);
    const end = formatIcsDateTime(endDate);

    const timesString = formatTimeForTimezone(startDate, timezone);

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
