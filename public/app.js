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
const countrySelect = document.querySelector('#country-select');
const subdivisionSelect = document.querySelector('#subdivision-select');

let currentCategory = 'tv';
let suggestionDebounce;
let suggestionAbortController;
let activeSuggestionIndex = -1;

const CATEGORY_HINTS = {
  tv: 'Start typing to see TV show suggestions below the search bar. The all-time feed uses TVMaze for show and episode schedules.',
  sports: 'Search for sports teams from TheSportsDB. Copy the ICS URL to track upcoming matches.',
  school: 'Select a country and region to get school holiday dates from OpenHolidays.'
};

// --- Tab Logic ---

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentCategory = tab.dataset.category;

    categoryFields.forEach(field => {
      field.classList.remove('active');
      if (field.classList.contains(`${currentCategory}-only`)) {
        field.classList.add('active');
      }
    });

    categoryHint.textContent = CATEGORY_HINTS[currentCategory];
    resultEl.hidden = true;
    setStatus('');
    hideSuggestions();

    if (currentCategory === 'school' && countrySelect.options.length <= 1) {
      loadCountries();
    }
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

// --- School Logic ---

async function loadCountries() {
  try {
    const response = await fetch('/api/school-search');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    countrySelect.innerHTML = '<option value="">Select Country</option>';
    data.countries.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.code;
      opt.textContent = c.name[0]?.text || c.code;
      countrySelect.appendChild(opt);
    });
  } catch (error) {
    setStatus(`Failed to load countries: ${error.message}`, true);
  }
}

countrySelect.addEventListener('change', async () => {
  const countryCode = countrySelect.value;
  subdivisionSelect.innerHTML = '<option value="">Select Region (Optional)</option>';
  subdivisionSelect.disabled = true;

  if (!countryCode) return;

  try {
    const response = await fetch(`/api/school-search?countryCode=${countryCode}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    if (data.subdivisions && data.subdivisions.length > 0) {
      data.subdivisions.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.code;
        opt.textContent = s.shortName || s.name[0]?.text || s.code;
        subdivisionSelect.appendChild(opt);
      });
      subdivisionSelect.disabled = false;
    }
  } catch (error) {
    console.error('Failed to load regions', error);
  }
});

// --- UI Helpers ---

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = `status ${isError ? 'error' : ''}`;
}

function formatAirDate(dateStr, timeStr, timestamp, type) {
  const date = timestamp ? new Date(timestamp) : new Date(`${dateStr}T${timeStr || '00:00'}`);
  if (Number.isNaN(date.getTime())) {
    return dateStr || 'Date TBA';
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: (timeStr || timestamp) && type !== 'school' ? 'short' : undefined
  }).format(date);
}

function icsUrlForCurrent() {
  let path = '';
  if (currentCategory === 'tv') {
    path = `/api/episodes?show=${encodeURIComponent(showInput.value)}&format=ics`;
  } else if (currentCategory === 'sports') {
    path = `/api/sports-events?teamId=${encodeURIComponent(sportsInput.dataset.teamId)}&format=ics`;
  } else if (currentCategory === 'school') {
    path = `/api/school-holidays?countryCode=${encodeURIComponent(countrySelect.value)}`;
    if (subdivisionSelect.value) {
      path += `&subdivisionCode=${encodeURIComponent(subdivisionSelect.value)}`;
    }
    path += '&format=ics';
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
    header.innerHTML = `
      ${show.image ? `<img src="${show.image}" alt="${show.name} poster" />` : ''}
      <div>
        <p class="eyebrow">${show.status || 'Status unknown'}${show.network ? ` · ${show.network}` : ''}</p>
        <h2>${show.name}</h2>
        <p>${show.summary || 'No show summary is available.'}</p>
        <div class="actions">
          <a href="${show.tvmazeUrl}" target="_blank" rel="noopener">Open TVMaze</a>
          ${show.imdbId ? `<a href="https://www.imdb.com/title/${show.imdbId}/" target="_blank" rel="noopener">Open IMDb</a>` : ''}
          <button type="button" class="copy-ics-url" data-ics-url="${icsUrl}">Copy ICS URL</button>
        </div>
      </div>
    `;
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
    header.innerHTML = `
      ${team.image ? `<img src="${team.image}" alt="${team.name} badge" />` : ''}
      <div>
        <p class="eyebrow">${team.sport} · ${team.league}</p>
        <h2>${team.name}</h2>
        <p>${team.summary || ''}</p>
        <div class="actions">
          ${team.website ? `<a href="https://${team.website}" target="_blank" rel="noopener">Website</a>` : ''}
          <button type="button" class="copy-ics-url" data-ics-url="${icsUrl}">Copy ICS URL</button>
        </div>
      </div>
    `;
    resultEl.append(header);
    renderList(events, 'sports');
  } else if (type === 'school') {
    const { holidays, countryCode, subdivisionCode } = payload;
    header.innerHTML = `
      <div>
        <p class="eyebrow">School Holidays</p>
        <h2>${subdivisionCode ? `${subdivisionCode}, ` : ''}${countryCode}</h2>
        <div class="actions">
          <button type="button" class="copy-ics-url" data-ics-url="${icsUrl}">Copy ICS URL</button>
        </div>
      </div>
    `;
    resultEl.append(header);
    renderList(holidays, 'school');
  }
}

function renderList(items, type, context) {
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
      dateEl.textContent = formatAirDate(item.airdate, item.airtime, item.airstamp, 'tv');
      titleEl.textContent = item.name;
      metaEl.textContent = [
        item.season && item.number ? `S${String(item.season).padStart(2, '0')}E${String(item.number).padStart(2, '0')}` : '',
        item.runtime ? `${item.runtime} min` : '',
        item.network
      ].filter(Boolean).join(' · ');
      summaryEl.textContent = item.summary || 'No summary available.';
      link.href = item.url || context.tvmazeUrl;
    } else if (type === 'sports') {
      dateEl.textContent = formatAirDate(item.date, item.time, item.timestamp, 'sports');
      titleEl.textContent = item.name;
      metaEl.textContent = [item.league, item.venue].filter(Boolean).join(' · ');
      summaryEl.textContent = item.status || '';
      link.remove();
    } else if (type === 'school') {
      dateEl.textContent = `${item.startDate} to ${item.endDate}`;
      titleEl.textContent = item.name;
      metaEl.textContent = item.type;
      summaryEl.textContent = '';
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
    label = sportsInput.value;
    url = `/api/sports-events?teamId=${encodeURIComponent(sportsInput.dataset.teamId)}`;
  } else if (currentCategory === 'school') {
    label = countrySelect.value;
    if (!label) return setStatus('Please select a country.', true);
    url = `/api/school-holidays?countryCode=${encodeURIComponent(label)}`;
    if (subdivisionSelect.value) {
      url += `&subdivisionCode=${encodeURIComponent(subdivisionSelect.value)}`;
    }
  }

  setStatus(`Fetching for ${label}...`);

  try {
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'The lookup failed.');
    setStatus('');
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
