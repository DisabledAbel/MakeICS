import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getEpisodes, searchShowSuggestions, toIcs } from '../lib/tvEpisodes.js';

// Define the environment variable to mock the browser page in scraper.js
process.env.NODE_ENV = 'test';

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
    name: 'Future episode.',
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

test('getEpisodes returns TVMaze episodes and custom IMDb enrichment', async () => {
  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl: createFetchMock(),
    env: { IMDB_API_URL: 'https://imdb.test/title/{imdbId}', NODE_ENV: 'test' }
  });

  assert.equal(result.show.name, 'Example Show');
  assert.equal(result.show.imdbId, 'tt1234567');
  assert.equal(result.imdb.title, 'IMDb Example Show');
  assert.equal(result.window.mode, 'all-time');
  assert.equal(result.episodes.length, 3);
  assert.deepEqual(result.episodes.map((episode) => episode.name), ['Already Aired', 'Future episode.', 'Too Far Away']);
  assert.equal(result.episodes[1].summary, 'Future episode.');
  assert.equal(result.episodes[0].network, 'Test Network');
});

test('getEpisodes uses the free public IMDb endpoint without an API key by default', async () => {
  const requests = [];
  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl: createFetchMock(requests),
    env: { NODE_ENV: 'test' }
  });

  assert.equal(result.imdb.source, 'public-imdb');
  assert.equal(result.imdb.title, 'Free IMDb Example Show');
  assert.equal(result.imdb.rating, '8.2');
  assert.ok(requests.some((request) => request.url === 'https://imdb.iamidiotareyoutoo.com/search?tt=tt1234567'));
  assert.ok(requests.every((request) => !request.options.headers?.Authorization));
});

test('getEpisodes quietly skips unavailable default IMDb enrichment', async () => {
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

  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl,
    env: { NODE_ENV: 'test' }
  });

  assert.equal(result.imdb.source, 'public-imdb');
  assert.equal(result.imdb.sourceConfigured, false);
  assert.equal(result.imdb.error, undefined);
  assert.match(result.imdb.warning, /HTTP 500/);
  assert.equal(result.episodes.length, 3);
  assert.ok(requests.some((request) => request.url === 'https://imdb.iamidiotareyoutoo.com/search?tt=tt1234567'));
});

test('getEpisodes quietly skips default IMDb network failures', async () => {
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

  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl,
    env: { NODE_ENV: 'test' }
  });

  assert.equal(result.imdb.sourceConfigured, false);
  assert.equal(result.imdb.error, undefined);
  assert.match(result.imdb.warning, /request failed/);
  assert.equal(result.episodes.length, 3);
});

test('getEpisodes uses FIRECRAWL_API_KEY for IMDb scraping when configured', async () => {
  const requests = [];
  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl: createFetchMock(requests),
    env: { FIRECRAWL_API_KEY: 'fc-test', FIRECRAWL_API_URL: 'https://firecrawl.test/v2/scrape', NODE_ENV: 'test' }
  });

  const firecrawlRequest = requests.find((request) => request.url === 'https://firecrawl.test/v2/scrape');
  assert.equal(result.imdb.source, 'firecrawl');
  assert.equal(result.imdb.title, 'Firecrawl Example Show');
  assert.equal(result.imdb.rating, '8.9');
  assert.equal(firecrawlRequest.options.method, 'POST');
  assert.equal(firecrawlRequest.options.headers.Authorization, 'Bearer fc-test');
  assert.match(firecrawlRequest.options.body, /https:\/\/www\.imdb\.com\/title\/tt1234567\//);
});

test('getEpisodes validates missing show names', async () => {
  await assert.rejects(
    () => getEpisodes({ query: ' ', fetchImpl: createFetchMock() }),
    /show name is required/
  );
});

test('toIcs creates a daily-refreshing calendar event feed for episodes', async () => {
  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl: createFetchMock(),
    env: { NODE_ENV: 'test' }
  });

  const ics = toIcs(result, { timezone: 'America/New_York' });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /X-PUBLISHED-TTL:PT24H/);
  assert.match(ics, /REFRESH-INTERVAL;VALUE=DURATION:PT24H/);
  assert.match(ics, /SUMMARY:Example Show S01E01 Already Aired/);
  assert.match(ics, /SUMMARY:Example Show S02E03 Future episode./);
  assert.match(ics, /SUMMARY:Example Show S02E04 Too Far Away/);
  assert.match(ics, /DESCRIPTION:.*Time: 9:00 PM EDT \/ 6:00 PM PDT.*/);
  assert.match(ics, /END:VCALENDAR/);
});

test('getEpisodes applies IMDb and Google-verified overrides correctly', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const verifiedPath = path.join(__dirname, '../lib/data/tv/google-verified.json');

  let originalVerifiedContent = null;
  try {
    originalVerifiedContent = await fs.readFile(verifiedPath, 'utf8');
  } catch (e) {}

  try {
    // Write a mock google-verified.json
    const mockVerified = {
      "Example Show-2-3": {
        "airdate": "2026-06-15",
        "name": "Google Verified Name"
      }
    };
    await fs.mkdir(path.dirname(verifiedPath), { recursive: true });
    await fs.writeFile(verifiedPath, JSON.stringify(mockVerified, null, 2), 'utf8');

    const result = await getEpisodes({
      query: 'Example Show',
      fetchImpl: createFetchMock(),
      env: { NODE_ENV: 'test' }
    });

    const overriddenEp = result.episodes.find(ep => ep.season === 2 && ep.number === 3);
    assert.ok(overriddenEp);
    assert.equal(overriddenEp.airdate, '2026-06-15');
    assert.equal(overriddenEp.name, 'Google Verified Name');
  } finally {
    // Restore original or delete
    if (originalVerifiedContent !== null) {
      await fs.writeFile(verifiedPath, originalVerifiedContent, 'utf8');
    } else {
      await fs.unlink(verifiedPath).catch(() => {});
    }
  }
});

test('toIcs appends Google Search verify schedule links', async () => {
  const result = await getEpisodes({
    query: 'Example Show',
    fetchImpl: createFetchMock(),
    env: { NODE_ENV: 'test' }
  });

  const ics = toIcs(result, { timezone: 'America/New_York' });
  assert.match(ics, /Verify schedule: https:\/\/www\.google\.com\/search\?q=Example%20Show%20S02E03%20episode/);
});

test('frontend offers one all-time copied ICS URL instead of dated feeds', async () => {
  const appScript = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const indexPage = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const apiHandler = await readFile(new URL('../api/episodes.js', import.meta.url), 'utf8');
  const searchApiHandler = await readFile(new URL('../api/search.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const vercelConfig = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');

  assert.match(appScript, /Copy ICS URL/);
  assert.match(appScript, /format=ics/);
  assert.doesNotMatch(appScript, /days=/);
  assert.doesNotMatch(indexPage, /Next 30 days|Next 90 days|Next year|select id="days-input"/);
  assert.doesNotMatch(appScript, /Download ICS/);
  assert.doesNotMatch(apiHandler, /Content-Disposition/);
  assert.match(apiHandler, /s-maxage=86400/);
  assert.match(searchApiHandler, /searchShowSuggestions/);
  assert.match(server, /api\/search/);
  assert.match(server, /api\/sports-search/);
  assert.match(vercelConfig, /\"source\": \"\/api\/search\"/);
  assert.match(vercelConfig, /\"source\": \"\/api\/sports-search\"/);
  assert.match(vercelConfig, /\"source\": \"\/api\/sports-events\"/);
  assert.match(appScript, /dataset\.category/);
  assert.match(indexPage, /tab-btn/);
});

test('getEpisodes falls back to IMDb cache if TVMaze API fails', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/singlesearch/shows') || String(url).includes('/shows/')) {
      throw new Error('TVMaze is down');
    }
    if (String(url).includes('imdb.test')) {
      return Response.json({ title: 'IMDb Fallback Show', year: '2026', imDbRating: '7.8', plot: 'IMDb fallback description' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await getEpisodes({
    query: 'Sofia the First: Royal Magic',
    fetchImpl,
    env: { IMDB_API_URL: 'https://imdb.test/title/{imdbId}', NODE_ENV: 'test' }
  });

  assert.equal(result.show.name, 'Sofia the First: Royal Magic');
  assert.equal(result.show.imdbId, 'tt23731346');
  assert.equal(result.imdb.title, 'IMDb Fallback Show');
  assert.ok(result.episodes.length > 0);
  assert.equal(result.episodes[0].name, 'Welcome to Charmswell');
});

test('getEpisodes falls back to IMDb suggestion API if TVMaze fails and show is not in cache', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/singlesearch/shows') || String(url).includes('/shows/')) {
      throw new Error('TVMaze is down');
    }
    if (String(url).includes('v3.sg.media-imdb.com/suggestion')) {
      return Response.json({
        d: [
          {
            id: 'tt9999999',
            l: 'Some Unknown Show',
            qid: 'tvSeries'
          }
        ]
      });
    }
    if (String(url).includes('imdb.test')) {
      return Response.json({ title: 'Some Unknown Show Details', year: '2025', imDbRating: '8.0', plot: 'Plots' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await getEpisodes({
    query: 'Some Unknown Show',
    fetchImpl,
    env: { IMDB_API_URL: 'https://imdb.test/title/{imdbId}', NODE_ENV: 'test' }
  });

  assert.equal(result.show.name, 'Some Unknown Show');
  assert.equal(result.show.imdbId, 'tt9999999');
  assert.equal(result.imdb.title, 'Some Unknown Show Details');
});

test('getEpisodes suggestion fallback ignores non-series (e.g. video games) and prioritizes series', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/singlesearch/shows') || String(url).includes('/shows/')) {
      throw new Error('TVMaze is down');
    }
    if (String(url).includes('v3.sg.media-imdb.com/suggestion')) {
      return Response.json({
        d: [
          {
            id: 'tt1111111',
            l: 'Video Game Show',
            qid: 'videoGame' // non-series
          },
          {
            id: 'tt2222222',
            l: 'Movie Show',
            qid: 'movie' // non-series
          },
          {
            id: 'tt3333333',
            l: 'Real Series Show',
            qid: 'tvMiniSeries' // prioritised series
          }
        ]
      });
    }
    if (String(url).includes('imdb.test')) {
      return Response.json({ title: 'Real Series Show Details', year: '2026', imDbRating: '9.0', plot: 'Plots' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await getEpisodes({
    query: 'Real Series Show',
    fetchImpl,
    env: { IMDB_API_URL: 'https://imdb.test/title/{imdbId}', NODE_ENV: 'test' }
  });

  assert.equal(result.show.name, 'Real Series Show');
  assert.equal(result.show.imdbId, 'tt3333333');
  assert.equal(result.imdb.title, 'Real Series Show Details');
});

test('getEpisodes merges and re-indexes consecutive children show episodes on the same day', async () => {
  const childrenShowPayload = {
    id: 99,
    name: "Children's Animated Show",
    status: 'Running',
    premiered: '2026-05-25',
    ended: null,
    genres: ['Adventure', 'Children'],
    language: 'English',
    officialSite: null,
    url: 'https://www.tvmaze.com/shows/99/childrens-animated-show',
    externals: { imdb: null },
    image: null,
    summary: 'A kids show.',
    runtime: null,
    network: { name: 'Disney Junior', country: { name: 'United States' } }
  };

  const childrenEpisodesPayload = [
    {
      id: 901,
      name: 'Welcome to Charmswell',
      season: 1,
      number: 1,
      airdate: '2026-05-25',
      airtime: '07:00',
      airstamp: '2026-05-25T11:00:00+00:00',
      runtime: 25,
      summary: '<p>A full introduction.</p>',
      url: 'https://www.tvmaze.com/episodes/901'
    },
    {
      id: 902,
      name: 'Part One',
      season: 1,
      number: 2,
      airdate: '2026-05-25',
      airtime: '07:25',
      airstamp: '2026-05-25T11:25:00+00:00',
      runtime: 12,
      summary: '<p>First short part.</p>',
      url: 'https://www.tvmaze.com/episodes/902'
    },
    {
      id: 903,
      name: 'Part Two',
      season: 1,
      number: 3,
      airdate: '2026-05-25',
      airtime: '07:37',
      airstamp: '2026-05-25T11:37:00+00:00',
      runtime: 13,
      summary: '<p>Second short part.</p>',
      url: 'https://www.tvmaze.com/episodes/903'
    },
    {
      id: 904,
      name: 'Part Three',
      season: 1,
      number: 4,
      airdate: '2026-05-25',
      airtime: '07:50',
      airstamp: '2026-05-25T11:50:00+00:00',
      runtime: 10,
      summary: '<p>Third short part.</p>',
      url: 'https://www.tvmaze.com/episodes/904'
    }
  ];

  const fetchImpl = async (url) => {
    if (String(url).includes('/singlesearch/shows')) {
      return Response.json(childrenShowPayload);
    }
    if (String(url).includes('/shows/99/episodes')) {
      return Response.json(childrenEpisodesPayload);
    }
    if (String(url).includes('imdb.iamidiotareyoutoo.com')) {
      return Response.json({ short: { name: 'Free Kids Show', datePublished: '2026-05-25', aggregateRating: null, description: 'Kids show.' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await getEpisodes({
    query: "Children's Animated Show",
    fetchImpl,
    env: { NODE_ENV: 'test' }
  });

  assert.equal(result.episodes.length, 2);

  // First episode is S1E1 "Welcome to Charmswell" (runtime 25, not merged)
  assert.equal(result.episodes[0].number, 1);
  assert.equal(result.episodes[0].name, 'Welcome to Charmswell');
  assert.equal(result.episodes[0].runtime, 25);

  // Second episode is the merged S1E2 "Part One/Part Two/Part Three" with summed runtime 12+13+10 = 35
  assert.equal(result.episodes[1].number, 2);
  assert.equal(result.episodes[1].name, 'Part One/Part Two/Part Three');
  assert.equal(result.episodes[1].runtime, 35);
  assert.equal(result.episodes[1].summary, 'First short part. Second short part. Third short part.');
});
