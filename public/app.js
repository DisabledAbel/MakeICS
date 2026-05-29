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
  header.innerHTML = `
    ${show.image ? `<img src="${show.image}" alt="${show.name} poster" />` : ''}
    <div>
      <p class="eyebrow">${show.status || 'Status unknown'}${show.network ? ` · ${show.network}` : ''}</p>
      <h2>${show.name}</h2>
      <p>${show.summary || 'No show summary is available.'}</p>
      <div class="actions">
        <a href="${show.tvmazeUrl}" target="_blank" rel="noopener">Open TVMaze</a>
        ${show.imdbId ? `<a href="https://www.imdb.com/title/${show.imdbId}/" target="_blank" rel="noopener">Open IMDb</a>` : ''}
        <a href="/api/episodes?show=${encodeURIComponent(show.name)}&days=${encodeURIComponent(days)}&format=ics">Download ICS</a>
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
