# MakeICS

> Generate dynamic `.ics` calendar feeds from schedules, APIs, websites, and custom event data

---

## ✨ Features

* 📅 Generate valid `.ics` calendar feeds
* 🌐 Create calendars from websites or APIs
* ⚡ Auto-update schedules dynamically
* 🏀 Perfect for sports schedules, TV listings, movies, and events
* 🔄 Export recurring or one-time events
* ☁️ Easy deployment on Vercel, or your own server
* 🛠 Simple and developer-friendly setup

---

## 🚀 Categories

### 📺 TV Shows
Feeds generated using [TVMaze](https://www.tvmaze.com/api) and enriched with IMDb metadata. The show schedules are also seamlessly merged and supplemented with upcoming episodes fetched directly from [IMDb](https://www.imdb.com) for up-to-date schedule verification, summaries, and episode links.
- **Search**: `/api/search?q={query}`
- **ICS Feed**: `/api/episodes?show={showName}&format=ics`

### 🏀 Sports
Comprehensive sports coverage using [TheSportsDB](https://www.thesportsdb.com/), ESPN scraping, and specialized data for:
- **Major Leagues**: NBA, NFL, MLB, NHL, MLS, etc.
- **WNBA**: Enhanced support via SportsDataverse and ESPN.
- **AHL**: American Hockey League schedules.
- **MiLB**: Minor League Baseball schedules.
- **AF1**: Arena Football One official schedules.
- **Search**: `/api/sports-search?q={query}`
- **ICS Feed**: `/api/sports-events?teamId={teamId}&format=ics`

### 🎬 Movies
Upcoming movie releases scraped from the [IMDb US Release Calendar](https://www.imdb.com/calendar/?region=US).
- **Search Types**: `movie`, `genre`, `character`, `people`, `studio`.
- **Search**: `/api/movies-search?q={query}&type={type}`
- **ICS Feed**: `/api/movies?q={query}&type={type}&format=ics`

---

## ▶️ Running Locally

### 1. Clone the repository

```bash
git clone https://github.com/DisabledAbel/MakeICS.git
```

### 2. Enter the project folder

```bash
cd MakeICS
```

### 3. Install dependencies

```bash
npm install
```

### 4. Start the development server

```bash
npm run dev
```

Or run directly with Node.js:

```bash
node index.js
```

Open <http://localhost:3000>, start typing to pick a suggested show, sports team, or upcoming movie, and click **Copy ICS URL** to copy the all-time calendar feed URL. The ICS feed includes daily refresh metadata and the API cache revalidates daily so newly published episodes/games/movies can appear without changing the URL.

## Vercel deployment

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyour-username%2FMakeICS)

## API

### TV Shows
```http
GET /api/search?q=The%20Last%20of%20Us
GET /api/episodes?show=The%20Last%20of%20Us
GET /api/episodes?show=The%20Last%20of%20Us&format=ics
```

### Sports
```http
GET /api/sports-search?q=Portland%20Thorns
GET /api/sports-events?teamId=136450
GET /api/sports-events?teamId=136450&format=ics
```

### Movies
```http
GET /api/movies-search?q=Spider-Man&type=movie
GET /api/movies?q=Spider-Man&type=movie
GET /api/movies?q=Animation&type=genre&format=ics
```

### JSON response shape (TV)

```json
{
  "show": {
    "name": "Example Show",
    "imdbId": "tt1234567"
  },
  "imdb": null,
  "imdbUpcoming": {
    "id": "tt1234567",
    "source": "imdb-episodes",
    "sourceConfigured": true
  },
  "episodes": []
}
```

## IMDb and Firecrawl configuration

The app tries a public/free IMDb-compatible endpoint by default, but treats it as optional so temporary endpoint outages do not interrupt TV show searches:

That endpoint does **not** require an API key. If the public endpoint is unavailable, MakeICS still returns TVMaze episodes and the direct IMDb link without showing a blocking enrichment failure. If you configure Firecrawl, the app uses Firecrawl first to scrape the public IMDb title page and falls back to the free endpoint if Firecrawl fails.

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
