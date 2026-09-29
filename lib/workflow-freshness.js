const REQUIRED_STEPS = {
  'fetch-imdb.yml': ['Fetch IMDb TV Schedules', 'Validate and stage fetched data'],
  'fetch-sports.yml': ['Fetch Schedules', 'Validate and stage fetched data'],
  'fetch-nfl.yml': ['Fetch NFL Schedules', 'Validate and stage fetched data'],
  'fetch-milb.yml': ['Fetch MiLB Schedules', 'Validate and stage fetched data']
};

function headers(token) {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
}

async function githubJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: headers(token) });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`GitHub Actions API returned ${response.status} for ${url}${detail ? `: ${detail}` : ''}`);
  }
  return response.json();
}

async function completedRequiredSteps(fetchImpl, repository, token, run, requiredSteps) {
  if (!requiredSteps?.length) return run.conclusion === 'success';
  const seen = new Map();
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`;
    const jobs = (await githubJson(fetchImpl, url, token)).jobs || [];
    for (const job of jobs) for (const step of job.steps || []) seen.set(step.name, step.conclusion);
    if (jobs.length < 100) break;
  }
  return requiredSteps.every(step => seen.get(step) === 'success');
}

/** Find the newest run that actually fetched and validated output, not merely a
 * green run whose relevant job or step was skipped. Pages are followed because
 * a busy workflow can have more than 100 cancelled/skipped/failed runs.
 */
export async function findLastValidatedRun({ repository, token, workflow, fetchImpl = fetch, maxPages = 10 }) {
  const requiredSteps = REQUIRED_STEPS[workflow];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?per_page=100&page=${page}`;
    const runs = (await githubJson(fetchImpl, url, token)).workflow_runs || [];
    for (const run of runs) {
      if (run.status === 'completed' && run.conclusion === 'success' &&
          await completedRequiredSteps(fetchImpl, repository, token, run, requiredSteps)) return run;
    }
    if (runs.length < 100) return null;
  }
  throw new Error(`No validated ${workflow} run found in the newest ${maxPages * 100} workflow runs`);
}

export async function successfulWorkflowRuns({ sources, repository, token, fetchImpl = fetch }) {
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const workflows = [...new Set(sources.map(source => source.workflow))];
  const entries = await Promise.all(workflows.map(async workflow => {
    const run = await findLastValidatedRun({ repository, token, workflow, fetchImpl });
    return [workflow, run?.updated_at || null];
  }));
  return Object.fromEntries(entries.filter(([, date]) => date));
}
