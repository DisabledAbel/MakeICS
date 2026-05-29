import test from 'node:test';
import assert from 'node:assert/strict';
import { getUpcomingEpisodes, toIcs } from '../lib/tvEpisodes.js';

const showPayload = {
  id: 1,
  name: 'Example Show',
  status: 'Running',
  premiered: '2024-01-01',
  ended: null,
  genres: ['Drama'],
  language: 'English',
  officialSite: 'https://example.test',
  url: 'https://www.tvmaze.com/shows/1/example-show',
  externals: { imdb: 'tt1234567' },
  image: { medium: 'https://example.test/poster.jpg' },
  summary: '<p>A test show.</p>',
  runtime: 60,
  network: { name: 'Test Network', country: { name: 'United States' } }
};

const episodesPayload = [
  {
    id: 10,
    name: 'Already Aired',
    season: 1,
    number: 1,
    airdate: '2026-01-01',
    airtime: '20:00',
    airstamp: '2026-01-02T01:00:00+00:00',
    runtime: 60,
    summary: '<p>Past.</p>',
    url: 'https://www.tvmaze.com/episodes/10'
  },
  {
    id: 11,
    name: 'The Future',
    season: 2,
    number: 3,
    airdate: '2026-06-10',
    airtime: '20:00',
    airstamp: '2026-06-11T01:00:00+00:00',
    runtime: 60,
    summary: '<p>Future episode.</p>',
    url: 'https://www.tvmaze.com/episodes/11'
  },
  {
    id: 12,
    name: 'Too Far Away',
    season: 2,
    number: 4,
    airdate: '2027-06-10',
    airtime: '20:00',
    airstamp: '2027-06-11T01:00:00+00:00',
    runtime: 60,
    summary: '<p>Later.</p>',
    url: 'https://www.tvmaze.com/episodes/12'
  }
];

function createFetchMock() {
  return async (url) => {
    if (url.includes('/singlesearch/shows')) {
      return Response.json(showPayload);
    }
    if (url.includes('/shows/1/episodes')) {
      return Response.json(episodesPayload);
    }
    if (url.includes('imdb.test')) {
      return Response.json({ title: 'IMDb Example Show', year: '2024', imDbRating: '8.5' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test('getUpcomingEpisodes returns upcoming TVMaze episodes and IMDb enrichment', async () => {
  const result = await getUpcomingEpisodes({
    query: 'Example Show',
    days: '90',
    now: new Date('2026-05-29T00:00:00Z'),
    fetchImpl: createFetchMock(),
    env: { IMDB_API_URL: 'https://imdb.test/title/{imdbId}' }
  });

  assert.equal(result.show.name, 'Example Show');
  assert.equal(result.show.imdbId, 'tt1234567');
  assert.equal(result.imdb.title, 'IMDb Example Show');
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0].name, 'The Future');
  assert.equal(result.episodes[0].summary, 'Future episode.');
});

test('getUpcomingEpisodes validates missing show names', async () => {
  await assert.rejects(
    () => getUpcomingEpisodes({ query: ' ', fetchImpl: createFetchMock() }),
    /show name is required/
  );
});

test('toIcs creates a calendar event for each upcoming episode', async () => {
  const result = await getUpcomingEpisodes({
    query: 'Example Show',
    now: new Date('2026-05-29T00:00:00Z'),
    fetchImpl: createFetchMock(),
    env: {}
  });

  const ics = toIcs(result);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:Example Show S02E03 The Future/);
  assert.match(ics, /END:VCALENDAR/);
});
