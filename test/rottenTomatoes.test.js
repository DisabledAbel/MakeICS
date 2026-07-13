import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRtShow, parseRtEpisodesFromHtml } from '../lib/rottenTomatoes.js';
import { getEpisodes, toIcs } from '../lib/tvEpisodes.js';

// Define the environment variable to mock the browser page in scraper.js
process.env.NODE_ENV = 'test';

const mockSearchResponse = {
  tvSeries: [
    {
      title: 'Example Show',
      url: '/tv/example_show',
      meterScore: 95,
      meterClass: 'certified_fresh',
      image: 'https://example.test/rt-poster.jpg',
      year: 2024
    }
  ]
};

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
    if (String(url).includes('rottentomatoes.com/api/private')) {
      return Response.json(mockSearchResponse);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test('searchRtShow resolves titles, scores, and slugs correctly', async () => {
  const requests = [];
  const result = await searchRtShow('Example Show', createFetchMock(requests));

  assert.ok(result);
  assert.equal(result.title, 'Example Show');
  assert.equal(result.slug, 'example_show');
  assert.equal(result.url, 'https://www.rottentomatoes.com/tv/example_show');
  assert.equal(result.meterScore, 95);
  assert.equal(result.meterClass, 'certified_fresh');
});

test('parseRtEpisodesFromHtml extracts episode schemas from JSON-LD tags', () => {
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
              "url": "/tv/example_show/s01/e01"
            },
            {
              "@type": "TVEpisode",
              "episodeNumber": 2,
              "name": "Second Episode",
              "datePublished": "January 22, 2024",
              "description": "The second description.",
              "url": "/tv/example_show/s01/e02"
            }
          ]
        }
      </script>
    </html>
  `;

  const episodes = parseRtEpisodesFromHtml(html, 1);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].number, 1);
  assert.equal(episodes[0].name, 'First Episode');
  assert.equal(episodes[0].airdate, '2024-01-15');
  assert.equal(episodes[0].summary, 'The first description.');
  assert.equal(episodes[0].url, 'https://www.rottentomatoes.com/tv/example_show/s01/e01');

  assert.equal(episodes[1].number, 2);
  assert.equal(episodes[1].airdate, '2024-01-22');
});

test('getEpisodes merges and supplements Rotten Tomatoes data into schedules', async () => {
  const requests = [];
  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl: createFetchMock(requests),
    env: { NODE_ENV: 'test' }
  });

  assert.ok(result.rt);
  assert.equal(result.rt.slug, 'example_show');
  assert.equal(result.rt.meterScore, 95);

  // We should have TVMaze episodes merged/supplemented with Rotten Tomatoes details
  const rtEp = result.episodes.find(e => e.id && String(e.id).includes('rt-example_show'));
  // Note: the future episode (S2E3) is enriched since scraper.js test-mode content defines S2E3
  const enrichedEp = result.episodes.find(e => e.season === 2 && e.number === 3);

  assert.ok(enrichedEp);
  assert.equal(enrichedEp.rtUrl, 'https://www.rottentomatoes.com/tv/example_show/s02/e03');
  assert.equal(enrichedEp.summary, 'Future episode.');
});

test('toIcs calendar output includes Rotten Tomatoes details in description', async () => {
  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl: createFetchMock(),
    env: { NODE_ENV: 'test' }
  });

  const ics = toIcs(result, { timezone: 'UTC' });
  assert.match(ics, /Rotten Tomatoes: https:\/\/www.rottentomatoes.com\/tv\/example_show/);
  assert.match(ics, /RT Tomatometer: 95%/);
  assert.match(ics, /Rotten Tomatoes Episode: https:\/\/www.rottentomatoes.com\/tv\/example_show\/s02\/e03/);
});
