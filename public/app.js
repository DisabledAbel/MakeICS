const form = document.querySelector('#search-form');
const showInput = document.querySelector('#show-input');
const timezoneInput = document.querySelector('#timezone-input');
const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result');
const suggestionsEl = document.querySelector('#search-suggestions');
const template = document.querySelector('#episode-template');

let suggestionDebounce;
let suggestionAbortController;
let activeSuggestionIndex = -1;

function hideSuggestions() {
  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = '';
  activeSuggestionIndex = -1;
  showInput.setAttribute('aria-expanded', 'false');
}

function showSuggestions() {
  suggestionsEl.hidden = false;
  showInput.setAttribute('aria-expanded', 'true');
}

function suggestionMeta(suggestion) {
  return [suggestion.premiered?.slice(0, 4), suggestion.status, suggestion.network].filter(Boolean).join(' · ');
}

function renderSuggestions(suggestions) {
  suggestionsEl.innerHTML = '';
  activeSuggestionIndex = -1;

  if (!suggestions.length) {
    const empty = document.createElement('div');
    empty.className = 'suggestion-empty';
    empty.textContent = 'No matching shows found.';
    suggestionsEl.append(empty);
    showSuggestions();
    return;
  }

  for (const suggestion of suggestions) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'suggestion-option';
    option.setAttribute('role', 'option');
    option.dataset.showName = suggestion.name;

    const title = document.createElement('span');
    title.className = 'suggestion-title';
    title.textContent = suggestion.name;
    option.append(title);

    const meta = suggestionMeta(suggestion);
    if (meta) {
      const details = document.createElement('span');
      details.className = 'suggestion-meta';
      details.textContent = meta;
      option.append(details);
    }

    suggestionsEl.append(option);
  }

  showSuggestions();
}

function setActiveSuggestion(nextIndex) {
  const options = [...suggestionsEl.querySelectorAll('.suggestion-option')];
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

  showInput.value = option.dataset.showName;
  hideSuggestions();
  form.requestSubmit();
}

async function fetchSuggestions(query) {
  suggestionAbortController?.abort();
  suggestionAbortController = new AbortController();

  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
    signal: suggestionAbortController.signal
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Unable to load show suggestions.');
  }

  renderSuggestions(payload.suggestions || []);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = `status ${isError ? 'error' : ''}`;
}

function formatEpisodeCode(episode) {
  if (!episode.season || !episode.number) {
    return 'Episode TBA';
  }
  return `S${String(episode.season).padStart(2, '0')}E${String(episode.number).padStart(2, '0')}`;
}

function formatAirDate(episode) {
  const date = episode.airstamp ? new Date(episode.airstamp) : new Date(`${episode.airdate}T${episode.airtime || '00:00'}`);
  if (Number.isNaN(date.getTime())) {
    return episode.airdate || 'Date TBA';
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: episode.airtime || episode.airstamp ? 'short' : undefined
  }).format(date);
}

function formatEpisodeAbout(episode) {
  const details = [];

  if (episode.network) {
    details.push(`Airs on ${episode.network}.`);
  }

  details.push(episode.summary || 'No episode summary is available yet.');
  return details.join(' ');
}

function selectedTimezone() {
  return timezoneInput.value === 'pst' ? 'pst' : 'est';
}

function timezoneLabel(timezone = selectedTimezone()) {
  return timezone === 'pst' ? 'PST' : 'EST';
}

function icsUrlForShow(showName, timezone = selectedTimezone()) {
  const path = `/api/episodes?show=${encodeURIComponent(showName)}&format=ics&tz=${encodeURIComponent(timezone)}`;
  return new URL(path, window.location.origin).href;
}

function updateFeedButtons(showName, timezone = selectedTimezone()) {
  for (const button of resultEl.querySelectorAll('.copy-ics-url')) {
    button.dataset.icsUrl = icsUrlForShow(showName || button.dataset.showName, timezone);
    button.dataset.showName = showName || button.dataset.showName;
    button.textContent = `Copy ${timezoneLabel(timezone)} ICS URL`;
  }
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

function renderResults(payload, feedTimezone = selectedTimezone()) {
  const { show, imdb, episodes, window: resultWindow } = payload;
  const icsUrl = icsUrlForShow(show.name, feedTimezone);
  resultEl.hidden = false;
  resultEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'show-header';
  header.innerHTML = `
    ${show.image ? `<img src="${show.image}" alt="${show.name} poster" />` : ''}
    <div>
      <p class="eyebrow">${show.status || 'Status unknown'}${show.network ? ` · ${show.network}` : ''}</p>
      <h2>${show.name}</h2>
      <p>${show.summary || 'No show summary is available.'}</p>
      <div class="actions">
        <a href="${show.tvmazeUrl}" target="_blank" rel="noopener">Open TVMaze</a>
        ${show.imdbId ? `<a href="https://www.imdb.com/title/${show.imdbId}/" target="_blank" rel="noopener">Open IMDb</a>` : ''}
        <button type="button" class="copy-ics-url" data-show-name="${show.name}" data-ics-url="${icsUrl}">Copy ${timezoneLabel(feedTimezone)} ICS URL</button>
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

  const count = document.createElement('p');
  count.className = 'count';
  count.textContent = episodes.length
    ? `${episodes.length} known upcoming episode${episodes.length === 1 ? '' : 's'} from ${resultWindow.from} onward.`
    : `No upcoming episodes found from ${resultWindow.from} onward.`;
  resultEl.append(count);

  const list = document.createElement('div');
  list.className = 'episode-list';

  for (const episode of episodes) {
    const card = template.content.cloneNode(true);
    card.querySelector('.episode-date').textContent = formatAirDate(episode);
    card.querySelector('h3').textContent = episode.name;
    card.querySelector('.episode-meta').textContent = [formatEpisodeCode(episode), episode.runtime ? `${episode.runtime} min` : '', episode.network].filter(Boolean).join(' · ');
    card.querySelector('.episode-summary').textContent = formatEpisodeAbout(episode);
    const link = card.querySelector('a');
    link.href = episode.url || show.tvmazeUrl;
    list.append(card);
  }

  resultEl.append(list);
}

showInput.addEventListener('input', () => {
  const query = showInput.value.trim();
  window.clearTimeout(suggestionDebounce);

  if (query.length < 2) {
    suggestionAbortController?.abort();
    hideSuggestions();
    return;
  }

  suggestionDebounce = window.setTimeout(async () => {
    try {
      await fetchSuggestions(query);
    } catch (error) {
      if (error.name !== 'AbortError') {
        hideSuggestions();
      }
    }
  }, 250);
});

showInput.addEventListener('keydown', (event) => {
  if (suggestionsEl.hidden) {
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    setActiveSuggestion(activeSuggestionIndex + 1);
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    setActiveSuggestion(activeSuggestionIndex - 1);
  }

  if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
    event.preventDefault();
    selectSuggestion(suggestionsEl.querySelectorAll('.suggestion-option')[activeSuggestionIndex]);
  }

  if (event.key === 'Escape') {
    hideSuggestions();
  }
});

suggestionsEl.addEventListener('click', (event) => {
  selectSuggestion(event.target.closest('.suggestion-option'));
});

document.addEventListener('click', (event) => {
  if (!form.contains(event.target)) {
    hideSuggestions();
  }
});

timezoneInput.addEventListener('change', () => {
  const button = resultEl.querySelector('.copy-ics-url');
  if (button?.dataset.showName) {
    updateFeedButtons(button.dataset.showName);
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const show = data.get('show');
  const feedTimezone = selectedTimezone();

  hideSuggestions();
  resultEl.hidden = true;
  setStatus(`Fetching upcoming episodes for ${show}...`);

  try {
    const response = await fetch(`/api/episodes?show=${encodeURIComponent(show)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'The episode lookup failed.');
    }
    setStatus('');
    renderResults(payload, feedTimezone);
  } catch (error) {
    setStatus(error.message, true);
  }
});

resultEl.addEventListener('click', async (event) => {
  const button = event.target.closest('.copy-ics-url');
  if (!button) {
    return;
  }

  const originalText = button.textContent;
  try {
    await copyText(button.dataset.icsUrl);
    button.textContent = `Copied ${timezoneLabel(selectedTimezone())} ICS URL`;
    setStatus(`${timezoneLabel(selectedTimezone())} ICS calendar URL copied to your clipboard.`);
  } catch (error) {
    button.textContent = originalText;
    setStatus(`Unable to copy ICS URL: ${error.message}`, true);
    return;
  }

  setTimeout(() => {
    button.textContent = originalText;
  }, 2000);
});
