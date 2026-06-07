const form = document.querySelector('#search-form');
const showInput = document.querySelector('#show-input');
const sportsInput = document.querySelector('#sports-input');
const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result');
const suggestionsEl = document.querySelector('#search-suggestions');
const sportsSuggestionsEl = document.querySelector('#sports-suggestions');
const template = document.querySelector('#episode-template');
const tabs = document.querySelectorAll('.tab-btn');
const categoryFields = document.querySelectorAll('.category-field');
const categoryHint = document.querySelector('#category-hint');

let currentCategory = 'tv';
let suggestionDebounce;
let suggestionAbortController;
let activeSuggestionIndex = -1;

const CATEGORY_HINTS = {
  tv: 'Start typing to see TV show suggestions below the search bar. The all-time feed uses TVMaze for show and episode schedules.',
  sports: 'Search for sports teams from TheSportsDB. Copy the ICS URL to track upcoming matches.'
};

// --- Tab Logic ---

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentCategory = tab.dataset.category;

    categoryFields.forEach(field => {
      field.classList.remove('active');
      const input = field.querySelector('input');
      if (field.classList.contains(`${currentCategory}-only`)) {
        field.classList.add('active');
        if (input) input.required = true;
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
  activeSuggestionIndex = -1;
  showInput.setAttribute('aria-expanded', 'false');
  sportsInput.setAttribute('aria-expanded', 'false');
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
  }
  return '';
}

function renderSuggestions(suggestions, type) {
  const el = type === 'tv' ? suggestionsEl : sportsSuggestionsEl;
  const input = type === 'tv' ? showInput : sportsInput;

  el.innerHTML = '';
  activeSuggestionIndex = -1;

  if (!suggestions.length) {
    const empty = document.createElement('div');
    empty.className = 'suggestion-empty';
    empty.textContent = `No matching ${type === 'tv' ? 'shows' : 'teams'} found.`;
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
  }

  hideSuggestions();
  form.requestSubmit();
}

async function fetchSuggestions(query, type) {
  suggestionAbortController?.abort();
  suggestionAbortController = new AbortController();

  const endpoint = type === 'tv' ? '/api/search' : '/api/sports-search';
  const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, {
    signal: suggestionAbortController.signal
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || `Unable to load ${type} suggestions.`);
  }

  renderSuggestions(payload.suggestions || [], type);
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

function formatAirDate(dateStr, timeStr, timestamp, includeZones = false) {
  const date = timestamp ? new Date(timestamp) : new Date(`${dateStr}T${timeStr || '00:00'}`);
  if (Number.isNaN(date.getTime())) {
    return dateStr || 'Date TBA';
  }
  const local = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: (timeStr || timestamp) ? 'short' : undefined
  }).format(date);

  if (includeZones && (timeStr || timestamp)) {
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
    const pt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
    return `${local} (${et} / ${pt})`;
  }

  return local;
}

function icsUrlForCurrent() {
  let path = '';
  if (currentCategory === 'tv') {
    path = `/api/episodes?show=${encodeURIComponent(showInput.value)}&format=ics`;
  } else if (currentCategory === 'sports') {
    const tz = document.querySelector('#timezone-input')?.value || 'UTC';
    path = `/api/sports-events?teamId=${encodeURIComponent(sportsInput.dataset.teamId)}&format=ics&tz=${encodeURIComponent(tz)}`;
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

    renderList(episodes, 'tv', show);
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
  }
}

function renderList(items, type, context, timezone = 'UTC') {
  const count = document.createElement('p');
  count.className = 'count';
  count.textContent = items.length
    ? `${items.length} upcoming event${items.length === 1 ? '' : 's'} found.`
    : `No upcoming events found.`;
  resultEl.append(count);

  const list = document.createElement('div');
  list.className = 'episode-list';

  for (const item of items) {
    const card = template.content.cloneNode(true);
    const dateEl = card.querySelector('.episode-date');
    const titleEl = card.querySelector('h3');
    const metaEl = card.querySelector('.episode-meta');
    const summaryEl = card.querySelector('.episode-summary');
    const link = card.querySelector('a');

    if (type === 'tv') {
      dateEl.textContent = formatAirDate(item.airdate, item.airtime, item.airstamp);
      titleEl.textContent = item.name;
      metaEl.textContent = [
        item.season && item.number ? `S${String(item.season).padStart(2, '0')}E${String(item.number).padStart(2, '0')}` : '',
        item.runtime ? `${item.runtime} min` : '',
        item.network
      ].filter(Boolean).join(' · ');
      summaryEl.textContent = item.summary || 'No summary available.';
      link.href = item.url || context.tvmazeUrl;
    } else if (type === 'sports') {
      let date;
      if (item.timestamp) {
        const needsZ = !item.timestamp.includes('Z') && !/[+-]\d{2}:\d{2}$/.test(item.timestamp);
        date = new Date(item.timestamp + (needsZ ? 'Z' : ''));
      } else {
        date = new Date(`${item.date}T${item.time || '00:00:00'}Z`);
      }
      const local = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
      const userTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: timezone }).format(date);
      const et = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' }).format(date);
      const pt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/Los_Angeles' }).format(date);

      let timesString = `${et} / ${pt}`;
      if (timezone !== 'America/New_York' && timezone !== 'America/Los_Angeles' && timezone !== 'UTC') {
        timesString = `${userTime} (${timesString})`;
      }

      dateEl.textContent = `${local} (${timesString})`;
      titleEl.textContent = item.name;
      metaEl.textContent = [item.league, item.venue].filter(Boolean).join(' · ');
      summaryEl.textContent = item.status || '';
      link.remove();
    }
    list.append(card);
  }
  resultEl.append(list);
}

// --- Event Listeners ---

[showInput, sportsInput].forEach(input => {
  input.addEventListener('input', () => {
    const query = input.value.trim();
    window.clearTimeout(suggestionDebounce);

    if (input === sportsInput) {
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

  input.addEventListener('keydown', (event) => {
    const el = currentCategory === 'tv' ? suggestionsEl : sportsSuggestionsEl;
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

[suggestionsEl, sportsSuggestionsEl].forEach(el => {
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

  if (currentCategory === 'tv') {
    label = showInput.value;
    url = `/api/episodes?show=${encodeURIComponent(label)}`;
  } else if (currentCategory === 'sports') {
    const teamId = sportsInput.dataset.teamId;
    if (!teamId || teamId === 'undefined') {
      setStatus('Please select a team from the suggestions.', true);
      return;
    }
    label = sportsInput.value;
    url = `/api/sports-events?teamId=${encodeURIComponent(teamId)}`;
  }

  setStatus(`Fetching for ${label}...`);

  try {
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'The lookup failed.');
    setStatus('');
    if (currentCategory === 'sports') {
      payload.timezone = document.querySelector('#timezone-input')?.value || 'UTC';
    }
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
