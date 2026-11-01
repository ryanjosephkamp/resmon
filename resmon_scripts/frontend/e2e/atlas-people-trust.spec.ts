/**
 * A person's page on Atlas, opened on a database that already had matches.
 *
 * `test_trust_corrections.py` writes rows the way an older resmon left them
 * and rows from the current matcher, before the app starts. The page has to
 * show every match, say which ones were made under an older policy and were
 * not checked again, show the evidence a person must see (an ambiguous
 * single-token name, a conflicting ORCID) on its own row, say what has been
 * checked for retractions before there is any finding, and change nothing it
 * reads.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, ATLAS_LANDMARK, atlasEnv, launchEnv } from './fixtures/resmon-app';

async function engine<T>(win: Page, route: string): Promise<T> {
  return win.evaluate(async (r) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`);
    if (!response.ok) throw new Error(`${r} answered HTTP ${response.status}`);
    return response.json();
  }, route) as Promise<T>;
}

test('a person seeded before startup: every match, the historical ones said so, the evidence on its row, and the check before any finding', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-trust-'));
  const env = atlasEnv(launchEnv(stateDir, true));
  execFileSync(env.RESMON_PYTHON, [path.resolve(FRONTEND_ROOT, '../verification_scripts/test_trust_corrections.py'), env.RESMON_DB_PATH], { env });
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`], cwd: FRONTEND_ROOT, env, timeout: 180_000 });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.locator(ATLAS_LANDMARK).waitFor({ state: 'visible', timeout: 60_000 });
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    expect(port).not.toBe('8742');
    const served = await engine<{ total: number }>(win, '/api/profiles/1/matches');
    expect(served.total).toBe(7);

    await win.evaluate(() => { window.location.hash = '#/watches/people/1'; });
    const matches = win.locator('li.match');
    await expect(matches).toHaveCount(7, { timeout: 30_000 });
    await expect(win.locator('li.match .match-evidence', { hasText: 'Historical match: not rechecked under the current matching policy.' }))
      .toHaveCount(3);
    for (const [title, evidence] of [['Ambiguous candidate', 'ambiguous single-token name'], ['Conflicting identifier', 'conflicting ORCID']]) {
      const row = matches.filter({ hasText: title });
      await expect(row).toHaveAttribute('data-basis', 'name_only');
      await expect(row.locator('.match-evidence')).toContainText(evidence);
      await expect(row.locator('.match-evidence')).not.toContainText('Historical match');
    }

    // What has been checked for retractions is said before there is any finding.
    const lifecycle = await engine<{ coverage_note: string; findings: unknown[]; matched_documents: number }>(win, '/api/profiles/1/lifecycle');
    expect(lifecycle.findings).toHaveLength(0);
    const coverage = win.locator('[data-people="lifecycle-coverage"]');
    await expect(coverage).toHaveText(lifecycle.matched_documents === 0
      ? 'No papers are matched to them yet, so there is nothing to check.'
      : new RegExp(`^${lifecycle.coverage_note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), { timeout: 30_000 });
    await expect(win.locator('[data-people="lifecycle-none"]')).toBeVisible();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-people-trust.png'), fullPage: true });

    expect(await engine(win, '/api/profiles/1/matches'), 'reading the page changed the matches').toEqual(served);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
