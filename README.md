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

### 🗓 Combined Calendar Builder
The **Calendar Builder** tab combines several TV shows, sports teams, and movie searches into one deterministic subscription URL. The URL is the configuration—there is no account or database—and it continues to refresh as upstream schedules change.

```http
GET /api/calendar?shows=Sofia%20the%20First&format=ics
GET /api/calendar?teamIds=136450&format=ics
GET /api/calendar?shows=Sofia%20the%20First&shows=The%20Last%20of%20Us&teamIds=136450&tz=America/Los_Angeles&format=ics
GET /api/calendar?shows=Sofia%20the%20First&teamIds=136450&movies=Disney&movieType=studio
```

| Parameter | Description |
| --- | --- |
| `shows` | Repeat once per TV show name (maximum 10). |
| `teamIds` | Repeat once per sports team ID (maximum 10). |
| `movies` | Repeat once per movie search (maximum 5). |
| `movieType` | `all`, `studio`, `genre`, or `character`; applies to the movie searches. |
| `tz` | IANA timezone, defaulting to `UTC` (for example, `America/Los_Angeles`). Timed events remain absolute instants and therefore follow daylight-saving changes in calendar clients; date-only movie releases remain all-day events. |
| `since` | Optional date passed to each selected source's existing date filter. |
| `format` | Set to `ics` for an ICS feed. Omit it for normalized JSON, including per-source status and partial failures. |

At least one source is required. A combined calendar accepts at most 20 total sources, and source values and the overall query string are length-limited. Independent sources load concurrently; if one fails, successful sources are still returned. Duplicate selections are removed and events are sorted chronologically with stable UIDs.

Use **Copy ICS URL** for the HTTPS URL or **Subscribe to Calendar** to open the same query as a `webcal://` URL in compatible calendar applications.

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

Open <http://localhost:3000>, start typing to pick a suggested show, sports team, or upcoming movie, and click **Copy ICS URL** to copy the all-time calendar feed URL. Feeds include refresh metadata and API cache revalidation; NHL feeds (including combined calendars containing NHL games) refresh every six hours, while unrelated feeds retain their daily interval.

## Vercel deployment

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FDisabledAbel%2FMakeICS)

## Clear Repo URL workflow

The **Clear Repo URL** GitHub Actions workflow clears the website link in the
repository's **About** section and monitors for it to be restored. It runs on
pushes or manually from the Actions tab. Each removal is checked against the
update response and a fresh repository read; failed updates fail the workflow.

Set the repository Actions secret `PAT_TOKEN` to a token whose owner has admin
access to this repository. A fine-grained token needs **Administration: write**
to update the homepage and **Actions: read** to detect newer workflow runs. A
classic token needs the appropriate `public_repo` or `repo` scope. The default
Actions `GITHUB_TOKEN` cannot grant the repository administration permission.

If a deployment integration keeps restoring the website URL, disable that
integration's repository website updates. This workflow monitors for a bounded
period; it cannot prevent changes made after it stops.

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

### Combined calendars
```http
GET /api/calendar?shows=The%20Last%20of%20Us&shows=Sofia%20the%20First&teamIds=136450&movies=Disney&movieType=studio&tz=America/Los_Angeles&format=ics
```

### Event updates and cancellations

MakeICS keeps each event's stable upstream identity in its `UID`, so a renamed,
rescheduled, relocated, or broadcast-updated event remains the same calendar
event. Feeds emit `SEQUENCE` and, when the source provides trustworthy change
metadata, `LAST-MODIFIED`. `DTSTAMP` is the time the feed response was rendered;
it is not used as an event revision.

VEVENT status is always one of the iCalendar values `CONFIRMED`, `TENTATIVE`, or
`CANCELLED`. Postponed, delayed, suspended, and TBD games use
`STATUS:TENTATIVE` (because `POSTPONED` is not a valid VEVENT status), while the
provider's wording is retained in `X-MAKEICS-STATUS` and combined-calendar JSON.
An event is only cancelled when its source explicitly reports cancellation;
MakeICS does not infer cancellation merely because an event disappears from an
upstream response. Sources without reliable revision metadata use `SEQUENCE:0`
and omit `LAST-MODIFIED` rather than inventing revision history.

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

## Permanent calendar history

Scheduled refreshes archive removed events in `lib/data/archive/events.json`.
Removed TV date and title verifications are saved separately in
`lib/data/archive/google-verified.json`, including the 18 verifications removed by
commit `b942db70ac85ab7907c4c983bd29556df5aecd4a`. Both individual TV and combined
ICS feeds load these archived verifications before applying active corrections,
so pruning a verification does not revert an episode's saved date or title.
Episode UIDs remain unchanged. An explicit `since` parameter still filters history.

The existing Google and Disney workflows run the history guard with `--archive --stage`
before committing. This archives deletions automatically and only commits
when files change. The Calendar History check also rejects unarchived verification
deletions and stale archived copies. To preserve records after a manual data edit,
run this command before committing:

```bash
node scripts/calendar-history.js --baseline=HEAD --archive --stage
```
