# MakeICS TV Upcoming Episodes

A small Vercel-ready web application that searches for TV shows, fetches upcoming episode air dates from the [TVMaze API](https://www.tvmaze.com/api), optionally enriches the show from an IMDb-compatible API endpoint, and exports upcoming episodes as an `.ics` calendar file.

## Features

- Search for a TV show by name.
- Fetch upcoming episodes from TVMaze for the next 30, 90, 180, or 365 days.
- Optional IMDb enrichment through configurable environment variables.
- Download upcoming episodes as an ICS calendar file.
- Runs locally with Node.js and deploys to Vercel as static assets plus a serverless API route.

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, search for a show, and click **Download ICS** to export the results.

## Vercel deployment

This repository includes `vercel.json`, a `public/` static frontend, and `api/episodes.js` for the serverless function. Deploy with:

```bash
vercel
```

or import the repository in the Vercel dashboard. No build step is required.

## API

```http
GET /api/episodes?show=The%20Last%20of%20Us&days=90
GET /api/episodes?show=The%20Last%20of%20Us&days=90&format=ics
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

## IMDb endpoint configuration

IMDb does not expose one universal unauthenticated endpoint for every deployment, so the app accepts an IMDb-compatible endpoint through environment variables:

| Variable | Purpose |
| --- | --- |
| `IMDB_API_URL` | Endpoint URL. Use `{imdbId}` as a placeholder, or the app appends `?i=<imdbId>` / `&i=<imdbId>`. |
| `IMDB_API_KEY` | Optional bearer token sent as `Authorization: Bearer <token>`. |
| `IMDB_RAPIDAPI_KEY` | Optional RapidAPI key sent as `X-RapidAPI-Key`. |
| `IMDB_RAPIDAPI_HOST` | Optional RapidAPI host sent as `X-RapidAPI-Host`. |

Example local usage:

```bash
IMDB_API_URL='https://example-imdb-api.test/title/{imdbId}' npm run dev
```

Configure the same variables in Vercel Project Settings for production.

## Tests

```bash
npm test
```
