# MakeICS TV Upcoming Episodes

A small Vercel-ready web application that searches for TV shows, fetches all known upcoming episode air dates from the [TVMaze API](https://www.tvmaze.com/api), enriches the show from a public/free IMDb endpoint or optional Firecrawl scraping, and provides an `.ics` calendar URL you can copy into calendar apps.

## Features

- Search for a TV show by name with Google-style suggestions while typing.
- Fetch every known upcoming episode from TVMaze without next-week/month/year feed limits.
- IMDb enrichment through the public/free FM-DB endpoint, with optional Firecrawl scraping through `FIRECRAWL_API_KEY`.
- Copy one all-time ICS calendar URL that asks calendar apps and Vercel to refresh once per day.
- Runs locally with Node.js and deploys to Vercel as static assets plus a serverless API route.

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, start typing to pick a suggested show, search, and click **Copy ICS URL** to copy the all-time calendar feed URL. The ICS feed includes daily refresh metadata and the API cache revalidates daily so newly published episodes can appear without changing the URL.

## Vercel deployment

This repository includes `vercel.json`, a `public/` static frontend, and `api/episodes.js` for the serverless function. Deploy with:

```bash
vercel
```

or import the repository in the Vercel dashboard. No build step is required.

## API

```http
GET /api/episodes?show=The%20Last%20of%20Us
GET /api/episodes?show=The%20Last%20of%20Us&format=ics
```

### JSON response shape

```json
{
  "show": {
    "name": "Example Show",
    "imdbId": "tt1234567"
  },
  "imdb": null,
  "episodes": []
}
```

## IMDb and Firecrawl configuration

The app keeps a public/free IMDb-compatible endpoint enabled by default:

```text
https://imdb.iamidiotareyoutoo.com/search?tt=<imdbId>
```

That endpoint does **not** require an API key. If you configure Firecrawl, the app uses Firecrawl first to scrape the public IMDb title page and falls back to the free endpoint if Firecrawl fails.

| Variable | Purpose |
| --- | --- |
| `FIRECRAWL_API_KEY` | Optional Firecrawl API key. Sent as `Authorization: Bearer <key>` to the Firecrawl scrape API. |
| `FIRECRAWL_API_URL` | Optional override for the Firecrawl scrape URL. Defaults to `https://api.firecrawl.dev/v2/scrape`. |
| `IMDB_API_URL` | Optional custom public/free IMDb-compatible endpoint. Use `{imdbId}` as a placeholder, or the app appends `?tt=<imdbId>` / `&tt=<imdbId>`. |

Example local usage with Firecrawl:

```bash
FIRECRAWL_API_KEY='fc-YOUR-KEY' npm run dev
```

Example local usage with a custom free IMDb-compatible endpoint:

```bash
IMDB_API_URL='https://example-imdb-api.test/title/{imdbId}' npm run dev
```

Configure the same variables in Vercel Project Settings for production.

## Tests

```bash
npm test
```
