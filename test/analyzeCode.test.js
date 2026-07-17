import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// NOTE: scripts/analyze-code.js unconditionally invokes `main()` at import time
// (mirroring the existing convention in scripts/google-verify.js), and that
// main() shells out to `npm test` / `python3` / `gh` / the OpenRouter API and
// writes analysis-report.md to disk. Importing it directly here would trigger
// a live scan (and, worse, a recursive `npm test` invocation from inside our
// own test run). So, consistent with test/googleVerify.test.js, we replicate
// the pure logic under test locally and exercise it directly.

const IGNORED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.json', '.zip', '.map'];

function isIgnoredExtension(filename) {
  return IGNORED_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

// Mirrors findSourceFiles() from scripts/analyze-code.js
async function findSourceFiles(rootDir, dir, fileList = []) {
  try {
    const entries = await fs.readdir(path.join(rootDir, dir), { withFileTypes: true });
    for (const entry of entries) {
      const resPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await findSourceFiles(rootDir, resPath, fileList);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!IGNORED_EXTENSIONS.includes(ext)) {
          fileList.push(resPath);
        }
      }
    }
  } catch (error) {
    // Silently ignored, matching original behavior (logs via console.error)
  }
  return fileList;
}

// Mirrors runCommand() from scripts/analyze-code.js
async function runCommand(command, env = {}) {
  const { execSync } = await import('node:child_process');
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { success: true, output };
  } catch (error) {
    return {
      success: false,
      output: error.stdout || '',
      error: error.stderr || error.message
    };
  }
}

// Mirrors the try/catch fallback control flow of getGitHubContext(), but with
// an injectable exec function so we can test the branches without a real `gh` CLI.
function getGitHubContext(execFn) {
  let issues = 'Not Available (GH CLI not authenticated or not installed)';
  try {
    execFn('gh auth status');
    const issuesOutput = execFn('gh issue list --limit 10 --json number,title,state,body');
    issues = issuesOutput;
  } catch (e) {
    try {
      const repo = process.env.GITHUB_REPOSITORY || 'DisabledAbel/MakeICS';
      const searchOutput = execFn(`gh search issues --repo ${repo} --state open --limit 10 --json number,title,body`);
      issues = searchOutput;
    } catch (err) {
      // swallow, matching original behavior
    }
  }
  return issues;
}

// Mirrors the mock report template built in main() when no OPENROUTER_API_KEY
// / --dry-run is active.
function buildMockReport({ jsSuccess, pySuccess, filesScanned }) {
  return `# MakeICS Codebase Analysis Report (MOCK / DRY-RUN)

Generated on: ${new Date().toUTCString()}

## 1. Executive Summary
This is a dry-run/mock report since no \`OPENROUTER_API_KEY\` was provided or \`--dry-run\` was active.
- **JS Tests**: ${jsSuccess ? 'PASSED' : 'FAILED'}
- **Python Tests**: ${pySuccess ? 'PASSED' : 'FAILED'}
- **Files Scanned**: ${filesScanned} files

## 2. Discovered Issues
### Logic & Nitpicks
- **Example Issue**: Verify all async handlers in \`server.js\` have try-catch blocks.
- **Style Nitpick**: Ensure trailing semicolons are consistent across files.

## 3. Structured Coding Agent Prompt
\`\`\`bash
# You are a software engineer agent. Please review the codebase and implement the following fixes:
# 1. In server.js, make sure all routes are protected with appropriate error handling.
# 2. Check that all test files pass successfully.
\`\`\`
`;
}

// Mirrors the "### JS Unit Test Output" / "### Python Unit Test Output"
// fallback-or-join logic used when constructing the OpenRouter prompt.
function joinOutputOrFallback(output, error, fallback) {
  return [output, error].filter(Boolean).join('\n') || fallback;
}

// Mirrors the codeContents.map(...).join('\n') file-wrapping logic used when
// constructing the OpenRouter prompt's "### Source Files Content" section.
function wrapSourceFiles(codeContents) {
  return codeContents.map(file => `
--- START FILE: ${file.path} ---
${file.content}
--- END FILE: ${file.path} ---
`).join('\n');
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'analyze-code-test-'));
}

// --- IGNORED_EXTENSIONS / extension filtering -----------------------------

test('isIgnoredExtension flags all extensions in IGNORED_EXTENSIONS, case-insensitively', () => {
  for (const ext of IGNORED_EXTENSIONS) {
    assert.equal(isIgnoredExtension(`file${ext}`), true, `expected ${ext} to be ignored`);
    assert.equal(isIgnoredExtension(`file${ext.toUpperCase()}`), true, `expected ${ext.toUpperCase()} to be ignored`);
  }
});

test('isIgnoredExtension allows non-ignored extensions', () => {
  for (const ext of ['.js', '.py', '.ts', '.md', '.mjs']) {
    assert.equal(isIgnoredExtension(`file${ext}`), false, `expected ${ext} not to be ignored`);
  }
});

// --- findSourceFiles --------------------------------------------------------

test('findSourceFiles recursively collects non-ignored files and skips ignored ones', async (t) => {
  const tmpRoot = await makeTempDir();
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(tmpRoot, 'scripts', 'nested'), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, 'scripts', 'a.js'), 'console.log("a")');
  await fs.writeFile(path.join(tmpRoot, 'scripts', 'b.json'), '{}');
  await fs.writeFile(path.join(tmpRoot, 'scripts', 'nested', 'c.py'), 'print("c")');
  await fs.writeFile(path.join(tmpRoot, 'scripts', 'nested', 'd.png'), 'binary');

  const result = await findSourceFiles(tmpRoot, 'scripts', []);

  assert.deepEqual(result.sort(), [
    path.join('scripts', 'a.js'),
    path.join('scripts', 'nested', 'c.py')
  ].sort());
});

test('findSourceFiles returns an empty list and does not throw for a missing directory', async (t) => {
  const tmpRoot = await makeTempDir();
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  const result = await findSourceFiles(tmpRoot, 'does-not-exist', []);

  assert.deepEqual(result, []);
});

test('findSourceFiles appends to an existing fileList rather than replacing it', async (t) => {
  const tmpRoot = await makeTempDir();
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(tmpRoot, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, 'lib', 'x.js'), 'module.exports = {}');

  const seed = ['server.js', 'public/app.js'];
  const result = await findSourceFiles(tmpRoot, 'lib', seed);

  assert.equal(result, seed);
  assert.deepEqual(result, ['server.js', 'public/app.js', path.join('lib', 'x.js')]);
});

// --- runCommand --------------------------------------------------------------

test('runCommand returns success:true with captured stdout on success', async () => {
  const result = await runCommand('node -e "console.log(\'hello-world\')"');

  assert.equal(result.success, true);
  assert.ok(result.output.includes('hello-world'));
});

test('runCommand returns success:false with captured stderr on failure', async () => {
  const result = await runCommand('node -e "console.error(\'boom\'); process.exit(1)"');

  assert.equal(result.success, false);
  assert.ok(result.error.includes('boom'));
});

test('runCommand passes through custom env variables to the child process', async () => {
  const result = await runCommand('node -e "console.log(process.env.MY_TEST_VAR)"', { MY_TEST_VAR: 'abc123' });

  assert.equal(result.success, true);
  assert.ok(result.output.includes('abc123'));
});

// --- getGitHubContext control flow -----------------------------------------

test('getGitHubContext returns issue list output when gh auth and gh issue list both succeed', () => {
  const execFn = (command) => {
    if (command === 'gh auth status') return '';
    if (command.startsWith('gh issue list')) return '[{"number":1,"title":"Bug"}]';
    throw new Error(`unexpected command: ${command}`);
  };

  const result = getGitHubContext(execFn);

  assert.equal(result, '[{"number":1,"title":"Bug"}]');
});

test('getGitHubContext falls back to gh search issues when gh auth/issue list fails', (t) => {
  const originalRepo = process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_REPOSITORY;
  t.after(() => {
    if (originalRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepo;
  });

  let searchCommand = null;
  const execFn = (command) => {
    if (command === 'gh auth status') throw new Error('not authenticated');
    if (command.startsWith('gh search issues')) {
      searchCommand = command;
      return '[{"number":2,"title":"Found via search"}]';
    }
    throw new Error(`unexpected command: ${command}`);
  };

  const result = getGitHubContext(execFn);

  assert.equal(result, '[{"number":2,"title":"Found via search"}]');
  assert.ok(searchCommand.includes('--repo DisabledAbel/MakeICS'));
});

test('getGitHubContext uses GITHUB_REPOSITORY env var for the search fallback when set', (t) => {
  const originalRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = 'someorg/somerepo';
  t.after(() => {
    if (originalRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepo;
  });

  let searchCommand = null;
  const execFn = (command) => {
    if (command === 'gh auth status') throw new Error('not authenticated');
    searchCommand = command;
    return '[]';
  };

  getGitHubContext(execFn);

  assert.ok(searchCommand.includes('--repo someorg/somerepo'));
});

test('getGitHubContext returns default unavailable message when both gh calls fail', () => {
  const execFn = () => {
    throw new Error('gh not installed');
  };

  const result = getGitHubContext(execFn);

  assert.equal(result, 'Not Available (GH CLI not authenticated or not installed)');
});

// --- mock analysis report template -----------------------------------------

test('buildMockReport reflects PASSED/FAILED test statuses and file count', () => {
  const report = buildMockReport({ jsSuccess: true, pySuccess: false, filesScanned: 7 });

  assert.ok(report.includes('MOCK / DRY-RUN'));
  assert.ok(report.includes('**JS Tests**: PASSED'));
  assert.ok(report.includes('**Python Tests**: FAILED'));
  assert.ok(report.includes('**Files Scanned**: 7 files'));
});

test('buildMockReport includes all required report sections', () => {
  const report = buildMockReport({ jsSuccess: true, pySuccess: true, filesScanned: 0 });

  assert.ok(report.includes('## 1. Executive Summary'));
  assert.ok(report.includes('## 2. Discovered Issues'));
  assert.ok(report.includes('## 3. Structured Coding Agent Prompt'));
});

// --- prompt construction helpers ---------------------------------------------

test('joinOutputOrFallback joins non-empty output and error with a newline', () => {
  const result = joinOutputOrFallback('some stdout', 'some stderr', 'No JS test output');

  assert.equal(result, 'some stdout\nsome stderr');
});

test('joinOutputOrFallback returns the fallback string when both output and error are empty', () => {
  const result = joinOutputOrFallback('', '', 'No JS test output');

  assert.equal(result, 'No JS test output');
});

test('joinOutputOrFallback returns just the output when error is empty', () => {
  const result = joinOutputOrFallback('only stdout', '', 'No JS test output');

  assert.equal(result, 'only stdout');
});

test('wrapSourceFiles wraps each file with START/END markers containing its path and content', () => {
  const wrapped = wrapSourceFiles([
    { path: 'server.js', content: 'console.log(1);' },
    { path: 'lib/utils.js', content: 'export const x = 1;' }
  ]);

  assert.ok(wrapped.includes('--- START FILE: server.js ---'));
  assert.ok(wrapped.includes('console.log(1);'));
  assert.ok(wrapped.includes('--- END FILE: server.js ---'));
  assert.ok(wrapped.includes('--- START FILE: lib/utils.js ---'));
  assert.ok(wrapped.includes('export const x = 1;'));
  assert.ok(wrapped.includes('--- END FILE: lib/utils.js ---'));

  const serverStart = wrapped.indexOf('--- START FILE: server.js ---');
  const utilsStart = wrapped.indexOf('--- START FILE: lib/utils.js ---');
  assert.ok(serverStart < utilsStart, 'files should appear in the order provided');
});

test('wrapSourceFiles returns an empty string for an empty file list', () => {
  const wrapped = wrapSourceFiles([]);

  assert.equal(wrapped, '');
});