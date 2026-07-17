import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'unit-tests-analysis.yml');

let yamlText;

test.before(async () => {
  yamlText = await fs.readFile(WORKFLOW_PATH, 'utf8');
});

// Extracts the raw text block for a step, from its "- name: <name>" line up to
// (but not including) the next step or the end of the file. This lets tests
// assert on step-specific content without needing a YAML parser dependency.
function extractStepBlock(text, stepName) {
  const startMarker = `- name: ${stepName}`;
  const startIdx = text.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `Step "${stepName}" not found in workflow file`);
  const rest = text.slice(startIdx + startMarker.length);
  const nextStepIdx = rest.indexOf('\n      - name:');
  return nextStepIdx === -1 ? rest : rest.slice(0, nextStepIdx);
}

test('workflow file has the expected top-level name', () => {
  assert.match(yamlText, /^name: Daily Unit Tests & Bug Scanning Analysis/m);
});

test('workflow is triggered on a daily schedule and manual dispatch', () => {
  assert.match(yamlText, /schedule:\s*\n\s*- cron: '0 12 \* \* \*'/);
  assert.match(yamlText, /workflow_dispatch:/);
});

test('workflow grants contents:write and issues:write permissions', () => {
  const permsSection = yamlText.slice(yamlText.indexOf('permissions:'), yamlText.indexOf('jobs:'));

  assert.match(permsSection, /contents:\s*write/);
  assert.match(permsSection, /issues:\s*write/);
});

test('workflow defines a single analyze-and-report job on ubuntu-latest', () => {
  assert.match(yamlText, /analyze-and-report:\s*\n\s*runs-on:\s*ubuntu-latest/);
});

test('Checkout Code step uses actions/checkout@v4 with full history and no persisted credentials', () => {
  const block = extractStepBlock(yamlText, 'Checkout Code');

  assert.match(block, /uses:\s*actions\/checkout@v4/);
  assert.match(block, /fetch-depth:\s*0/);
  assert.match(block, /persist-credentials:\s*false/);
});

test('Setup Node.js step uses actions/setup-node@v4 with Node 20 and npm cache', () => {
  const block = extractStepBlock(yamlText, 'Setup Node.js');

  assert.match(block, /uses:\s*actions\/setup-node@v4/);
  assert.match(block, /node-version:\s*'20'/);
  assert.match(block, /cache:\s*npm/);
});

test('Install dependencies step runs npm ci', () => {
  const block = extractStepBlock(yamlText, 'Install dependencies');

  assert.match(block, /run:\s*npm ci/);
});

test('Install Playwright Browsers step installs chromium with system deps', () => {
  const block = extractStepBlock(yamlText, 'Install Playwright Browsers');

  assert.match(block, /run:\s*npx playwright install chromium --with-deps/);
});

test('Run Scan and OpenRouter Analysis step invokes the analyzer script with required secrets', () => {
  const block = extractStepBlock(yamlText, 'Run Scan and OpenRouter Analysis');

  assert.match(block, /OPENROUTER_API_KEY:\s*\$\{\{\s*secrets\.OPENROUTER_API_KEY\s*\}\}/);
  assert.match(block, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  assert.match(block, /run:\s*node scripts\/analyze-code\.js/);
});

test('Create GitHub Issue with Findings step only runs on success and gates on the report file', () => {
  const block = extractStepBlock(yamlText, 'Create GitHub Issue with Findings');

  assert.match(block, /if:\s*success\(\)/);
  assert.match(block, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  assert.match(block, /if \[ -f "analysis-report\.md" \]; then/);
  assert.match(block, /else\s*\n\s*echo "No analysis report file found to generate an issue\."/);
});

test('Create GitHub Issue with Findings step creates an issue with the bug and documentation labels', () => {
  const block = extractStepBlock(yamlText, 'Create GitHub Issue with Findings');

  assert.match(block, /gh issue create/);
  assert.match(block, /--body-file analysis-report\.md/);
  assert.match(block, /--label "bug"/);
  assert.match(block, /--label "documentation"/);
});

test('workflow steps appear in the expected execution order', () => {
  const stepNames = [
    'Checkout Code',
    'Setup Node.js',
    'Install dependencies',
    'Install Playwright Browsers',
    'Run Scan and OpenRouter Analysis',
    'Create GitHub Issue with Findings'
  ];

  const indices = stepNames.map((name) => yamlText.indexOf(`- name: ${name}`));

  for (const idx of indices) {
    assert.notEqual(idx, -1);
  }
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], `expected "${stepNames[i]}" to appear after "${stepNames[i - 1]}"`);
  }
});