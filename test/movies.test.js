import test from 'node:test';
import assert from 'node:assert';
import { getMovies, searchMovieSuggestions, toIcs } from '../lib/movies.js';

const mockMovieData = {
  generatedAt: "2026-07-01T22:29:06.608Z",
  movies: [
    {
      id: "tt123",
      title: "Test Spider Movie",
      releaseDate: "2026-07-10",
      label: "Jul 10, 2026",
      genres: ["Action", "Animation"],
      people: ["Director Name", "Actor Name"],
      image: "http://example.com/img.jpg"
    },
    {
      id: "tt456",
      title: "Another Movie",
      releaseDate: "2026-08-15",
      label: "Aug 15, 2026",
      genres: ["Drama"],
      people: ["Some Director"],
      image: "http://example.com/img2.jpg"
    }
  ]
};

const mockFs = {
  readFile: async () => JSON.stringify(mockMovieData)
};

test('searchMovieSuggestions returns movie results from fixture', async () => {
  const query = 'Spider';
  const results = await searchMovieSuggestions({ query, fsImpl: mockFs });

  assert.ok(Array.isArray(results));
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, "Test Spider Movie");
});

test('getMovies returns filtered results from fixture', async () => {
  const query = 'Animation';
  const result = await getMovies({ type: 'genre', query, fsImpl: mockFs });

  assert.strictEqual(result.query, 'Animation');
  assert.strictEqual(result.type, 'genre');
  assert.strictEqual(result.movies.length, 1);
  assert.strictEqual(result.movies[0].title, "Test Spider Movie");
});

test('toIcs creates ICS for movies from fixture', async () => {
  const result = await getMovies({ query: 'Spider', fsImpl: mockFs });
  const ics = toIcs(result);

  assert.ok(ics.includes('BEGIN:VCALENDAR'));
  assert.ok(ics.includes('BEGIN:VEVENT'));
  assert.ok(ics.includes('SUMMARY:Test Spider Movie (Movie Release)'));
  assert.ok(ics.includes('DESCRIPTION:Movie: Test Spider Movie'));
});

test('getMovies handles people/character search', async () => {
  const query = 'Actor Name';
  const result = await getMovies({ type: 'people', query, fsImpl: mockFs });

  assert.strictEqual(result.movies.length, 1);
  assert.strictEqual(result.movies[0].title, "Test Spider Movie");
});

test('getMovies handles studio (keyword) search', async () => {
  const query = 'Spider';
  const result = await getMovies({ type: 'studio', query, fsImpl: mockFs });

  assert.strictEqual(result.movies.length, 1);
  assert.strictEqual(result.movies[0].title, "Test Spider Movie");
});

test('getMovies filters by since date', async () => {
  const result = await getMovies({ since: '2026-08-01', fsImpl: mockFs });

  assert.strictEqual(result.movies.length, 1);
  assert.strictEqual(result.movies[0].title, "Another Movie");
});

test('searchMovieSuggestions returns unique genres when type is genre', async () => {
  const results = await searchMovieSuggestions({ type: 'genre', query: 'Act', fsImpl: mockFs });

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, "Action");
  assert.strictEqual(results[0].category, "Genre");
});

test('searchMovieSuggestions returns unique people when type is people', async () => {
  const results = await searchMovieSuggestions({ type: 'people', query: 'Direct', fsImpl: mockFs });

  // Both "Director Name" and "Some Director" match "Direct"
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].name, "Director Name");
  assert.strictEqual(results[0].category, "Person");
  assert.strictEqual(results[1].name, "Some Director");
});
