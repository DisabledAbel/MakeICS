import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getUpcomingEpisodes, searchShowSuggestions, toIcs } from '../lib/tvEpisodes.js';

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

const searchPayload = [
  {
    score: 0.91,
    show: {
      id: 101,
      name: 'Example Show',
      status: 'Running',
      premiered: '2024-01-01',
      ended: null,
      url: 'https://www.tvmaze.com/shows/101/example-show',
      image: { medium: 'https://example.test/example.jpg' },
      summary: '<p>Suggested show.</p>',
      network: { name: 'Suggestion Network', country: { name: 'United States' } }
    }
  },
  {
    score: 0.72,
    show: {
      id: 102,
      name: 'Example Show UK',
      status: 'Ended',
      premiered: '2020-01-01',
      ended: '2021-01-01',
      url: 'https://www.tvmaze.com/shows/102/example-show-uk',
      image: null,
      summary: '<p>Another suggestion.</p>',
      webChannel: { name: 'Streamer', country: { name: 'United Kingdom' } }
    }
  }
];

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

function createFetchMock(requests = []) {
  return async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/search/shows')) {
      return Response.json(searchPayload);
    }
    if (String(url).includes('/singlesearch/shows')) {
      return Response.json(showPayload);
    }
    if (String(url).includes('/shows/1/episodes')) {
      return Response.json(episodesPayload);
    }
    if (String(url).includes('imdb.test')) {
      return Response.json({ title: 'IMDb Example Show', year: '2024', imDbRating: '8.5' });
    }
    if (String(url).includes('imdb.iamidiotareyoutoo.com')) {
      return Response.json({ short: { name: 'Free IMDb Example Show', datePublished: '2024-01-01', aggregateRating: { ratingValue: '8.2' }, description: 'Free endpoint result.' } });
    }
    if (String(url).includes('firecrawl.test')) {
      return Response.json({ data: { markdown: '# Firecrawl Example Show - IMDb\nRating 8.9/10', metadata: { title: 'Firecrawl Example Show - IMDb', description: 'Scraped result.' } } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test('searchShowSuggestions returns Google-style typeahead TV show results', async () => {
  const requests = [];
  const suggestions = await searchShowSuggestions({
    query: 'exa',
    fetchImpl: createFetchMock(requests)
  });

  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].name, 'Example Show');
  assert.equal(suggestions[0].network, 'Suggestion Network');
  assert.equal(suggestions[0].summary, 'Suggested show.');
  assert.ok(requests.some((request) => request.url === 'https://api.tvmaze.com/search/shows?q=exa'));
});

test('getUpcomingEpisodes returns upcoming TVMaze episodes and custom IMDb enrichment', async () => {
  const result = await getUpcomingEpisodes({
    query: 'Example Show',
    now: new Date('2026-05-29T00:00:00Z'),
    fetchImpl: createFetchMock(),
    env: { IMDB_API_URL: 'https://imdb.test/title/{imdbId}' }
  });

  assert.equal(result.show.name, 'Example Show');
  assert.equal(result.show.imdbId, 'tt1234567');
  assert.equal(result.imdb.title, 'IMDb Example Show');
  assert.equal(result.window.mode, 'all-time');
  assert.equal(result.episodes.length, 2);
  assert.deepEqual(result.episodes.map((episode) => episode.name), ['The Future', 'Too Far Away']);
  assert.equal(result.episodes[0].summary, 'Future episode.');
  assert.equal(result.episodes[0].network, 'Test Network');
});

test('getUpcomingEpisodes uses the free public IMDb endpoint without an API key by default', async () => {
  const requests = [];
  const result = await getUpcomingEpisodes({
    query: 'Example Show',
    now: new Date('2026-05-29T00:00:00Z'),
    fetchImpl: createFetchMock(requests),
    env: {}
  });

  assert.equal(result.imdb.source, 'public-imdb');
  assert.equal(result.imdb.title, 'Free IMDb Example Show');
  assert.equal(result.imdb.rating, '8.2');
  assert.ok(requests.some((request) => request.url === 'https://imdb.iamidiotareyoutoo.com/search?tt=tt1234567'));
  assert.ok(requests.every((request) => !request.options.headers?.Authorization));
});

test('getUpcomingEpisodes quietly skips unavailable default IMDb enrichment', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/singlesearch/shows')) {
      return Response.json(showPayload);
    }
    if (String(url).includes('/shows/1/episodes')) {
      return Response.json(episodesPayload);
    }
    if (String(url).includes('imdb.iamidiotareyoutoo.com')) {
      return new Response('Temporary upstream failure', { status: 500 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await getUpcomingEpisodes({
    query: 'Example Show',
    now: new Date('2026-05-29T00:00:00Z'),
    fetchImpl,
    env: {}
  });

  assert.equal(result.imdb.source, 'public-imdb');
  assert.equal(result.imdb.sourceConfigured, false);
  assert.equal(result.imdb.error, undefined);
  assert.match(result.imdb.warning, /HTTP 500/);
  assert.equal(result.episodes.length, 2);
  assert.ok(requests.some((request) => request.url === 'https://imdb.iamidiotareyoutoo.com/search?tt=tt1234567'));
});

test('getUpcomingEpisodes quietly skips default IMDb network failures', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/singlesearch/shows')) {
      return Response.json(showPayload);
    }
    if (String(url).includes('/shows/1/episodes')) {
      return Response.json(episodesPayload);
    }
    if (String(url).includes('imdb.iamidiotareyoutoo.com')) {
      throw new Error('getaddrinfo EAI_AGAIN imdb.iamidiotareyoutoo.com');
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await getUpcomingEpisodes({
    query: 'Example Show',
    now: new Date('2026-05-29T00:00:00Z'),
    fetchImpl,
    env: {}
  });

  assert.equal(result.imdb.sourceConfigured, false);
  assert.equal(result.imdb.error, undefined);
  assert.match(result.imdb.warning, /request failed/);
  assert.equal(result.episodes.length, 2);
});

test('getUpcomingEpisodes uses FIRECRAWL_API_KEY for IMDb scraping when configured', async () => {
  const requests = [];
  const result = await getUpcomingEpisodes({
    query: 'Example Show',
    now: new Date('2026-05-29T00:00:00Z'),
    fetchImpl: createFetchMock(requests),
    env: { FIRECRAWL_API_KEY: 'fc-test', FIRECRAWL_API_URL: 'https://firecrawl.test/v2/scrape' }
  });

  const firecrawlRequest = requests.find((request) => request.url === 'https://firecrawl.test/v2/scrape');
  assert.equal(result.imdb.source, 'firecrawl');
  assert.equal(result.imdb.title, 'Firecrawl Example Show');
  assert.equal(result.imdb.rating, '8.9');
  assert.equal(firecrawlRequest.options.method, 'POST');
  assert.equal(firecrawlRequest.options.headers.Authorization, 'Bearer fc-test');
  assert.match(firecrawlRequest.options.body, /https:\/\/www\.imdb\.com\/title\/tt1234567\//);
});

test('getUpcomingEpisodes validates missing show names', async () => {
  await assert.rejects(
    () => getUpcomingEpisodes({ query: ' ', fetchImpl: createFetchMock() }),
    /show name is required/
  );
});

test('toIcs creates a daily-refreshing calendar event feed for each upcoming episode', async () => {
  const result = await getUpcomingEpisodes({
    query: 'Example Show',
    now: new Date('2026-05-29T00:00:00Z'),
    fetchImpl: createFetchMock(),
    env: {}
  });

  const ics = toIcs(result);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /X-PUBLISHED-TTL:PT24H/);
  assert.match(ics, /REFRESH-INTERVAL;VALUE=DURATION:PT24H/);
  assert.match(ics, /SUMMARY:Example Show S02E03 The Future/);
  assert.match(ics, /SUMMARY:Example Show S02E04 Too Far Away/);
  assert.match(ics, /DESCRIPTION:Airs on Test Network\. Future episode\./);
  assert.match(ics, /END:VCALENDAR/);
});

test('frontend offers one all-time copied ICS URL instead of dated feeds', async () => {
  const appScript = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const indexPage = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const apiHandler = await readFile(new URL('../api/episodes.js', import.meta.url), 'utf8');
  const searchApiHandler = await readFile(new URL('../api/search.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const vercelConfig = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');

  assert.match(appScript, /Copy ICS URL/);
  assert.match(appScript, /Airs on/);
  assert.match(appScript, /formatEpisodeAbout/);
  assert.match(appScript, /api\/search/);
  assert.match(indexPage, /search-suggestions/);
  assert.match(appScript, /navigator\.clipboard/);
  assert.match(appScript, /format=ics/);
  assert.doesNotMatch(appScript, /days=/);
  assert.doesNotMatch(indexPage, /Next 30 days|Next 90 days|Next year|select id="days-input"/);
  assert.doesNotMatch(appScript, /Download ICS/);
  assert.doesNotMatch(apiHandler, /Content-Disposition/);
  assert.match(apiHandler, /s-maxage=86400/);
  assert.match(searchApiHandler, /searchShowSuggestions/);
  assert.match(server, /api\/search/);
  assert.match(vercelConfig, /\"source\": \"\/api\/search\"/);
});
