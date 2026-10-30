import * as fs from 'fs';
import * as path from 'path';
import { buildWords, COPYRIGHT, ISSUES_URL, LICENSE_TEXT, UPDATE_CHECK, versionWords } from '../aboutFacts';

const REPO = path.resolve(__dirname, '../../../../../../..');
const FRONTEND = path.join(REPO, 'resmon_scripts', 'frontend');

describe('what About resmon says is what the repository and the shell do', () => {
  test('the license is the repository\'s, word for word, with its own copyright line', () => {
    expect(LICENSE_TEXT).toBe(fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8'));
    expect(COPYRIGHT).toBe('Copyright (c) 2026 Ryan Kamp');
  });

  test('the issues page is the repository updates are published from', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package.json'), 'utf8')) as {
      build: { publish: { provider: string; owner: string; repo: string }[] };
    };
    const [feed] = pkg.build.publish;
    expect(feed.provider).toBe('github');
    expect(ISSUES_URL).toBe(`https://github.com/${feed.owner}/${feed.repo}/issues`);
  });

  test('the update check is as soon, as often, and on the platforms the page says', () => {
    const main = fs.readFileSync(path.join(FRONTEND, 'electron', 'main.ts'), 'utf8');
    const start = main.indexOf('function initAutoUpdater');
    expect(start).toBeGreaterThan(-1);
    const updater = main.slice(start, main.indexOf('\n}\n', start));
    expect(updater).toContain(`setTimeout(check, ${UPDATE_CHECK.firstAfterSeconds}_000)`);
    expect(updater).toContain(`setInterval(check, ${UPDATE_CHECK.everyHours} * 60 * 60 * 1000)`);
    expect(updater).toContain("if (process.platform !== 'win32' && process.platform !== 'linux') return;");
    expect(updater).toContain('if (!app.isPackaged) return;');
  });
});

describe('the version and the build, as the engine reports them', () => {
  const identity = { contract_version: 1, runtime_id: 'r', schema_version: 21, corpus_id: null, build_id: null };

  test('the engine\'s version, or why there is none', () => {
    expect(versionWords({ version: '2.3.0' }, null)).toBe('resmon 2.3.0');
    expect(versionWords(undefined, new Error('Failed to fetch'))).toBe('Not known: the engine did not answer (Failed to fetch).');
    expect(versionWords(undefined, null)).toBe('Asking the engine.');
  });

  test('a build the engine does not identify is said to be unidentified, never guessed', () => {
    expect(buildWords(undefined)).toBeNull();
    expect(buildWords({ identity })).toBe('Not identified. The engine reports no build id, so none is named here.');
    expect(buildWords({ identity: { ...identity, build_id: 'abc123' } })).toBe('abc123');
  });
});
