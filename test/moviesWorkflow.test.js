import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'fetch-movies.yml');

let yamlText;

test.before(async () => {
  yamlText = await fs.readFile(WORKFLOW_PATH, 'utf8');
});

function extractStepBlock(text, stepName) {
  const startMarker = `- name: ${stepName}`;
  const startIdx = text.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `Step "${stepName}" not found in workflow file`);
  const rest = text.slice(startIdx + startMarker.length);
  const nextStepIdx = rest.indexOf('\n      - name:');
  return nextStepIdx === -1 ? rest : rest.slice(0, nextStepIdx);
}

test('fetch-movies workflow file has expected top-level name and triggers', () => {
  assert.match(yamlText, /^name: Fetch Movie Release Calendar/m);
  assert.match(yamlText, /schedule:\s*\n\s*- cron: '0 5 \* \* \*'/);
  assert.match(yamlText, /workflow_dispatch:/);
});

test('fetch-movies workflow uses PAT_TOKEN and fetch-depth: 0 in Checkout step', () => {
  const block = extractStepBlock(yamlText, 'Checkout');

  assert.match(block, /uses:\s*actions\/checkout@v4/);
  assert.match(block, /token:\s*\$\{\{\s*secrets\.PAT_TOKEN\s*\}\}/);
  assert.match(block, /fetch-depth:\s*0/);
});

test('fetch-movies workflow sets up Node.js with npm cache', () => {
  const block = extractStepBlock(yamlText, 'Setup Node.js');

  assert.match(block, /uses:\s*actions\/setup-node@v4/);
  assert.match(block, /node-version:\s*'20'/);
  assert.match(block, /cache:\s*npm/);
});

test('fetch-movies workflow caches Playwright browsers and installs Chromium', () => {
  const cacheBlock = extractStepBlock(yamlText, 'Cache Playwright browsers');
  assert.match(cacheBlock, /uses:\s*actions\/cache@v4/);

  const installBlock = extractStepBlock(yamlText, 'Install Playwright Browsers');
  assert.match(installBlock, /run:\s*npx playwright install chromium --with-deps/);
});

test('fetch-movies workflow runs fetch-movies.js script', () => {
  const block = extractStepBlock(yamlText, 'Fetch Movies');
  assert.match(block, /run:\s*node scripts\/fetch-movies\.js/);
});

test('fetch-movies workflow uses REF_NAME and origin "$REF_NAME" for rebase and push', () => {
  const block = extractStepBlock(yamlText, 'Commit and push changes');

  assert.match(block, /REF_NAME:\s*\$\{\{\s*github\.ref_name\s*\}\}/);
  assert.match(block, /git pull --rebase origin "\$REF_NAME"/);
  assert.match(block, /git push origin HEAD:"\$REF_NAME"/);
});
