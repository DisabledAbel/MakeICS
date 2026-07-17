import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(ROOT_DIR, 'analysis-report.md');

// List of target files/directories to scan for analysis (relative to root)
const TARGET_FILES = [
  'server.js',
  'public/app.js'
];

const TARGET_DIRS = [
  'lib',
  'scripts'
];

const IGNORED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.json', '.zip', '.map'];

/**
 * Executes a shell command from the project root.
 * @param {string} command - The command to execute.
 * @param {Object} [env={}] - Environment variables to add or override.
 * @return {{success: boolean, output: string, error?: string}} The command result, including captured output and any error message.
 */
async function runCommand(command, env = {}) {
  try {
    const output = execSync(command, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'] // capture stdout and stderr
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

/**
 * Recursively collects source file paths from a directory.
 * @param {string} dir - The directory path relative to the project root.
 * @param {string[]} [fileList=[]] - The array to which discovered file paths are appended.
 * @return {Promise<string[]>} The accumulated source file paths.
 */
async function findSourceFiles(dir, fileList = []) {
  try {
    const entries = await fs.readdir(path.join(ROOT_DIR, dir), { withFileTypes: true });
    for (const entry of entries) {
      const resPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await findSourceFiles(resPath, fileList);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!IGNORED_EXTENSIONS.includes(ext)) {
          fileList.push(resPath);
        }
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}:`, error.message);
  }
  return fileList;
}

/**
 * Retrieves open GitHub issue context using the GitHub CLI.
 * @returns {string} The issue data returned by GitHub CLI, or a message indicating that issue context is unavailable.
 */
async function getGitHubContext() {
  console.log('Gathering GitHub CLI context...');
  let issues = 'Not Available (GH CLI not authenticated or not installed)';
  try {
    // Check if gh is installed and we are logged in/have access
    const checkGh = execSync('gh auth status', { stdio: 'ignore', encoding: 'utf8' });
    const issuesOutput = execSync('gh issue list --limit 10 --json number,title,state,body', {
      cwd: ROOT_DIR,
      encoding: 'utf8'
    });
    issues = issuesOutput;
  } catch (e) {
    // If gh auth or gh command failed, we fall back to a search or silent ignore
    try {
      const repo = process.env.GITHUB_REPOSITORY || 'DisabledAbel/MakeICS';
      // Try searching issues if repository has public visibility or token is passed
      const searchOutput = execSync(`gh search issues --repo ${repo} --state open --limit 10 --json number,title,body`, {
        cwd: ROOT_DIR,
        encoding: 'utf8'
      });
      issues = searchOutput;
    } catch (err) {
      console.log('GitHub CLI is not fully configured, skipping GitHub issue list integration.');
    }
  }
  return issues;
}

/**
 * Runs the codebase tests and analysis workflow, then writes a mock or OpenRouter-generated report.
 */
async function main() {
  console.log('=== Starting Codebase Scan and AI Analysis ===');

  // 1. Run JS unit tests
  console.log('Running JS unit tests...');
  const jsTestResult = await runCommand('npm test');
  console.log(`JS Tests: ${jsTestResult.success ? 'PASSED' : 'FAILED'}`);

  // 2. Run Python unit tests
  console.log('Running Python unit tests...');
  const pyTestResult = await runCommand('PYTHONPATH=. python3 test/test_clear_repo_url.py');
  console.log(`Python Tests: ${pyTestResult.success ? 'PASSED' : 'FAILED'}`);

  // 3. Find and read source files
  console.log('Scanning codebase source files...');
  const filesToScan = [...TARGET_FILES];
  for (const dir of TARGET_DIRS) {
    await findSourceFiles(dir, filesToScan);
  }

  console.log(`Found ${filesToScan.length} source files to analyze.`);

  const codeContents = [];
  for (const file of filesToScan) {
    try {
      const fullPath = path.join(ROOT_DIR, file);
      const content = await fs.readFile(fullPath, 'utf8');
      codeContents.push({
        path: file,
        content: content
      });
    } catch (err) {
      console.error(`Could not read file ${file}:`, err.message);
    }
  }

  // 4. Gather GitHub issue list context
  const ghIssues = await getGitHubContext();

  // 5. Construct analysis payload
  const prompt = `You are a world-class senior QA and software engineer.
Analyze the provided codebase, the unit test execution outputs, and the existing issues list context.
Your goal is to identify existing bugs, code errors, edge-case vulnerabilities, performance bottlenecks, unhandled promise rejections, security flaws, and code style nitpicks.

Then, generate a comprehensive analysis report in Markdown format. The report MUST include:
1. **Executive Summary**: A high-level overview of the health of the repository, including active test statuses.
2. **Discovered Issues**: Grouped clearly (e.g. Critical Bugs, Logic Errors, Performance Issues, Style & Nitpicks). For each issue, specify the file name, line range (if applicable), description of the bug/nitpick, and why it is an issue.
3. **Copy-and-Paste Prompt for Coding Agent**: Provide a prominent, standalone, and extremely clear copy-and-pasteable instructions prompt designed to be fed into a coding agent (such as an LLM developer) so it can autonomously fix all the issues you discovered in the codebase. This prompt should be placed inside a clean bash markdown code block (using \`\`\`bash) so the user can easily copy and paste the entire block to their coding agent with one click. It must specify exact file names, line ranges, expected behavior, and step-by-step instructions.

Here is the codebase context:

### JS Unit Test Output (Success: ${jsTestResult.success})
\`\`\`
${[jsTestResult.output, jsTestResult.error].filter(Boolean).join('\n') || 'No JS test output'}
\`\`\`

### Python Unit Test Output (Success: ${pyTestResult.success})
\`\`\`
${[pyTestResult.output, pyTestResult.error].filter(Boolean).join('\n') || 'No Python test output'}
\`\`\`

### GitHub CLI Issues Context
\`\`\`json
${ghIssues}
\`\`\`

### Source Files Content
${codeContents.map(file => `
--- START FILE: ${file.path} ---
${file.content}
--- END FILE: ${file.path} ---
`).join('\n')}
`;

  // 6. Check OpenRouter API Key
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || process.argv.includes('--dry-run')) {
    console.log('No OPENROUTER_API_KEY found or --dry-run specified. Generating a mock analysis report...');
    const mockReport = `# MakeICS Codebase Analysis Report (MOCK / DRY-RUN)

Generated on: ${new Date().toUTCString()}

## 1. Executive Summary
This is a dry-run/mock report since no \`OPENROUTER_API_KEY\` was provided or \`--dry-run\` was active.
- **JS Tests**: ${jsTestResult.success ? 'PASSED' : 'FAILED'}
- **Python Tests**: ${pyTestResult.success ? 'PASSED' : 'FAILED'}
- **Files Scanned**: ${filesToScan.length} files

## 2. Discovered Issues
### Logic & Nitpicks
- **Example Issue**: Verify all async handlers in \`server.js\` have try-catch blocks.
- **Style Nitpick**: Ensure trailing semicolons are consistent across files.

## 3. Copy-and-Paste Prompt for Coding Agent
\`\`\`bash
# You are a software engineer agent. Please review the codebase and implement the following fixes:
# 1. In server.js, make sure all routes are protected with appropriate error handling.
# 2. Check that all test files pass successfully.
\`\`\`
`;
    await fs.writeFile(REPORT_PATH, mockReport, 'utf8');
    console.log(`Mock report written to ${REPORT_PATH}`);
    return;
  }

  console.log('Sending data to OpenRouter (cohere/north-mini-code:free)...');
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/DisabledAbel/MakeICS',
        'X-Title': 'MakeICS Codebase Analyzer'
      },
      body: JSON.stringify({
        model: 'cohere/north-mini-code:free',
        messages: [
          {
            role: 'system',
            content: 'You are a senior software engineer assistant. Output only raw markdown analysis report with executive summary, discovered issues list, and a prompt for a coding agent. Do not wrap the entire output in a markdown block, just output the markdown content directly.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter API responded with HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content;
    if (!resultText) {
      throw new Error('Received empty or invalid completion from OpenRouter API.');
    }

    await fs.writeFile(REPORT_PATH, resultText, 'utf8');
    console.log(`Success! Analysis report written to ${REPORT_PATH}`);
  } catch (err) {
    console.error('Failed to complete OpenRouter analysis:', err.message);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error in analyzer script:', error);
  process.exit(1);
});
