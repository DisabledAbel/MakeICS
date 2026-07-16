import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRtShow, parseRtEpisodesFromHtml } from '../lib/rottenTomatoes.js';
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
    if (String(url).includes('rottentomatoes.com/search')) {
      const html = `
        <html>
          <body>
            <search-page-media-row cast="" data-qa="data-row" endyear="" releaseyear="" startyear="2024" tomatometeriscertified="true" tomatometerscore="95" tomatometersentiment="POSITIVE">
              <a href="/tv/example_show" slot="title">Example Show</a>
            </search-page-media-row>
          </body>
        </html>
      `;
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

import { parseRtDate } from '../lib/rottenTomatoes.js';

test('parseRtDate correctly handles ISO dates, localized dates, and fallbacks', () => {
  const currentYear = new Date().getFullYear();

  // ISO and YYYY-MM-DD
  assert.equal(parseRtDate('2024-01-22'), '2024-01-22');
  assert.equal(parseRtDate('2024-11-05T12:00:00Z'), '2024-11-05');

  // Localized English Month Day, Year
  assert.equal(parseRtDate('January 22, 2024'), '2024-01-22');
  assert.equal(parseRtDate('Jan 22, 2024'), '2024-01-22');
  assert.equal(parseRtDate('  December 5 2025 '), '2025-12-05');

  // Localized English Day Month Year
  assert.equal(parseRtDate('22 Jan 2024'), '2024-01-22');
  assert.equal(parseRtDate('5 December 2025'), '2025-12-05');

  // Stripping prefixes like "Airs", "Aired"
  assert.equal(parseRtDate('Airs Jul 20'), `${currentYear}-07-20`);
  assert.equal(parseRtDate('Aired May 25, 2026'), '2026-05-25');

  // Localized English Month Day without year
  assert.equal(parseRtDate('Jul 20'), `${currentYear}-07-20`);
  assert.equal(parseRtDate('August 3'), `${currentYear}-08-03`);

  // Fallback / standard Date.parse
  // Timezone-explicit vs local
  assert.ok(parseRtDate('2024/01/22')); // basic date parsing

  // Null & invalid values
  assert.equal(parseRtDate(null), null);
  assert.equal(parseRtDate(''), null);
  assert.equal(parseRtDate('not-a-date'), null);
});

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

test('searchRtShow handles query variants like extra spaces and colons with normalized matching', async () => {
  const requests = [];
  const fetchMockWithCustomHtml = async (url) => {
    requests.push(url);
    const html = `
      <html>
        <body>
          <search-page-media-row cast="" data-qa="data-row" endyear="" releaseyear="" startyear="2026" tomatometeriscertified="false" tomatometerscore="" tomatometersentiment="">
            <a href="/tv/sofia_the_first_royal_magic" slot="title">Sofia the First: Royal Magic</a>
          </search-page-media-row>
        </body>
      </html>
    `;
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
  };

  const result = await searchRtShow('Sofia the First : royal magic', fetchMockWithCustomHtml);
  assert.ok(result);
  assert.equal(result.title, 'Sofia the First: Royal Magic');
  assert.equal(result.slug, 'sofia_the_first_royal_magic');
  assert.equal(result.url, 'https://www.rottentomatoes.com/tv/sofia_the_first_royal_magic');
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
  assert.equal(enrichedEp.airdate, '2026-06-11');
  assert.equal(enrichedEp.airstamp, '2026-06-11T01:00:00+00:00');
  // Ensure Rotten Tomatoes episode name has overridden the TVMaze episode name
  assert.equal(enrichedEp.name, 'Future episode.');
});

test('getEpisodes applies since filter correctly after correcting mismatched date', async () => {
  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl: createFetchMock(),
    since: '2026-06-11',
    env: { NODE_ENV: 'test' }
  });

  // The TVMaze episode originally had date 2026-06-10.
  // Under old logic (filter before merge), it would have been filtered out (since 2026-06-10 < 2026-06-11).
  // Under new logic, its date gets updated to 2026-06-11, and THEN since is applied.
  // So it should be retained!
  const enrichedEp = result.episodes.find(e => e.season === 2 && e.number === 3);
  assert.ok(enrichedEp);
  assert.equal(enrichedEp.airdate, '2026-06-11');

  // Any episode whose date remained 2026-06-10 (like other past ones if any) should be filtered out
  const pastEp = result.episodes.find(e => e.airdate === '2026-06-10');
  assert.equal(pastEp, undefined);
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
  // Ensure description includes the Google search link to verify schedule
  assert.match(ics, /Verify schedule: https:\/\/www\.google\.com\/search\?q=Example%20Show%20S02E03%20episode/);
});
