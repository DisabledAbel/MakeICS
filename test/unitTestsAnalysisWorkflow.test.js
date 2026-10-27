import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const yamlText = await fs.readFile(new URL('../.github/workflows/unit-tests-analysis.yml', import.meta.url), 'utf8');
const pinnedAction = /@[a-f0-9]{40} # v\d+(?:\.\d+){0,2}$/;

function step(name) {
  const marker = `- name: ${name}`;
  const index = yamlText.indexOf(marker);
  assert.notEqual(index, -1, `Missing step: ${name}`);
  return yamlText.slice(index + marker.length).split('\n      - name:')[0];
}

test('daily/manual runs are serialized and have a time limit', () => {
  assert.match(yamlText, /cron: '0 12 \* \* \*'/);
  assert.match(yamlText, /workflow_dispatch:/);
  assert.match(yamlText, /group: unit-tests-analysis-\$\{\{ github.ref \}\}/);
  assert.match(yamlText, /cancel-in-progress: false/);
  assert.match(yamlText, /timeout-minutes: 30/);
});

test('only issue writes are allowed; checkout credentials are not persisted', () => {
  assert.doesNotMatch(yamlText, /contents: write/);
  assert.match(yamlText, /issues: write/);
  assert.match(step('Checkout Code'), /persist-credentials: false/);
  assert.doesNotMatch(step('Checkout Code'), /fetch-depth: 0/);
  for (const use of yamlText.matchAll(/uses: (.+)/g)) {
    assert.match(use[1], pinnedAction);
  }
});

test('action pins accept version comments while still requiring a full commit SHA', () => {
  const sha = 'a'.repeat(40);
  for (const version of ['v7', 'v7.0', 'v7.0.2']) {
    assert.match(`actions/upload-artifact@${sha} # ${version}`, pinnedAction);
  }
  for (const ref of ['v7', 'main', 'abc1234']) {
    assert.doesNotMatch(`actions/upload-artifact@${ref} # v7.0.2`, pinnedAction);
  }
});

test('both language runtimes and Python Playwright are installed before analysis', () => {
  assert.match(step('Setup Node.js'), /node-version: '24'/);
  assert.match(step('Setup Python'), /python-version: '3.12'/);
  assert.match(step('Install dependencies'), /npm ci/);
  assert.match(step('Install dependencies'), /python -m pip install playwright/);
  assert.match(step('Install Playwright Browsers'), /npx playwright install chromium --with-deps/);
  assert.match(step('Run Scan and OpenRouter Analysis'), /id: analysis/);
  assert.doesNotMatch(step('Run Scan and OpenRouter Analysis'), /continue-on-error/);
});

test('logs are retained after failure and issue publication cannot hide the failure', () => {
  assert.match(step('Upload analysis artifacts'), /always\(\)/);
  assert.match(step('Upload analysis artifacts'), /analysis-logs\/\*\.log/);
  const publish = step('Create or update GitHub Issue with Findings');
  assert.match(publish, /!cancelled\(\).*steps.analysis.outcome == 'failure'/);
  assert.match(publish, /hashFiles\('analysis-report.md'\)/);
  assert.match(publish, /gh api --paginate/);
  assert.match(publish, /creator=github-actions%5Bbot%5D/);
  assert.match(publish, /gh issue edit/);
  assert.match(publish, /gh issue create/);
  assert.doesNotMatch(publish, /--label/);
  const shell = publish.split('        run: |\n')[1].replace(/^          /gm, '');
  assert.equal(spawnSync('bash', ['-n'], { input: shell }).status, 0);
});

for (const existing of [false, true]) {
  test(`issue publication ${existing ? 'updates an existing issue' : 'creates an issue'} without executing report content`, async (t) => {
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-publish-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const branch = 'branch-with-"quotes';
    const title = `🔍 Codebase Analysis Report: ${branch}`;
    await fs.writeFile(path.join(root, 'analysis-report.md'), 'Untrusted: $(touch injected)');
    await fs.writeFile(path.join(root, 'gh'), `#!/bin/sh
if [ "$1" = api ]; then
  printf '%s\\n' '${JSON.stringify({ number: 42, title: existing ? title : 'Unrelated issue' })}'
else
  printf '%s\\n' "$@" > "$PWD/gh-args"
fi
`, { mode: 0o755 });
    const shell = step('Create or update GitHub Issue with Findings').split('        run: |\n')[1].replace(/^          /gm, '');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_REF_NAME: branch,
        GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_RUN_ID: '123', GITHUB_SHA: 'abc', GH_REPO: 'owner/repo', GH_TOKEN: '' }
    });
    assert.equal(result.status, 0, result.stderr);
    const args = await fs.readFile(path.join(root, 'gh-args'), 'utf8');
    assert.match(args, existing ? /issue\nedit\n42/ : /issue\ncreate\n--title/);
    assert.match(args, /--body-file\nanalysis-report.md/);
    await assert.rejects(fs.access(path.join(root, 'injected')), { code: 'ENOENT' });
    assert.match(await fs.readFile(path.join(root, 'analysis-report.md'), 'utf8'), /actions\/runs\/123/);
  });
}
