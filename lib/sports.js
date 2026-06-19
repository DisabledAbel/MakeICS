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

const AF1_TEAMS = [
  {
    idTeam: '148343',
    strTeam: 'Albany Firebirds',
    strSport: 'American Football',
    strLeague: 'Arena Football One',
    strCountry: 'United States',
    strBadge: 'https://r2.thesportsdb.com/images/media/team/badge/imljhp1714485549.png',
    strWebsite: 'www.firebirdsaf1.com',
    strStadium: 'MVP Arena'
  },
  {
    idTeam: 'af1-beaumont',
    strTeam: 'Beaumont Renegades',
    strSport: 'American Football',
    strLeague: 'Arena Football One',
    strCountry: 'United States',
    strBadge: 'https://digitalshift-stats.us-lax-1.linodeobjects.com/ad3317b4-081f-4c3b-a534-8691cef753c4/team-logo_url-584761-beaumont-renegades-1775199498804024161-medium.png',
    strWebsite: 'www.beaumontrenegades.com',
    strStadium: 'Ford Arena'
  },
  {
    idTeam: 'af1-kentucky',
    strTeam: 'Kentucky Barrels',
    strSport: 'American Football',
    strLeague: 'Arena Football One',
    strCountry: 'United States',
    strBadge: 'https://digitalshift-stats.us-lax-1.linodeobjects.com/ad3317b4-081f-4c3b-a534-8691cef753c4/team-logo_url-584747-kentucky-barrels-1775199421568165423-medium.svg',
    strWebsite: 'www.kybarrelsfootball.com',
    strStadium: 'Owensboro Sportscenter'
  },
  {
    idTeam: 'af1-michigan',
    strTeam: 'Michigan Arsenal',
    strSport: 'American Football',
    strLeague: 'Arena Football One',
    strCountry: 'United States',
    strBadge: 'https://digitalshift-stats.us-lax-1.linodeobjects.com/ad3317b4-081f-4c3b-a534-8691cef753c4/team-logo_url-606163-michigan-arsenal-1775199519968766517-medium.png',
    strWebsite: 'michiganarsenal.com',
    strStadium: 'The Dow Event Center'
  },
  {
    idTeam: 'af1-minnesota',
    strTeam: 'Minnesota Monsters',
    strSport: 'American Football',
    strLeague: 'Arena Football One',
    strCountry: 'United States',
    strBadge: 'https://digitalshift-stats.us-lax-1.linodeobjects.com/ad3317b4-081f-4c3b-a534-8691cef753c4/team-logo_url-602555-minnesota-monsters-1775199675209750691-medium.svg',
    strWebsite: 'mnmonsters.com',
    strStadium: 'Amsoil Arena'
  },
  {
    idTeam: '148348',
    strTeam: 'Nashville Kats',
    strSport: 'American Football',
    strLeague: 'Arena Football One',
    strCountry: 'United States',
    strBadge: 'https://r2.thesportsdb.com/images/media/team/badge/rc3lby1714485564.png',
    strWebsite: 'www.nashvillekats.com',
    strStadium: 'F&M Bank Arena'
  },
  {
    idTeam: 'af1-oceanside',
    strTeam: 'Oceanside Bombers',
    strSport: 'American Football',
    strLeague: 'Arena Football One',
    strCountry: 'United States',
    strBadge: 'https://digitalshift-stats.us-lax-1.linodeobjects.com/ad3317b4-081f-4c3b-a534-8691cef753c4/team-logo_url-612138-oceanside-bombers-1775999364645727762-medium.svg',
    strWebsite: 'oceansidebombers.com',
    strStadium: 'Frontwave Arena'
  },
  {
    idTeam: '148353',
    strTeam: 'Washington Wolfpack',
    strSport: 'American Football',
    strLeague: 'Arena Football One',
    strCountry: 'United States',
    strBadge: 'https://r2.thesportsdb.com/images/media/team/badge/hpuza21714485579.png',
    strWebsite: 'www.washingtonwolfpack.com',
    strStadium: 'Angel of the Winds Arena'
  }
];

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
    stadium: team.strStadium,
    summary: team.strDescriptionEN ? team.strDescriptionEN.slice(0, 200) + '...' : null
  };
}

export async function searchTeamSuggestions({ query, fetchImpl = globalThis.fetch } = {}) {
  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  if (trimmedQuery.length < 2) {
    return [];
  }

  const af1Matches = AF1_TEAMS.filter(t =>
    t.strTeam.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
    t.strLeague.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
    (trimmedQuery.toLowerCase() === 'af1')
  );

  const url = `${SPORTSDB_BASE_URL}/searchteams.php?t=${encodeURIComponent(trimmedQuery)}`;
  const data = await fetchJson(url, fetchImpl);
  const tsdbTeams = (data.teams || []).map(normalizeTeamSuggestion);

  // Merge, prioritizing AF1 exact or strong matches
  const merged = [
    ...af1Matches.map(normalizeTeamSuggestion),
    ...tsdbTeams.filter(t => !af1Matches.some(af1 => af1.idTeam === t.id))
  ];

  return merged.slice(0, MAX_SUGGESTIONS);
}

function normalizeEvent(event) {
  return {
    id: event.idEvent,
    name: event.strEvent,
    homeTeam: event.strHomeTeam,
    awayTeam: event.strAwayTeam,
    idHomeTeam: event.idHomeTeam,
    idAwayTeam: event.idAwayTeam,
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
  let timestamp = null;

  // 1. Check if date or time are already ISO strings
  if (game.date?.includes('T')) {
    timestamp = game.date;
  } else if (game.time?.includes('T')) {
    timestamp = game.time;
  }

  if (timestamp) {
    // Extract time from timestamp if possible
    const tIdx = timestamp.indexOf('T');
    if (tIdx !== -1) {
      normalizedTime = timestamp.substring(tIdx + 1).replace('Z', '');
      if (normalizedTime.length === 5) normalizedTime += ':00';
    }
  } else if (game.time) {
    if (/^\d{2}:\d{2}:\d{2}$/.test(game.time)) {
      normalizedTime = game.time;
    } else if (/^\d{2}:\d{2}$/.test(game.time)) {
      normalizedTime = `${game.time}:00`;
    }
  }

  // 2. Attempt to construct a timestamp if date and time are present
  if (!timestamp && game.date && /^\d{4}-\d{2}-\d{2}$/.test(game.date)) {
    timestamp = `${game.date}T${normalizedTime}Z`;
  }

  const homeTeam = game.homeTeam || (game.name.toLowerCase().startsWith(teamName.toLowerCase()) ? teamName : null);
  const awayTeam = game.awayTeam || (game.name.toLowerCase().endsWith(teamName.toLowerCase()) ? teamName : null);

  let eventName = game.name;
  if (homeTeam && awayTeam && (eventName.toLowerCase().startsWith('vs ') || eventName.toLowerCase().startsWith('at '))) {
    eventName = `${homeTeam} vs ${awayTeam}`;
  }

  return {
    idEvent: id,
    strEvent: eventName,
    strHomeTeam: homeTeam,
    strAwayTeam: awayTeam,
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

export async function getEvents({ teamId, now = new Date(), since = null, fetchImpl = globalThis.fetch } = {}) {
  if (!teamId) {
    throw new Error('A team ID is required.');
  }

  let team = null;
  const af1Team = AF1_TEAMS.find(t => t.idTeam === teamId);

  if (af1Team) {
    team = af1Team;
  } else {
    const teamUrl = `${SPORTSDB_BASE_URL}/lookupteam.php?id=${encodeURIComponent(teamId)}`;
    const teamData = await fetchJson(teamUrl, fetchImpl);
    team = teamData.teams ? teamData.teams[0] : null;
  }

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

  // Deduplicate by idEvent and content (timestamp + teams)
  const seenIds = new Set();
  const seenContent = new Set();
  const uniqueEvents = [];
  for (const event of flatEvents) {
    if (event && event.idEvent) {
      const normalized = normalizeEvent(event);
      const timestamp = parseApiTimestamp(normalized.timestamp, normalized.date, normalized.time).getTime();
      const teams = [normalized.homeTeam, normalized.awayTeam].filter(Boolean).sort().join('|');
      const contentKey = `${timestamp}-${teams}`;

      if (!seenIds.has(event.idEvent) && !seenContent.has(contentKey)) {
        seenIds.add(event.idEvent);
        seenContent.add(contentKey);
        uniqueEvents.push(normalized);
      }
    }
  }

  let sortedEvents = uniqueEvents
    .sort((a, b) => {
      const dateA = parseApiTimestamp(a.timestamp, a.date, a.time);
      const dateB = parseApiTimestamp(b.timestamp, b.date, b.time);
      return dateA - dateB;
    });

  if (since) {
    const sinceTime = Date.parse(since);
    if (!Number.isNaN(sinceTime)) {
      sortedEvents = sortedEvents.filter((e) => {
        const timestamp = parseApiTimestamp(e.timestamp, e.date, e.time);
        return timestamp.getTime() >= sinceTime;
      });
    }
  }

  const normalizedTeam = normalizeTeamSuggestion(team);

  // Fill in missing venues with team stadium if it's a home game
  for (const event of sortedEvents) {
    const normalizedVenue = (event.venue || '').trim().toLowerCase();
    const isMissingVenue = !normalizedVenue || ['tba', 'tbd', 'to be determined'].includes(normalizedVenue);
    if (isMissingVenue && normalizedTeam.stadium) {
      const isHomeGame = event.idHomeTeam === teamId ||
                         (event.homeTeam && event.homeTeam.toLowerCase().trim() === normalizedTeam.name.toLowerCase().trim());
      if (isHomeGame) {
        event.venue = normalizedTeam.stadium;
      }
    }
  }

  return {
    team: normalizedTeam,
    events: sortedEvents,
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
    'PRODID:-//MakeICS//Sports Events//EN',
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
      `DESCRIPTION:${escapeText(`${event.name} - ${event.league}. Venue: ${event.venue || 'TBD'}. Time: ${timesString}`)}`,
      `LOCATION:${escapeText(event.venue || '')}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
