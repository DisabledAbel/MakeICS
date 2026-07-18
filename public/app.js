const form = document.querySelector('#search-form');
const showInput = document.querySelector('#show-input');
const sportsInput = document.querySelector('#sports-input');
const moviesInput = document.querySelector('#movies-input');
const movieTypeInput = document.querySelector('#movie-type-input');
const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result');
const suggestionsEl = document.querySelector('#search-suggestions');
const sportsSuggestionsEl = document.querySelector('#sports-suggestions');
const moviesSuggestionsEl = document.querySelector('#movies-suggestions');
const template = document.querySelector('#episode-template');
const tabs = document.querySelectorAll('.tab-btn');
const categoryFields = document.querySelectorAll('.category-field');
const categoryHint = document.querySelector('#category-hint');
const timezoneInput = document.querySelector('#timezone-input');

let currentCategory = 'tv';
let suggestionDebounce;
let suggestionAbortController;
let activeSuggestionIndex = -1;

const CATEGORY_HINTS = {
  tv: 'Start typing to see TV show suggestions below the search bar. The feed includes all episodes from today onwards once added.',
  sports: 'Search for sports teams from TheSportsDB. Copy the ICS URL to track matches from today onwards once added.',
  movies: 'Search for movies, studios, genres, or characters. Copy the ICS URL to track release dates.'
};

// --- Tab Logic ---

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentCategory = tab.dataset.category;

    if (suggestionAbortController) {
      suggestionAbortController.abort();
    }
    suggestionAbortController = null;

    categoryFields.forEach(field => {
      field.classList.remove('active');
      const input = field.querySelector('input');
      if (field.classList.contains(`${currentCategory}-only`)) {
        field.classList.add('active');
        // Movies can be fetched without a query to see all upcoming releases
        if (input) input.required = (currentCategory !== 'movies');
      } else {
        if (input) input.required = false;
      }
    });

    categoryHint.textContent = CATEGORY_HINTS[currentCategory];
    resultEl.hidden = true;
    setStatus('');
    hideSuggestions();
  });
});

// --- Suggestion Logic ---

function hideSuggestions() {
  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = '';
  sportsSuggestionsEl.hidden = true;
  sportsSuggestionsEl.innerHTML = '';
  moviesSuggestionsEl.hidden = true;
  moviesSuggestionsEl.innerHTML = '';
  activeSuggestionIndex = -1;
  showInput.setAttribute('aria-expanded', 'false');
  sportsInput.setAttribute('aria-expanded', 'false');
  moviesInput.setAttribute('aria-expanded', 'false');
}

function showSuggestions(el, input) {
  el.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function suggestionMeta(suggestion, type) {
  if (type === 'tv') {
    return [suggestion.premiered?.slice(0, 4), suggestion.status, suggestion.network].filter(Boolean).join(' · ');
  } else if (type === 'sports') {
    return [suggestion.sport, suggestion.league, suggestion.country].filter(Boolean).join(' · ');
  } else if (type === 'movies') {
    return [suggestion?.releaseDate, suggestion?.category].filter(Boolean).join(' · ');
  }
  return '';
}

function renderSuggestions(suggestions, type) {
  let el, input;
  if (type === 'tv') {
    el = suggestionsEl;
    input = showInput;
  } else if (type === 'sports') {
    el = sportsSuggestionsEl;
    input = sportsInput;
  } else if (type === 'movies') {
    el = moviesSuggestionsEl;
    input = moviesInput;
  }

  el.innerHTML = '';
  activeSuggestionIndex = -1;

  if (!suggestions.length) {
    const empty = document.createElement('div');
    empty.className = 'suggestion-empty';
    let label = 'results';
    if (type === 'tv') label = 'shows';
    else if (type === 'sports') label = 'teams';
    else if (type === 'movies') label = 'movies';
    empty.textContent = `No matching ${label} found.`;
    el.append(empty);
    showSuggestions(el, input);
    return;
  }

  for (const suggestion of suggestions) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'suggestion-option';
    option.setAttribute('role', 'option');
    option.dataset.name = suggestion.name;
    option.dataset.id = suggestion.id;

    const title = document.createElement('span');
    title.className = 'suggestion-title';
    title.textContent = suggestion.name;
    option.append(title);

    const meta = suggestionMeta(suggestion, type);
    if (meta) {
      const details = document.createElement('span');
      details.className = 'suggestion-meta';
      details.textContent = meta;
      option.append(details);
    }

    el.append(option);
  }

  showSuggestions(el, input);
}

function setActiveSuggestion(el, nextIndex) {
  const options = [...el.querySelectorAll('.suggestion-option')];
  if (!options.length) {
    return;
  }

  if (activeSuggestionIndex >= 0) {
    options[activeSuggestionIndex]?.classList.remove('active');
    options[activeSuggestionIndex]?.setAttribute('aria-selected', 'false');
  }

  activeSuggestionIndex = (nextIndex + options.length) % options.length;
  options[activeSuggestionIndex].classList.add('active');
  options[activeSuggestionIndex].setAttribute('aria-selected', 'true');
  options[activeSuggestionIndex].scrollIntoView({ block: 'nearest' });
}

function selectSuggestion(option) {
  if (!option) {
    return;
  }

  if (currentCategory === 'tv') {
    showInput.value = option.dataset.name;
  } else if (currentCategory === 'sports') {
    sportsInput.value = option.dataset.name;
    sportsInput.dataset.teamId = option.dataset.id;
  } else if (currentCategory === 'movies') {
    moviesInput.value = option.dataset.name;
  }

  hideSuggestions();
  form.requestSubmit();
}

async function fetchSuggestions(query, type) {
  suggestionAbortController?.abort();
  suggestionAbortController = new AbortController();

  try {
    let endpoint = '';
    if (type === 'tv') endpoint = '/api/search';
    else if (type === 'sports') endpoint = '/api/sports-search';
    else if (type === 'movies') {
      const movieType = movieTypeInput.value;
      endpoint = `/api/movies-search?type=${encodeURIComponent(movieType)}`;
    }

    const separator = endpoint.includes('?') ? '&' : '?';
    const response = await fetch(`${endpoint}${separator}q=${encodeURIComponent(query)}`, {
      signal: suggestionAbortController.signal
    });

    const isJson = response.headers.get('content-type')?.includes('application/json');
    let payload = null;
    if (isJson) {
      try {
        payload = await response.json();
      } catch (err) {
        // Safe fallback if JSON parsing still fails
      }
    }

    if (!response.ok) {
      const errorMsg = payload?.error || `Unable to load ${type} suggestions (Status: ${response.status}).`;
      throw new Error(errorMsg);
    }

    if (!payload) {
      throw new Error(`Invalid response format from server (Status: ${response.status}).`);
    }

    renderSuggestions(payload.suggestions || [], type);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Failed to fetch suggestions:', error);
      hideSuggestions();
    }
  }
}

// --- UI Helpers ---

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = `status ${isError ? 'error' : ''}`;
}

function safeHttpUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Formats a date for display in the UI with localized time information.
 * @param {string} dateStr - YYYY-MM-DD date string
 * @param {string} timeStr - HH:mm:ss time string
 * @param {string} timestamp - ISO timestamp
 * @param {boolean} includeZones - Whether to include localized ET/PT times (default: false)
 * @param {string} timezone - Selected IANA timezone identifier (default: 'UTC')
 * @returns {string}
 */
function formatAirDate(dateStr, timeStr, timestamp, includeZones = false, timezone = 'UTC') {
  const date = timestamp
    ? new Date(timestamp + (!timestamp.includes('Z') && !/[-+]\d{2}:?\d{2}$/.test(timestamp) ? 'Z' : ''))
    : new Date(`${dateStr}T${timeStr || '00:00:00'}Z`);

  if (Number.isNaN(date.getTime())) {
    return dateStr || 'Date TBD';
  }

  const local = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: (timeStr || timestamp) ? 'short' : undefined
  }).format(date);

  if (includeZones && (timeStr || timestamp)) {
    const timeOptions = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
    const userTime = new Intl.DateTimeFormat('en-US', { ...timeOptions, timeZone: timezone }).format(date);
    const et = new Intl.DateTimeFormat('en-US', { ...timeOptions, timeZone: 'America/New_York' }).format(date);
    const pt = new Intl.DateTimeFormat('en-US', { ...timeOptions, timeZone: 'America/Los_Angeles' }).format(date);

    let timesString = `${et} / ${pt}`;
    if (timezone !== 'America/New_York' && timezone !== 'America/Los_Angeles' && timezone !== 'UTC') {
      timesString = `${userTime} (${timesString})`;
    } else if (timezone === 'UTC') {
      timesString = `${date.toISOString().slice(11, 16)} UTC (${timesString})`;
    }

    return `${local} (${timesString})`;
  }

  return local;
}

function icsUrlForCurrent() {
  let path = '';
  const tz = timezoneInput?.value || 'UTC';
  if (currentCategory === 'tv') {
    path = `/api/episodes?show=${encodeURIComponent(showInput.value)}&format=ics&tz=${encodeURIComponent(tz)}`;
  } else if (currentCategory === 'sports') {
    path = `/api/sports-events?teamId=${encodeURIComponent(sportsInput.dataset.teamId)}&format=ics&tz=${encodeURIComponent(tz)}`;
  } else if (currentCategory === 'movies') {
    const movieType = movieTypeInput.value;
    path = `/api/movies?q=${encodeURIComponent(moviesInput.value)}&type=${encodeURIComponent(movieType)}&format=ics`;
  }
  return new URL(path, window.location.origin).href;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function renderResults(payload, type) {
  resultEl.hidden = false;
  resultEl.innerHTML = '';
  const icsUrl = icsUrlForCurrent();

  const header = document.createElement('div');
  header.className = 'show-header';

  if (type === 'tv') {
    const { show, imdb, episodes } = payload;

    if (show.image) {
      const validImg = safeHttpUrl(show.image);
      if (validImg) {
        const img = document.createElement('img');
        img.src = validImg;
        img.alt = `${show.name} poster`;
        header.append(img);
      }
    }

    const info = document.createElement('div');
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = `${show.status || 'Status unknown'}${show.network ? ` · ${show.network}` : ''}`;
    info.append(eyebrow);

    const title = document.createElement('h2');
    title.textContent = show.name;
    info.append(title);

    const summary = document.createElement('p');
    summary.textContent = (show.summary || 'No show summary is available.').replace(/<[^>]*>/g, '');
    info.append(summary);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const tvmazeLink = document.createElement('a');
    tvmazeLink.href = safeHttpUrl(show.tvmazeUrl) || '#';
    tvmazeLink.target = '_blank';
    tvmazeLink.rel = 'noopener';
    tvmazeLink.textContent = 'Open TVMaze';
    actions.append(tvmazeLink);

    if (show.imdbId) {
      const validImdb = safeHttpUrl(`https://www.imdb.com/title/${show.imdbId}/`);
      if (validImdb) {
        const imdbLink = document.createElement('a');
        imdbLink.href = validImdb;
        imdbLink.target = '_blank';
        imdbLink.rel = 'noopener';
        imdbLink.textContent = 'Open IMDb';
        actions.append(imdbLink);
      }
    }

    if (payload.rt?.url) {
      const validRt = safeHttpUrl(payload.rt.url);
      if (validRt) {
        const rtLink = document.createElement('a');
        rtLink.href = validRt;
        rtLink.target = '_blank';
        rtLink.rel = 'noopener';
        rtLink.textContent = 'Open Rotten Tomatoes';
        actions.append(rtLink);
      }
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-ics-url';
    const validIcs = safeHttpUrl(icsUrl);
    if (validIcs) copyBtn.setAttribute('data-ics-url', validIcs);
    copyBtn.textContent = 'Copy ICS URL';
    actions.append(copyBtn);

    info.append(actions);
    header.append(info);
    resultEl.append(header);

    if (imdb?.sourceConfigured) {
      const imdbPanel = document.createElement('aside');
      imdbPanel.className = 'imdb-panel';
      imdbPanel.textContent = imdb.error
        ? `IMDb enrichment was configured but failed: ${imdb.error}`
        : `IMDb enrichment (${imdb.source || 'IMDb'}): ${[imdb.title, imdb.year, imdb.rating ? `Rating ${imdb.rating}` : '', imdb.warning].filter(Boolean).join(' · ')}`;
      resultEl.append(imdbPanel);
    }

    if (payload.rt?.sourceConfigured) {
      const rtPanel = document.createElement('aside');
      rtPanel.className = 'imdb-panel';
      rtPanel.style.marginTop = '8px';
      const rtDetails = [];
      if (payload.rt.meterScore !== null) {
        rtDetails.push(`Tomatometer: ${payload.rt.meterScore}%`);
      }
      if (payload.rt.meterClass) {
        rtDetails.push(`Class: ${payload.rt.meterClass.replace(/_/g, ' ').toUpperCase()}`);
      }
      if (payload.rt.startYear) {
        rtDetails.push(`Year: ${payload.rt.startYear}`);
      }
      rtPanel.textContent = `Rotten Tomatoes Enrichment: ${rtDetails.length ? rtDetails.join(' · ') : 'Enriched successfully'}`;
      resultEl.append(rtPanel);
    }

    renderList(episodes, 'tv', show, payload.timezone);
  } else if (type === 'sports') {
    const { team, events } = payload;

    if (team.image) {
      const validImg = safeHttpUrl(team.image);
      if (validImg) {
        const img = document.createElement('img');
        img.src = validImg;
        img.alt = `${team.name} badge`;
        header.append(img);
      }
    }

    const info = document.createElement('div');
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = `${team.sport} · ${team.league}`;
    info.append(eyebrow);

    const title = document.createElement('h2');
    title.textContent = team.name;
    info.append(title);

    const summary = document.createElement('p');
    summary.textContent = team.summary || '';
    info.append(summary);

    const actions = document.createElement('div');
    actions.className = 'actions';

    if (team.website) {
      const validWeb = safeHttpUrl(`https://${team.website}`);
      if (validWeb) {
        const webLink = document.createElement('a');
        webLink.href = validWeb;
        webLink.target = '_blank';
        webLink.rel = 'noopener';
        webLink.textContent = 'Website';
        actions.append(webLink);
      }
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-ics-url';
    const validIcs = safeHttpUrl(icsUrl);
    if (validIcs) copyBtn.setAttribute('data-ics-url', validIcs);
    copyBtn.textContent = 'Copy ICS URL';
    actions.append(copyBtn);

    info.append(actions);
    header.append(info);
    resultEl.append(header);
    renderList(events, 'sports', null, payload.timezone);
  } else if (type === 'movies') {
    const { query, movies, personMetadata } = payload;

    if (personMetadata && personMetadata.image) {
      const validImg = safeHttpUrl(personMetadata.image);
      if (validImg) {
        const img = document.createElement('img');
        img.src = validImg;
        img.alt = `${personMetadata.name} photo`;
        header.append(img);
      }
    }

    const info = document.createElement('div');
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = 'Upcoming Movie Releases';
    info.append(eyebrow);

    const title = document.createElement('h2');
    title.textContent = personMetadata ? personMetadata.name : (query || 'All Upcoming Movies');
    info.append(title);

    if (personMetadata && personMetadata.description) {
      const summary = document.createElement('p');
      summary.textContent = personMetadata.description;
      info.append(summary);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-ics-url';
    const validIcs = safeHttpUrl(icsUrl);
    if (validIcs) copyBtn.setAttribute('data-ics-url', validIcs);
    copyBtn.textContent = 'Copy ICS URL';
    actions.append(copyBtn);

    info.append(actions);
    header.append(info);
    resultEl.append(header);
    renderList(movies, 'movies', null, payload.timezone);
  }
}

function isPastEvent(item, type) {
  const now = new Date();
  if (type === 'tv') {
    if (!item.airdate) return false;
    const hasTime = !!item.airtime && item.airtime !== '00:00:00' && item.airtime !== '00:00';
    const date = item.airstamp
      ? new Date(item.airstamp + (!item.airstamp.includes('Z') && !/[-+]\d{2}:?\d{2}$/.test(item.airstamp) ? 'Z' : ''))
      : new Date(`${item.airdate}T${item.airtime || '00:00:00'}Z`);
    if (Number.isNaN(date.getTime())) return false;

    if (hasTime) {
      return date < now;
    } else {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const eventDate = new Date(`${item.airdate}T00:00:00Z`);
      return eventDate < todayStart;
    }
  } else if (type === 'sports') {
    if (!item.date) return false;
    const hasTime = !!item.time && item.time !== '00:00:00' && item.time !== '00:00' && item.time !== 'TBD';
    const date = item.timestamp
      ? new Date(item.timestamp + (!item.timestamp.includes('Z') && !/[-+]\d{2}:?\d{2}$/.test(item.timestamp) ? 'Z' : ''))
      : new Date(`${item.date}T${item.time || '00:00:00'}Z`);
    if (Number.isNaN(date.getTime())) return false;

    if (hasTime) {
      return date < now;
    } else {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const eventDate = new Date(`${item.date}T00:00:00Z`);
      return eventDate < todayStart;
    }
  } else if (type === 'movies') {
    if (!item.date) return false;
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const eventDate = new Date(`${item.date}T00:00:00Z`);
    return eventDate < todayStart;
  }
  return false;
}

function renderList(items, type, context, timezone = 'UTC') {
  const filteredItems = items.filter(item => !isPastEvent(item, type));

  const count = document.createElement('p');
  count.className = 'count';
  count.textContent = filteredItems.length
    ? `${filteredItems.length} event${filteredItems.length === 1 ? '' : 's'} found.`
    : `No events found.`;
  resultEl.append(count);

  const list = document.createElement('div');
  list.className = 'episode-list';

  for (const item of filteredItems) {
    const card = template.content.cloneNode(true);
    const dateEl = card.querySelector('.episode-date');
    const titleEl = card.querySelector('h3');
    const metaEl = card.querySelector('.episode-meta');
    const summaryEl = card.querySelector('.episode-summary');
    const link = card.querySelector('a');

    if (type === 'tv') {
      dateEl.textContent = formatAirDate(item.airdate, item.airtime, item.airstamp, true, timezone);
      titleEl.textContent = item.name;
      const hasSeason = item.season !== null && item.season !== undefined;
      const hasEpisodeNum = item.number !== null && item.number !== undefined;
      const episodeCode = (hasSeason && hasEpisodeNum) ? `S${String(item.season).padStart(2, '0')}E${String(item.number).padStart(2, '0')}` : '';
      metaEl.textContent = [
        episodeCode,
        item.runtime ? `${item.runtime} min` : '',
        item.network ? `Watch on ${item.network}` : ''
      ].filter(Boolean).join(' · ');
      summaryEl.textContent = item.summary || 'No summary available.';
      link.href = item.url || context.tvmazeUrl;

      if (item.rtUrl) {
        const validRtEpUrl = safeHttpUrl(item.rtUrl);
        if (validRtEpUrl) {
          const linkContainer = link.parentElement;
          const rtEpLink = document.createElement('a');
          rtEpLink.href = validRtEpUrl;
          rtEpLink.target = '_blank';
          rtEpLink.rel = 'noopener';
          rtEpLink.textContent = 'Rotten Tomatoes';
          rtEpLink.style.marginLeft = '8px';
          linkContainer.append(rtEpLink);
        }
      }

      const showName = item.showName || context?.name || '';
      const googleSearchQuery = `${showName} ${episodeCode} episode`.replace(/\s+/g, ' ').trim();
      const linkContainer = link.parentElement;
      const googleLink = document.createElement('a');
      googleLink.href = `https://www.google.com/search?q=${encodeURIComponent(googleSearchQuery)}`;
      googleLink.target = '_blank';
      googleLink.rel = 'noopener';
      googleLink.textContent = 'Google Search';
      googleLink.style.marginLeft = '8px';
      linkContainer.append(googleLink);
    } else if (type === 'sports') {
      dateEl.textContent = formatAirDate(item.date, item.time, item.timestamp, true, timezone);
      titleEl.textContent = item.name;
      metaEl.textContent = [item.league, item.venue || 'TBD', item.tvStation ? `Watch on ${item.tvStation}` : ''].filter(Boolean).join(' · ');
      summaryEl.textContent = item.status || '';
      link.remove();
    } else if (type === 'movies') {
      dateEl.textContent = formatAirDate(item.date, null, null, false, timezone);
      titleEl.textContent = item.title;
      metaEl.textContent = [item.genres.join(', '), item.label].filter(Boolean).join(' · ');
      summaryEl.textContent = item.people.join(', ');

      const linkContainer = link.parentElement;
      link.href = `https://www.imdb.com/title/${item.id}/`;
      link.textContent = 'IMDb';

      const trailerLink = document.createElement('a');
      trailerLink.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(item.title + ' trailer')}`;
      trailerLink.target = '_blank';
      trailerLink.rel = 'noopener';
      trailerLink.textContent = 'Trailer';
      trailerLink.style.marginLeft = '8px';
      linkContainer.append(trailerLink);

      const ticketsLink = document.createElement('a');
      ticketsLink.href = `https://www.google.com/search?q=${encodeURIComponent(item.title + ' tickets')}`;
      ticketsLink.target = '_blank';
      ticketsLink.rel = 'noopener';
      ticketsLink.textContent = 'Tickets';
      ticketsLink.style.marginLeft = '8px';
      linkContainer.append(ticketsLink);
    }
    list.append(card);
  }
  resultEl.append(list);
}

// --- Event Listeners ---

[showInput, sportsInput, moviesInput].forEach(inputEl => {
  inputEl.addEventListener('input', () => {
    const query = inputEl.value.trim();
    window.clearTimeout(suggestionDebounce);

    if (inputEl === sportsInput) {
      delete sportsInput.dataset.teamId;
    }

    if (query.length < 2) {
      suggestionAbortController?.abort();
      hideSuggestions();
      return;
    }

    suggestionDebounce = window.setTimeout(async () => {
      try {
        await fetchSuggestions(query, currentCategory);
      } catch (error) {
        if (error.name !== 'AbortError') {
          hideSuggestions();
        }
      }
    }, 250);
  });

  inputEl.addEventListener('keydown', (event) => {
    let el;
    if (currentCategory === 'tv') el = suggestionsEl;
    else if (currentCategory === 'sports') el = sportsSuggestionsEl;
    else if (currentCategory === 'movies') el = moviesSuggestionsEl;

    if (el.hidden) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSuggestion(el, activeSuggestionIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSuggestion(el, activeSuggestionIndex - 1);
    } else if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
      event.preventDefault();
      selectSuggestion(el.querySelectorAll('.suggestion-option')[activeSuggestionIndex]);
    } else if (event.key === 'Escape') {
      hideSuggestions();
    }
  });
});

[suggestionsEl, sportsSuggestionsEl, moviesSuggestionsEl].forEach(el => {
  el.addEventListener('click', (event) => {
    selectSuggestion(event.target.closest('.suggestion-option'));
  });
});

document.addEventListener('click', (event) => {
  if (!form.contains(event.target)) {
    hideSuggestions();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideSuggestions();
  resultEl.hidden = true;

  let url = '';
  let label = '';
  const tz = timezoneInput?.value || 'UTC';

  const since = new Date().toISOString().split('T')[0];
  if (currentCategory === 'tv') {
    label = showInput.value;
    url = `/api/episodes?show=${encodeURIComponent(label)}&tz=${encodeURIComponent(tz)}&since=${since}`;
  } else if (currentCategory === 'sports') {
    const teamId = sportsInput.dataset.teamId;
    if (!teamId || teamId === 'undefined') {
      setStatus('Please select a team from the suggestions.', true);
      return;
    }
    label = sportsInput.value;
    url = `/api/sports-events?teamId=${encodeURIComponent(teamId)}&tz=${encodeURIComponent(tz)}&since=${since}`;
  } else if (currentCategory === 'movies') {
    label = moviesInput.value || 'All Movies';
    const movieType = movieTypeInput.value;
    url = `/api/movies?q=${encodeURIComponent(moviesInput.value)}&type=${encodeURIComponent(movieType)}`;
  }

  setStatus(`Fetching for ${label}...`);

  try {
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'The lookup failed.');
    setStatus('');
    payload.timezone = tz;
    renderResults(payload, currentCategory);
  } catch (error) {
    setStatus(error.message, true);
  }
});

resultEl.addEventListener('click', async (event) => {
  const button = event.target.closest('.copy-ics-url');
  if (!button) return;

  const originalText = button.textContent;
  try {
    await copyText(button.dataset.icsUrl);
    button.textContent = 'Copied ICS URL';
    setStatus('ICS calendar URL copied to your clipboard.');
  } catch (error) {
    button.textContent = originalText;
    setStatus(`Unable to copy ICS URL: ${error.message}`, true);
    return;
  }
  setTimeout(() => { button.textContent = originalText; }, 2000);
});
