import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMovies, searchMovieSuggestions, toIcs } from '../lib/movies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOVIES_DATA_FILE = path.join(__dirname, '../lib/data/movies/upcoming.json');

test('searchMovieSuggestions returns movie results', async () => {
  const query = 'Spider';
  const results = await searchMovieSuggestions({ query });

  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0);
  assert.ok(results.every(r => r.name.toLowerCase().includes('spider') || r.genres.some(g => g.toLowerCase().includes('spider')) || r.people.some(p => p.toLowerCase().includes('spider'))));
});

test('getMovies returns filtered results', async () => {
  const query = 'Animation';
  const result = await getMovies({ type: 'genre', query });

  assert.strictEqual(result.query, 'Animation');
  assert.strictEqual(result.type, 'genre');
  assert.ok(result.movies.length > 0);
  assert.ok(result.movies.every(m => m.genres.some(g => g.toLowerCase().includes('animation'))));
});

test('toIcs creates ICS for movies', async () => {
  const result = await getMovies({ query: 'Spider' });
  const ics = toIcs(result);

  assert.ok(ics.includes('BEGIN:VCALENDAR'));
  assert.ok(ics.includes('BEGIN:VEVENT'));
  assert.ok(ics.includes('SUMMARY:'));
  assert.ok(ics.includes('(Movie Release)'));
});
