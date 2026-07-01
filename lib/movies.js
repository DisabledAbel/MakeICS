import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOVIES_DATA_FILE = path.join(__dirname, 'data/movies/upcoming.json');
const FEED_REFRESH_INTERVAL = 'PT24H';

async function loadMovieData() {
  try {
    const content = await fs.readFile(MOVIES_DATA_FILE, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error loading movie data:', error);
    return { movies: [] };
  }
}

export async function searchMovieSuggestions({ query, type = 'all' } = {}) {
  const trimmedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (trimmedQuery.length < 2) {
    return [];
  }

  const { movies } = await loadMovieData();
  const suggestions = new Map();

  for (const movie of movies) {
    let match = false;
    let category = 'Movie';

    if (type === 'all' || type === 'movie') {
      if (movie.title.toLowerCase().includes(trimmedQuery)) {
        match = true;
      }
    }

    if (!match && (type === 'all' || type === 'genre')) {
      const matchingGenre = movie.genres.find(g => g.toLowerCase().includes(trimmedQuery));
      if (matchingGenre) {
        match = true;
        category = 'Genre';
      }
    }

    if (!match && (type === 'all' || type === 'character' || type === 'people')) {
      const matchingPerson = movie.people.find(p => p.toLowerCase().includes(trimmedQuery));
      if (matchingPerson) {
        match = true;
        category = 'Person';
      }
    }

    if (match) {
      const id = movie.id;
      if (!suggestions.has(id)) {
        suggestions.set(id, {
          id: movie.id,
          name: movie.title,
          releaseDate: movie.label,
          image: movie.image,
          genres: movie.genres,
          people: movie.people,
          category
        });
      }
    }
  }

  return Array.from(suggestions.values()).slice(0, 8);
}

export async function getMovies({ type = 'all', query = '', since = null, now = new Date() } = {}) {
  const { movies, generatedAt } = await loadMovieData();
  const trimmedQuery = query.trim().toLowerCase();

  let filtered = movies;

  if (trimmedQuery) {
    filtered = movies.filter(movie => {
      const titleMatch = movie.title.toLowerCase().includes(trimmedQuery);
      const genreMatch = movie.genres.some(g => g.toLowerCase().includes(trimmedQuery));
      const peopleMatch = movie.people.some(p => p.toLowerCase().includes(trimmedQuery));

      if (type === 'movie') return titleMatch;
      if (type === 'genre') return genreMatch;
      if (type === 'character' || type === 'people') return peopleMatch;
      if (type === 'studio') return titleMatch || genreMatch || peopleMatch; // Fallback for studio
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

  return {
    query,
    type,
    generatedAt: now.toISOString(),
    movies: filtered.map(m => ({
        ...m,
        date: m.releaseDate ? new Date(m.releaseDate).toISOString().split('T')[0] : null
    }))
  };
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
