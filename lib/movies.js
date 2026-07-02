import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOVIES_DATA_FILE = path.join(__dirname, 'data/movies/upcoming.json');
const FEED_REFRESH_INTERVAL = 'PT24H';

async function loadMovieData(fsImpl = fs) {
  try {
    const content = await fsImpl.readFile(MOVIES_DATA_FILE, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error loading movie data:', error);
    return { movies: [] };
  }
}

export async function searchMovieSuggestions({ query, type = 'all', fsImpl = fs } = {}) {
  const trimmedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (trimmedQuery.length < 2) {
    return [];
  }

  const { movies } = await loadMovieData(fsImpl);
  const suggestions = [];
  const seenNames = new Set();

  // 1. Collect specific suggestions based on type
  if (type === 'genre') {
    const genres = new Set();
    for (const m of movies) {
      for (const g of m.genres) {
        if (typeof g === 'string' && g.toLowerCase().includes(trimmedQuery)) genres.add(g);
      }
    }
    for (const g of Array.from(genres).sort()) {
      suggestions.push({ id: `genre-${g}`, name: g, category: 'Genre' });
      seenNames.add(g.toLowerCase());
    }
  } else if (type === 'character' || type === 'people') {
    const people = new Map();
    for (const m of movies) {
      for (const p of m.people) {
        if (p.name.toLowerCase().includes(trimmedQuery)) {
          people.set(p.name, p.id);
        }
      }
    }
    const sortedNames = Array.from(people.keys()).sort();
    for (const name of sortedNames) {
      suggestions.push({ id: people.get(name), name: name, category: 'Person' });
      seenNames.add(name.toLowerCase());
    }
  } else if (type === 'studio') {
    // As per reviewer: normalize/map 'studio' search to same handling as getMovies (searching titles/genres/people)
    for (const movie of movies) {
      const titleMatch = movie.title.toLowerCase().includes(trimmedQuery);
      const genreMatch = movie.genres.some(g => g.toLowerCase().includes(trimmedQuery));
      const peopleMatch = movie.people.some(p => p.name.toLowerCase().includes(trimmedQuery));

      if ((titleMatch || genreMatch || peopleMatch) && !seenNames.has(movie.title.toLowerCase())) {
        suggestions.push({
          id: movie.id,
          name: movie.title,
          releaseDate: movie.label,
          image: movie.image,
          genres: movie.genres,
          people: movie.people.map(p => typeof p === 'string' ? p : p.name),
          category: 'Movie'
        });
        seenNames.add(movie.title.toLowerCase());
      }
      if (suggestions.length >= 8) break;
    }
    return suggestions;
  }

  // 2. Always include movie titles that match
  for (const movie of movies) {
    if (movie.title.toLowerCase().includes(trimmedQuery) && !seenNames.has(movie.title.toLowerCase())) {
      suggestions.push({
        id: movie.id,
        name: movie.title,
        releaseDate: movie.label,
        image: movie.image,
        genres: movie.genres,
        people: movie.people.map(p => typeof p === 'string' ? p : p.name),
        category: 'Movie'
      });
      seenNames.add(movie.title.toLowerCase());
    }
    if (suggestions.length >= 15) break;
  }

  return suggestions.slice(0, 8);
}

/**
 * @param {Object} options
 * @param {string} [options.type] - Search type: 'all', 'movie', 'genre', 'character', 'people', or 'studio' (alias for general search).
 * @param {string} [options.query]
 * @param {string} [options.since]
 * @param {Date} [options.now]
 */
export async function getMovies({ type = 'all', query = '', since = null, now = new Date(), fsImpl = fs } = {}) {
  const { movies, generatedAt: storedGeneratedAt } = await loadMovieData(fsImpl);
  const trimmedQuery = query.trim().toLowerCase();

  let filtered = movies;

  if (trimmedQuery) {
    filtered = movies.filter(movie => {
      const titleMatch = movie.title.toLowerCase().includes(trimmedQuery);
      const genreMatch = movie.genres.some(g => g.toLowerCase().includes(trimmedQuery));
      const peopleMatch = movie.people.some(p => p.name.toLowerCase().includes(trimmedQuery) || p.id === query);

      // We allow titleMatch as a fallback for all types so that if a user selects
      // a specific movie from suggestions, it still returns that movie regardless of filter type.
      if (type === 'movie') return titleMatch;
      if (type === 'genre') return genreMatch || titleMatch;
      if (type === 'character' || type === 'people') return peopleMatch || titleMatch;
      // 'studio' is supported as an alias for a general title/genre/people search
      if (type === 'studio') return titleMatch || genreMatch || peopleMatch;
      return titleMatch || genreMatch || peopleMatch;
    });
  }

  if (since) {
    const sinceTime = Date.parse(since);
    if (!Number.isNaN(sinceTime)) {
      filtered = filtered.filter(m => {
        const releaseTime = Date.parse(m.releaseDate);
        return isNaN(releaseTime) || releaseTime >= sinceTime;
      });
    }
  }

  let personMetadata = null;
  if ((type === 'character' || type === 'people') && trimmedQuery) {
    personMetadata = await fetchIMDbPersonMetadata(trimmedQuery);
  }

  return {
    query,
    type,
    personMetadata,
    generatedAt: storedGeneratedAt || now.toISOString(),
    movies: filtered.map(m => {
        const date = m.releaseDate ? new Date(m.releaseDate) : null;
        const validDate = date && !isNaN(date.getTime());
        return {
            ...m,
            date: validDate ? date.toISOString().split('T')[0] : null,
            people: m.people.map(p => p.name) // Backwards compatibility for UI/ICS for now
        };
    })
  };
}

/**
 * Fetches person metadata from IMDb suggestions API.
 * @param {string} query
 */
async function fetchIMDbPersonMetadata(query) {
    try {
        const suggestUrl = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(query.trim()).toLowerCase()}.json`;
        const response = await fetch(suggestUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        });
        if (!response.ok) return null;
        const data = await response.json();
        // Return the first person match
        const person = data.d?.find(item => item.id.startsWith('nm'));
        if (person) {
            return {
                id: person.id,
                name: person.l,
                image: person.i?.imageUrl,
                description: person.s
            };
        }
    } catch (e) {
        console.error('Error fetching person metadata:', e);
    }
    return null;
}

export function toIcs(result) {
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
    'PRODID:-//MakeICS//Movie Releases//EN',
    'CALSCALE:GREGORIAN',
    `X-PUBLISHED-TTL:${FEED_REFRESH_INTERVAL}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${FEED_REFRESH_INTERVAL}`
  ];

  for (const movie of result.movies) {
    const releaseDate = movie.releaseDate ? new Date(movie.releaseDate) : null;
    if (!releaseDate || isNaN(releaseDate.getTime())) continue;

    // Set to all-day event or 12 PM UTC
    const start = formatIcsDateTime(releaseDate).slice(0, 8); // YYYYMMDD

    const trailerUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(movie.title + ' trailer')}`;
    const ticketsUrl = `https://www.google.com/search?q=${encodeURIComponent(movie.title + ' tickets')}`;

    const descriptionParts = [
        `Movie: ${movie.title}`,
        movie.genres.length ? `Genres: ${movie.genres.join(', ')}` : '',
        movie.people.length ? `Cast/Crew: ${movie.people.join(', ')}` : '',
        `IMDb: https://www.imdb.com/title/${movie.id}/`,
        `Trailer: ${trailerUrl}`,
        `Tickets: ${ticketsUrl}`
    ].filter(Boolean);

    lines.push(
      'BEGIN:VEVENT',
      `UID:imdb-movie-${movie.id}@makeics.local`,
      `DTSTAMP:${result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
      `DTSTART;VALUE=DATE:${start}`,
      `SUMMARY:${escapeText(movie.title)} (Movie Release)`,
      `DESCRIPTION:${escapeText(descriptionParts.join('\n'))}`,
      `URL:https://www.imdb.com/title/${movie.id}/`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
