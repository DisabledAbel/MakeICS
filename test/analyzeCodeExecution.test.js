import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function scan(t, { js = 0, python = 0, provider, dryRun = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'makeics-analysis-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'test', 'bin', 'lib']) await fs.mkdir(path.join(root, dir));
  await fs.copyFile(new URL('../scripts/analyze-code.js', import.meta.url), path.join(root, 'scripts/analyze-code.js'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    type: 'module', scripts: { test: `node -e "console.log('JS fixture'); process.exit(${js})"` }
  }));
  await fs.writeFile(path.join(root, 'test/test_clear_repo_url.py'), `print('Python fixture')\nraise SystemExit(${python})\n`);
  await fs.writeFile(path.join(root, 'analysis-report.md'), 'STALE REPORT');
  await fs.writeFile(path.join(root, 'bin/gh'), '#!/bin/sh\nprintf "[]"\n', { mode: 0o755 });
  const preload = path.join(root, 'provider.mjs');
  await fs.writeFile(preload, `globalThis.fetch = async () => {
    ${provider === 'error' ? "throw new Error('Fixture provider outage')" : "return { ok: true, json: async () => ({ choices: [{ message: { content: '# Evidence-based AI report' } }] }) }"}
  };`);
  const summary = path.join(root, 'summary.md');
  const result = spawnSync(process.execPath,
    ['--import', preload, 'scripts/analyze-code.js', ...(dryRun ? ['--dry-run'] : [])], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        OPENROUTER_API_KEY: provider ? 'fixture-key' : '', GH_TOKEN: '', GITHUB_TOKEN: '',
        GITHUB_STEP_SUMMARY: summary }
    });
  assert.ifError(result.error);
  return { root, result, summary: await fs.readFile(summary, 'utf8') };
}

test('successful suites remove stale reports, save logs, and succeed', async (t) => {
  const { root, result, summary } = await scan(t);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(fs.access(path.join(root, 'analysis-report.md')), { code: 'ENOENT' });
  assert.match(await fs.readFile(path.join(root, 'analysis-logs/javascript.log'), 'utf8'), /JS fixture/);
  assert.match(await fs.readFile(path.join(root, 'analysis-logs/python.log'), 'utf8'), /Python fixture/);
  assert.match(summary, /JavaScript \| Passed/);
  assert.match(summary, /Python \| Passed/);
});

for (const [suite, options] of [['JavaScript', { js: 1 }], ['Python', { python: 1 }]]) {
  test(`${suite} failure without API credentials produces factual diagnostics and fails`, async (t) => {
    const { root, result, summary } = await scan(t, options);
    assert.equal(result.status, 1, result.stderr);
    const report = await fs.readFile(path.join(root, 'analysis-report.md'), 'utf8');
    assert.match(report, /test failure report/);
    assert.match(report, /JS fixture/);
    assert.match(report, /Python fixture/);
    assert.doesNotMatch(report, /MOCK|Example Issue|STALE REPORT/);
    assert.ok(summary.includes(`${suite} | Failed`));
  });
}

for (const provider of ['error', 'success']) {
  test(`provider ${provider} preserves failed exit status and a usable report`, async (t) => {
    const { root, result } = await scan(t, { js: 1, provider });
    assert.equal(result.status, 1, result.stderr);
    const report = await fs.readFile(path.join(root, 'analysis-report.md'), 'utf8');
    assert.match(report, /test failure report/);
    assert.match(report, /\*\*JS Tests\*\*: FAILED/);
    assert.match(report, /\*\*Python Tests\*\*: PASSED/);
    assert.match(report, /JS fixture/);
    assert.match(report, /Python fixture/);
    if (provider === 'success') {
      assert.match(report, /## AI analysis \(unverified\)\n\n# Evidence-based AI report/);
      assert.ok(report.indexOf('**JS Tests**: FAILED') < report.indexOf('## AI analysis'));
    } else {
      assert.doesNotMatch(report, /## AI analysis/);
    }
  });
}

test('dry run skips the provider but still reports test failure accurately', async (t) => {
  const { root, result } = await scan(t, { python: 1, provider: 'success', dryRun: true });
  assert.equal(result.status, 1);
  assert.match(await fs.readFile(path.join(root, 'analysis-report.md'), 'utf8'), /test failure report/);
});
