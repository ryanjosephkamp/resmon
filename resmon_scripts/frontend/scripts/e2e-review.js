#!/usr/bin/env node
/**
 * `npm run e2e:review` — one directory a person can read on a phone.
 *
 * The end-to-end suite already launches the real app and prints what it saw.
 * This runs it on **this machine's real display** (so the window-manager specs
 * actually run, which they cannot under xvfb), collects the screenshots and
 * every evidence line the specs printed, and writes a single Markdown summary
 * next to them.
 *
 * **It writes outside the repository.** The output goes under the OS temp
 * directory by default, or wherever `RESMON_E2E_REVIEW_DIR` points. Screenshots
 * used to be committed — 18 of them — and every stacked branch conflicted on
 * them, because two branches that both run the suite both rewrite every file. A
 * committed screenshot is a merge conflict, not evidence. `git status` is clean
 * after a review run, and that is asserted by the suite's own P14 check.
 *
 * Exit code is the suite's, so this is usable in an ordinary `&&` chain.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FRONTEND = path.resolve(__dirname, '..');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

const outDir = path.resolve(
  process.env.RESMON_E2E_REVIEW_DIR
  || path.join(os.tmpdir(), 'resmon-e2e-review', stamp()),
);
const shotDir = path.join(outDir, 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const logPath = path.join(outDir, 'run.log');
console.log(`e2e review → ${outDir}`);

const run = spawnSync(
  'npx',
  ['playwright', 'test', '--config', 'e2e/playwright.config.ts', '--reporter', 'list'],
  {
    cwd: FRONTEND,
    env: {
      ...process.env,
      RESMON_E2E_SCREENSHOT_DIR: shotDir,
      // Playwright colours its list reporter; the log is meant to be read as
      // text, on a phone, by someone who did not run it.
      FORCE_COLOR: '0',
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);

const output = `${run.stdout || ''}${run.stderr || ''}`;
process.stdout.write(output);
fs.writeFileSync(logPath, output, 'utf8');

/**
 * The lines the specs print on purpose.
 *
 * Every spec in `e2e/` logs its evidence with a stable prefix — `P2 …`,
 * `P13a MONITOR …`, `WM …`, `Q6 …`. Those are the sentences a reviewer wants;
 * the rest of the output is Playwright's own bookkeeping.
 */
const EVIDENCE = /^(P\d+[a-z]?\b|Q\d[a-z]?\b|WM\b|D4\b|5d\b|AI (SETTINGS|CLI)\b|ZERO REASON\b)/;

const lines = output.split('\n');
const evidence = lines.filter((l) => EVIDENCE.test(l.trim()));
const notVerified = lines.filter((l) => /NOT VERIFIED/.test(l));
const results = lines.filter((l) => /^\s+[✓✘\-x]\s+\d+/.test(l));
// The counts Playwright prints at the end, and nothing else. Slicing the last
// N lines caught whatever a spec happened to log last.
const tail = lines
  .filter((l) => /^\s+\d+ (passed|failed|skipped|flaky|interrupted)\b/.test(l))
  .map((l) => l.trim())
  .join('\n') || '(no summary line — the run did not finish)';

const shots = fs.existsSync(shotDir)
  ? fs.readdirSync(shotDir).filter((f) => f.endsWith('.png')).sort()
  : [];

const md = `# resmon UI review — ${new Date().toISOString()}

Ran \`npm run e2e\` on a real display: the real Electron app, its own spawned
backend, a real Chromium. Everything below is what the suite observed, not what
it was told.

**Result**

\`\`\`
${tail}
\`\`\`

${notVerified.length ? `## What this run did NOT verify

${notVerified.map((l) => `- ${l.trim()}`).join('\n')}

These are the arms that need something this machine did not have — a window
manager, a reachable third-party origin, an agent CLI that is not installed, a
packaged build. A run that skipped one says so here rather than passing quietly.
` : '## What this run did NOT verify\n\nNothing was skipped.\n'}
## Screenshots

${shots.length
    ? shots.map((f) => `- \`${f}\` — \`${path.join(shotDir, f)}\``).join('\n')
    : '_none — the suite did not reach a screenshot._'}

## Every test

\`\`\`
${results.join('\n')}
\`\`\`

## Evidence the specs printed

\`\`\`
${evidence.join('\n')}
\`\`\`

Full output: \`${logPath}\`
`;

const mdPath = path.join(outDir, 'review.md');
fs.writeFileSync(mdPath, md, 'utf8');
console.log(`\nreview written → ${mdPath}`);
console.log(`screenshots    → ${shotDir} (${shots.length})`);
process.exit(run.status === null ? 1 : run.status);
