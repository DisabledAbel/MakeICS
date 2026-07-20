import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImdbDate, parseImdbEpisodesFromHtml, fetchImdbEpisodes } from '../lib/imdbEpisodes.js';
import { getEpisodes, toIcs } from '../lib/tvEpisodes.js';

// Define the environment variable to mock the browser page in scraper.js
process.env.NODE_ENV = 'test';

const mockTvmazeShowPayload = {
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

const mockTvmazeEpisodesPayload = [
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
  }
];

function createFetchMock(requests = []) {
  return async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/search/shows')) {
      return Response.json([{ show: mockTvmazeShowPayload }]);
    }
    if (String(url).includes('/singlesearch/shows')) {
      return Response.json(mockTvmazeShowPayload);
    }
    if (String(url).includes('/shows/1/episodes')) {
      return Response.json(mockTvmazeEpisodesPayload);
    }
    if (String(url).includes('imdb.iamidiotareyoutoo.com')) {
      return Response.json({ short: { name: 'Free IMDb Example Show', datePublished: '2024-01-01', aggregateRating: { ratingValue: '8.2' }, description: 'Free endpoint result.' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test('parseImdbDate correctly handles ISO dates, localized dates, and fallbacks', () => {
  // ISO and YYYY-MM-DD
  assert.equal(parseImdbDate('2024-01-22'), '2024-01-22');
  assert.equal(parseImdbDate('2024-11-05T12:00:00Z'), '2024-11-05');

  // Localized English Month Day, Year
  assert.equal(parseImdbDate('January 22, 2024'), '2024-01-22');
  assert.equal(parseImdbDate('Jan. 22, 2024'), '2024-01-22');
  assert.equal(parseImdbDate('Jan 22, 2024'), '2024-01-22');
  assert.equal(parseImdbDate('  December 5 2025 '), '2025-12-05');

  // Localized English Day Month Year
  assert.equal(parseImdbDate('22 Jan 2024'), '2024-01-22');
  assert.equal(parseImdbDate('22 Jan. 2024'), '2024-01-22');
  assert.equal(parseImdbDate('5 December 2025'), '2025-12-05');

  // Stripping prefixes like "Airs", "Aired"
  assert.equal(parseImdbDate('Aired May 25, 2026'), '2026-05-25');

  // Null & invalid values
  assert.equal(parseImdbDate(null), null);
  assert.equal(parseImdbDate(''), null);
  assert.equal(parseImdbDate('not-a-date'), null);
});

test('parseImdbEpisodesFromHtml extracts episode schemas from JSON-LD tags', () => {
  const html = `
    <html>
      <script type="application/ld+json">
        {
          "@context": "http://schema.org",
          "@type": "CreativeWorkSeason",
          "episode": [
            {
              "@type": "TVEpisode",
              "episodeNumber": 1,
              "name": "First Episode",
              "datePublished": "2024-01-15",
              "description": "The first description.",
              "url": "/title/tt1234567/episodes/"
            },
            {
              "@type": "TVEpisode",
              "episodeNumber": 2,
              "name": "Second Episode",
              "datePublished": "January 22, 2024",
              "description": "The second description.",
              "url": "/title/tt1234567/episodes/"
            }
          ]
        }
      </script>
    </html>
  `;

  const episodes = parseImdbEpisodesFromHtml(html, 1);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].number, 1);
  assert.equal(episodes[0].name, 'First Episode');
  assert.equal(episodes[0].airdate, '2024-01-15');
  assert.equal(episodes[0].summary, 'The first description.');
  assert.equal(episodes[0].url, 'https://www.imdb.com/title/tt1234567/episodes/');

  assert.equal(episodes[1].number, 2);
  assert.equal(episodes[1].airdate, '2024-01-22');
});

test('getEpisodes merges and supplements IMDb data into schedules', async () => {
  const requests = [];
  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl: createFetchMock(requests),
    env: { NODE_ENV: 'test' }
  });

  assert.ok(result.imdbUpcoming);
  assert.equal(result.imdbUpcoming.id, 'tt1234567');

  const enrichedEp = result.episodes.find(e => e.season === 2 && e.number === 3);
  assert.ok(enrichedEp);
  assert.equal(enrichedEp.imdbUrl, 'https://www.imdb.com/title/tt1234567/episodes/?season=2');
  assert.equal(enrichedEp.name, 'Future episode.');
  assert.equal(enrichedEp.airdate, '2026-06-11');
});

test('toIcs calendar output includes IMDb details in description', async () => {
  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl: createFetchMock(),
    env: { NODE_ENV: 'test' }
  });

  const ics = toIcs(result, { timezone: 'UTC' });
  assert.match(ics, /IMDb Episode: https:\/\/www.imdb.com\/title\/tt1234567\/episodes\/\?season=2/);
});

test('fetchImdbEpisodes handles JSON-LD with missing airdate and falls back to DOM evaluation', async () => {
  process.env.TEST_IMDB_FALLBACK = 'true';
  try {
    const episodes = await fetchImdbEpisodes('tt1234567', 2);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].season, 2);
    assert.equal(episodes[0].number, 3);
    assert.equal(episodes[0].name, 'Future episode.');
    assert.equal(episodes[0].airdate, '2026-06-11');
    assert.equal(episodes[0].url, 'https://www.imdb.com/title/tt1234567/episodes/?season=2');
  } finally {
    delete process.env.TEST_IMDB_FALLBACK;
  }
});
