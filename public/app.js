const form = document.querySelector('#search-form');
const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result');
const template = document.querySelector('#episode-template');

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

function renderResults(payload, days) {
  const { show, imdb, episodes, window: resultWindow } = payload;
  resultEl.hidden = false;
  resultEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'show-header';

  // Conditionally add poster image
  if (show.image) {
    const img = document.createElement('img');
    img.src = show.image;
    img.alt = `${show.name} poster`;
    header.append(img);
  }

  const contentDiv = document.createElement('div');

  // Eyebrow (status and network)
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = `${show.status || 'Status unknown'}${show.network ? ` · ${show.network}` : ''}`;
  contentDiv.append(eyebrow);

  // Title
  const title = document.createElement('h2');
  title.textContent = show.name;
  contentDiv.append(title);

  // Summary
  const summary = document.createElement('p');
  summary.textContent = show.summary || 'No show summary is available.';
  contentDiv.append(summary);

  // Actions container
  const actions = document.createElement('div');
  actions.className = 'actions';

  // TVMaze link
  const tvmazeLink = document.createElement('a');
  tvmazeLink.href = show.tvmazeUrl;
  tvmazeLink.target = '_blank';
  tvmazeLink.rel = 'noopener';
  tvmazeLink.textContent = 'Open TVMaze';
  actions.append(tvmazeLink);

  // IMDb link (conditional)
  if (show.imdbId) {
    const imdbLink = document.createElement('a');
    imdbLink.href = `https://www.imdb.com/title/${show.imdbId}/`;
    imdbLink.target = '_blank';
    imdbLink.rel = 'noopener';
    imdbLink.textContent = 'Open IMDb';
    actions.append(imdbLink);
  }

  // ICS download link
  const icsLink = document.createElement('a');
  icsLink.href = `/api/episodes?show=${encodeURIComponent(show.name)}&days=${encodeURIComponent(days)}&format=ics`;
  icsLink.textContent = 'Download ICS';
  actions.append(icsLink);

  contentDiv.append(actions);
  header.append(contentDiv);
  resultEl.append(header);

  if (imdb?.sourceConfigured) {
    const imdbPanel = document.createElement('aside');
    imdbPanel.className = 'imdb-panel';
    imdbPanel.textContent = imdb.error
      ? `IMDb enrichment was configured but failed: ${imdb.error}`
      : `IMDb enrichment: ${[imdb.title, imdb.year, imdb.rating ? `Rating ${imdb.rating}` : ''].filter(Boolean).join(' · ')}`;
    resultEl.append(imdbPanel);
  }

  const count = document.createElement('p');
  count.className = 'count';
  count.textContent = episodes.length
    ? `${episodes.length} upcoming episode${episodes.length === 1 ? '' : 's'} between ${resultWindow.from} and ${resultWindow.to}.`
    : `No upcoming episodes found between ${resultWindow.from} and ${resultWindow.to}.`;
  resultEl.append(count);

  const list = document.createElement('div');
  list.className = 'episode-list';

  for (const episode of episodes) {
    const card = template.content.cloneNode(true);
    card.querySelector('.episode-date').textContent = formatAirDate(episode);
    card.querySelector('h3').textContent = episode.name;
    card.querySelector('.episode-meta').textContent = [formatEpisodeCode(episode), episode.runtime ? `${episode.runtime} min` : '', episode.network].filter(Boolean).join(' · ');
    card.querySelector('.episode-summary').textContent = episode.summary || 'No episode summary is available yet.';
    const link = card.querySelector('a');
    link.href = episode.url || show.tvmazeUrl;
    list.append(card);
  }

  resultEl.append(list);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const show = data.get('show');
  const days = data.get('days');

  resultEl.hidden = true;
  setStatus(`Fetching upcoming episodes for ${show}...`);

  try {
    const response = await fetch(`/api/episodes?show=${encodeURIComponent(show)}&days=${encodeURIComponent(days)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'The episode lookup failed.');
    }
    setStatus('');
    renderResults(payload, days);
  } catch (error) {
    setStatus(error.message, true);
  }
});
